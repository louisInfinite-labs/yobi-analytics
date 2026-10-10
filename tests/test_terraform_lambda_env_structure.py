"""Static, text-level structural check for terraform/lambda.tf's Lambda environment blocks.

The API Lambda deliberately has NO YOBI_HISTORY_BUCKET: its read paths (video-ranking, subscriber-ranking, Oshi
Status) resolve the fixed bucket through stores.history_bucket, where the variable is only an optional override.
That keeps a deploy of the API from needing any change to its live environment. The three data Lambdas (collector,
history_worker, ranking_reducer) are writers and keep receiving it from the single `aws_s3_bucket.history`
resource, so a writer can never silently fall back to a default bucket.

No `terraform` CLI is available in this environment, so this is a best-effort
textual substitute (substring/slice check against the raw .tf source), not a
substitute for `terraform fmt -check`/`terraform validate` before this is
ever applied -- see tests/test_terraform_execution_lock_structure.py's own
module docstring for the same caveat.
"""

from __future__ import annotations

import pathlib
import re

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
LAMBDA_TF = (REPO_ROOT / "terraform" / "lambda.tf").read_text()

WRITER_LAMBDAS = ("collector", "history_worker", "ranking_reducer")
# The API Lambda's environment as last applied (4c0e3c8): every one of these must stay exactly as it is ...
API_LAST_APPLIED_ENVIRONMENT = {
    "YOBI_ADMIN_API_KEY_SECRET_NAME": '"yobi-analytics/admin-api-key"',
    "YOBI_STORAGE_BACKEND": '"dynamodb"',
    "HOLODEX_SECRET_NAME": '"yobi-analytics/holodex-api-key"',
}
# ... and exactly ONE variable was added on purpose (V1, Item 3): the LOCATOR of the existing YouTube key, so GET /live-streams can classify a
# still-unclassified upcoming Premiere. The value is a secret NAME, never the key; the same name the collector already uses.
YOUTUBE_KEY_LOCATOR = {"YOUTUBE_API_KEY_SECRET_NAME": '"yobi-analytics/youtube-api-key"'}
API_ENVIRONMENT = {**API_LAST_APPLIED_ENVIRONMENT, **YOUTUBE_KEY_LOCATOR}
# The dispatcher builds the reminder schedule through read_api.get_live_streams(), so it needs the same locators/switch as the API Lambda.
DISPATCHER_ENVIRONMENT = {
    "VAPID_CLAIMS_SUB": "var.vapid_claims_sub",
    "VAPID_PRIVATE_KEY_SECRET_NAME": '"yobi-analytics/vapid-private-key"',
    "YOBI_STORAGE_BACKEND": '"dynamodb"',
    "HOLODEX_SECRET_NAME": '"yobi-analytics/holodex-api-key"',
    "YOUTUBE_API_KEY_SECRET_NAME": '"yobi-analytics/youtube-api-key"',
}
# A variable holding the key VALUE itself (as opposed to a *_SECRET_NAME / *_SSM_PARAMETER locator) must never appear in any Lambda environment.
PLAINTEXT_SECRET_VARIABLES = {"YOUTUBE_API_KEY", "HOLODEX_API_KEY", "YOBI_ADMIN_API_KEY", "VAPID_PRIVATE_KEY"}


def _resource_block(source: str, resource_line: str) -> str:
    start = source.index(resource_line)
    next_resource = source.find('\nresource "', start + len(resource_line))
    return source[start : next_resource if next_resource != -1 else len(source)]


def _environment_variables(block: str) -> dict[str, str]:
    """Name -> value expression of every assignment in the block's `variables = {...}` map (comments ignored)."""
    variables_map = re.search(r"variables\s*=\s*\{(.*?)\n\s*\}", block, re.DOTALL)
    assert variables_map is not None, "no environment variables map found"
    assignments = {}
    for line in variables_map.group(1).splitlines():
        match = re.match(r"^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.+?)\s*$", line)
        if match:
            assignments[match.group(1)] = match.group(2)
    return assignments


def test_api_lambda_does_not_set_the_history_bucket_env_var():
    """The read side falls back to the fixed bucket, so the API Lambda's live environment must not need the variable."""
    block = _resource_block(LAMBDA_TF, 'resource "aws_lambda_function" "api"')

    assert "YOBI_HISTORY_BUCKET" not in _environment_variables(block)


def test_api_lambda_environment_is_the_last_applied_one_plus_only_the_youtube_key_locator():
    """Same names and literal values as the applied config, with exactly one intentional addition: no unrelated drift."""
    block = _resource_block(LAMBDA_TF, 'resource "aws_lambda_function" "api"')
    environment = _environment_variables(block)

    assert environment == API_ENVIRONMENT
    assert {name: environment[name] for name in API_LAST_APPLIED_ENVIRONMENT} == API_LAST_APPLIED_ENVIRONMENT
    assert set(environment) - set(API_LAST_APPLIED_ENVIRONMENT) == set(YOUTUBE_KEY_LOCATOR)


def test_dispatcher_lambda_environment_is_exactly_the_expected_one():
    block = _resource_block(LAMBDA_TF, 'resource "aws_lambda_function" "notification_dispatcher"')

    assert _environment_variables(block) == DISPATCHER_ENVIRONMENT


def test_no_lambda_environment_holds_a_plaintext_api_key():
    """Only locators (secret names / parameter names) are ever in an environment, never a key value."""
    for resource in re.findall(r'resource "aws_lambda_function" "(\w+)"', LAMBDA_TF):
        block = _resource_block(LAMBDA_TF, f'resource "aws_lambda_function" "{resource}"')
        if "environment" not in block:
            continue
        assert not set(_environment_variables(block)) & PLAINTEXT_SECRET_VARIABLES, resource


def test_the_youtube_key_locator_is_the_one_secret_the_collector_already_uses():
    """One canonical key: the API and dispatcher locators equal the collector's and the secret Terraform already references by name."""
    secrets_tf = (REPO_ROOT / "terraform" / "secrets.tf").read_text()
    secret_name = re.search(r'data "aws_secretsmanager_secret" "youtube_api_key" \{\s*name\s*=\s*"([^"]+)"', secrets_tf).group(1)
    locator = '"' + secret_name + '"'
    for resource in ("collector", "api", "notification_dispatcher"):
        block = _resource_block(LAMBDA_TF, f'resource "aws_lambda_function" "{resource}"')
        assert _environment_variables(block)["YOUTUBE_API_KEY_SECRET_NAME"] == locator, resource


def test_the_youtube_key_read_policy_grants_only_get_secret_value_on_that_one_secret():
    import json

    policy = json.loads((REPO_ROOT / "terraform" / "manual-iam" / "policy-lambda-youtube-key-read.json").read_text())
    [statement] = policy["Statement"]

    assert statement["Effect"] == "Allow"
    assert statement["Action"] == ["secretsmanager:GetSecretValue"]
    resource = statement["Resource"]
    assert isinstance(resource, str) and resource.startswith("arn:aws:secretsmanager:ap-northeast-1:") and ":secret:yobi-analytics/youtube-api-key-" in resource
    assert resource.count("*") == 1 and resource.endswith("-*")  # only AWS's random secret-name suffix is a wildcard; no broad read


def test_writer_lambdas_still_get_the_history_bucket_from_the_single_bucket_resource():
    """The collector, history worker and reducer keep requiring the variable, wired to `aws_s3_bucket.history.id`."""
    for name in WRITER_LAMBDAS:
        block = _resource_block(LAMBDA_TF, f'resource "aws_lambda_function" "{name}"')
        assert _environment_variables(block).get("YOBI_HISTORY_BUCKET") == "aws_s3_bucket.history.id", name
