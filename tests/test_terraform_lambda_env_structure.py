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
# Runtime secrets are read from SSM Parameter Store: every consumer's environment carries the parameter NAME (a locals reference), never a value,
# and no Secrets Manager locator any more. The API Lambda has no history-bucket variable on purpose (see above).
SSM_LOCATORS = {
    "YOBI_ADMIN_API_KEY_SSM_PARAMETER": "local.ssm_parameter_names.admin_api_key",
    "HOLODEX_SSM_PARAMETER": "local.ssm_parameter_names.holodex_api_key",
    "YOUTUBE_API_KEY_SSM_PARAMETER": "local.ssm_parameter_names.youtube_api_key",
}
API_ENVIRONMENT = {"YOBI_STORAGE_BACKEND": '"dynamodb"', **SSM_LOCATORS}
# The dispatcher builds the reminder schedule through read_api.get_live_streams(), so it needs the same locators/switch as the API Lambda.
DISPATCHER_ENVIRONMENT = {
    "VAPID_CLAIMS_SUB": "var.vapid_claims_sub",
    "VAPID_PRIVATE_KEY_SSM_PARAMETER": "local.ssm_parameter_names.vapid_private_key",
    "YOBI_STORAGE_BACKEND": '"dynamodb"',
    "HOLODEX_SSM_PARAMETER": "local.ssm_parameter_names.holodex_api_key",
    "YOUTUBE_API_KEY_SSM_PARAMETER": "local.ssm_parameter_names.youtube_api_key",
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


def test_api_lambda_environment_is_exactly_the_expected_one():
    """The storage switch plus the three SSM parameter-name locators: no unrelated drift, no Secrets Manager locator."""
    block = _resource_block(LAMBDA_TF, 'resource "aws_lambda_function" "api"')

    assert _environment_variables(block) == API_ENVIRONMENT


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


def test_no_lambda_environment_has_a_secrets_manager_locator_any_more():
    """Secrets Manager is retired from the runtime: no *_SECRET_NAME variable, and terraform no longer references any secret."""
    for resource in re.findall(r'resource "aws_lambda_function" "(\w+)"', LAMBDA_TF):
        block = _resource_block(LAMBDA_TF, f'resource "aws_lambda_function" "{resource}"')
        if "environment" not in block:
            continue
        assert not [name for name in _environment_variables(block) if name.endswith("_SECRET_NAME")], resource
    assert not (REPO_ROOT / "terraform" / "secrets.tf").exists()
    assert "aws_secretsmanager_secret" not in "".join(path.read_text() for path in (REPO_ROOT / "terraform").glob("*.tf"))


def test_the_ssm_read_policy_grants_only_get_parameter_on_the_four_exact_parameters():
    import json

    policy = json.loads((REPO_ROOT / "terraform" / "manual-iam" / "policy-lambda-ssm-parameter-read.json").read_text())
    [statement] = policy["Statement"]

    assert statement["Effect"] == "Allow"
    assert statement["Action"] == ["ssm:GetParameter"]  # not GetParametersByPath, not ssm:*
    assert sorted(statement["Resource"]) == sorted(
        f"arn:aws:ssm:ap-northeast-1:189461315571:parameter/yobi-analytics/{name}"
        for name in ("youtube-api-key", "holodex-api-key", "vapid-private-key", "admin-api-key")
    )
    assert not any("*" in resource for resource in statement["Resource"])


def test_writer_lambdas_still_get_the_history_bucket_from_the_single_bucket_resource():
    """The collector, history worker and reducer keep requiring the variable, wired to `aws_s3_bucket.history.id`."""
    for name in WRITER_LAMBDAS:
        block = _resource_block(LAMBDA_TF, f'resource "aws_lambda_function" "{name}"')
        assert _environment_variables(block).get("YOBI_HISTORY_BUCKET") == "aws_s3_bucket.history.id", name


def test_every_ssm_locator_is_a_reference_to_one_of_the_four_parameter_names():
    """The locals hold /yobi-analytics/... NAMES (never a value) and every locator in every environment points at one of them."""
    names = dict(re.findall(r'^\s*(\w+_api_key|vapid_private_key)\s*=\s*"(/yobi-analytics/[a-z0-9-]+)"', LAMBDA_TF, re.MULTILINE))
    assert set(names) == {"youtube_api_key", "admin_api_key", "vapid_private_key", "holodex_api_key"}
    for resource in re.findall(r'resource "aws_lambda_function" "(\w+)"', LAMBDA_TF):
        block = _resource_block(LAMBDA_TF, f'resource "aws_lambda_function" "{resource}"')
        if "environment" not in block:
            continue
        for name, expression in _environment_variables(block).items():
            if name.endswith("_SSM_PARAMETER"):
                assert expression.removeprefix("local.ssm_parameter_names.") in names, (resource, name)
