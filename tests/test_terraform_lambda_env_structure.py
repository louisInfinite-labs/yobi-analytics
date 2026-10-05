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
# The API Lambda's environment: the last applied values (4c0e3c8) stay exactly as they are; the SEC-API-005 /live-streams
# protection parameters are the only additions and come from Terraform variables (variables.tf), never literals.
API_ENVIRONMENT = {
    "YOBI_ADMIN_API_KEY_SECRET_NAME": '"yobi-analytics/admin-api-key"',
    "YOBI_STORAGE_BACKEND": '"dynamodb"',
    "HOLODEX_SECRET_NAME": '"yobi-analytics/holodex-api-key"',
    "LIVE_STREAMS_REFRESH_WINDOW_SECONDS": "tostring(var.live_streams_refresh_window_seconds)",
    "LIVE_STREAMS_MAX_STALE_SECONDS": "tostring(var.live_streams_max_stale_seconds)",
    "LIVE_STREAMS_COOLDOWN_BASE_SECONDS": "tostring(var.live_streams_cooldown_base_seconds)",
    "LIVE_STREAMS_COOLDOWN_MAX_SECONDS": "tostring(var.live_streams_cooldown_max_seconds)",
    "LIVE_STREAMS_RETRY_ATTEMPTS": "tostring(var.live_streams_retry_attempts)",
    "LIVE_STREAMS_RETRY_BACKOFF_SECONDS": "tostring(var.live_streams_retry_backoff_seconds)",
    "LIVE_STREAMS_REFRESH_DEADLINE_SECONDS": "tostring(var.live_streams_refresh_deadline_seconds)",
}


def _resource_block(source: str, resource_line: str) -> str:
    start = source.index(resource_line)
    next_resource = source.find('\nresource "', start + len(resource_line))
    return source[start : next_resource if next_resource != -1 else len(source)]


def _environment_variables(block: str) -> dict[str, str]:
    """Name -> value expression of every assignment in the block's `variables = {...}` map (comments ignored)."""
    # The map may be wrapped as `merge({ ...literals... }, local.<optional extras>)`: the literal map is what is checked here.
    variables_map = re.search(r"variables\s*=\s*(?:merge\(\s*)?\{(.*?)\n\s*\}", block, re.DOTALL)
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


def test_api_lambda_environment_is_exactly_the_last_applied_one():
    """Same names and literal values as the applied config: no unrelated environment change hides behind the removal."""
    block = _resource_block(LAMBDA_TF, 'resource "aws_lambda_function" "api"')

    assert _environment_variables(block) == API_ENVIRONMENT


def test_writer_lambdas_still_get_the_history_bucket_from_the_single_bucket_resource():
    """The collector, history worker and reducer keep requiring the variable, wired to `aws_s3_bucket.history.id`."""
    for name in WRITER_LAMBDAS:
        block = _resource_block(LAMBDA_TF, f'resource "aws_lambda_function" "{name}"')
        assert _environment_variables(block).get("YOBI_HISTORY_BUCKET") == "aws_s3_bucket.history.id", name
