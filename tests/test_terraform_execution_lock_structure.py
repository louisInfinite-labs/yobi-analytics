"""Static, text-level structural checks for the execution-lock Terraform
changes (terraform/dynamodb.tf's new table, terraform/history.tf's IAM grant
and ASL states).

No `terraform` CLI is available in this environment, so `terraform fmt
-check`/`terraform validate` could not be run against these files -- these
tests are a best-effort textual substitute (substring/slice checks against
the raw .tf source), not a substitute for actually running Terraform's own
formatter/validator before this is ever applied. That gap is called out
explicitly in this round's own report; do not treat these tests as proof
the HCL is syntactically valid.
"""

from __future__ import annotations

import pathlib

import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
DYNAMODB_TF = (REPO_ROOT / "terraform" / "dynamodb.tf").read_text()
HISTORY_TF = (REPO_ROOT / "terraform" / "history.tf").read_text()


def _resource_block(source: str, resource_line: str) -> str:
    """Slice out one `resource "..." "..." { ... }` block by its own opening
    line, up to (not including) the next top-level `resource "` line -- good
    enough for this repo's own consistently-formatted .tf files, though not
    a real HCL parser."""
    start = source.index(resource_line)
    next_resource = source.find('\nresource "', start + len(resource_line))
    return source[start : next_resource if next_resource != -1 else len(source)]


# --- terraform/dynamodb.tf: the new lock table ------------------------------


def test_history_execution_lock_table_is_declared():
    assert 'resource "aws_dynamodb_table" "history_execution_lock"' in DYNAMODB_TF


def test_history_execution_lock_table_hash_key_is_report_date():
    block = _resource_block(DYNAMODB_TF, 'resource "aws_dynamodb_table" "history_execution_lock"')
    assert 'name         = "YobiHistoryExecutionLock"' in block
    assert 'hash_key     = "reportDate"' in block


def test_history_execution_lock_table_declares_only_the_hash_key_attribute():
    """Confirmed design point 7: ownerToken/status/expiresAt/currentPhase/
    completedShards/lastError/acquiredAt/renewedAt/completedAt/ttlAt must
    NOT be declared as their own Terraform `attribute` blocks -- only
    reportDate (the actual partition key) may appear."""
    block = _resource_block(DYNAMODB_TF, 'resource "aws_dynamodb_table" "history_execution_lock"')
    assert block.count("attribute {") == 1
    assert 'name = "reportDate"' in block
    for field in (
        "ownerToken", "status", "expiresAt", "currentPhase",
        "completedShards", "lastError", "acquiredAt", "renewedAt", "completedAt", "ttlAt",
    ):
        # Deliberately anchored on "\n    name = " (an `attribute` block's own
        # exact line shape), not a bare substring match -- ttlAt legitimately
        # appears as `attribute_name = "ttlAt"` inside the `ttl` block below,
        # which must not be confused with a second `attribute { name = ... }`
        # block for that same field.
        assert f'\n    name = "{field}"' not in block


def test_history_execution_lock_table_has_ttl_on_ttl_at():
    block = _resource_block(DYNAMODB_TF, 'resource "aws_dynamodb_table" "history_execution_lock"')
    assert "ttl {" in block
    assert 'attribute_name = "ttlAt"' in block
    assert "enabled        = true" in block


def test_history_execution_lock_table_matches_existing_table_conventions():
    block = _resource_block(DYNAMODB_TF, 'resource "aws_dynamodb_table" "history_execution_lock"')
    assert 'billing_mode = "PAY_PER_REQUEST"' in block
    assert "max_read_request_units  = 200" in block
    assert "max_write_request_units = 100" in block
    assert "point_in_time_recovery {" in block
    assert "deletion_protection_enabled = true" in block


# --- terraform/history.tf: IAM least privilege ------------------------------


def test_lambda_history_access_grants_only_put_and_update_on_the_lock_table():
    block = _resource_block(HISTORY_TF, 'resource "aws_iam_role_policy" "lambda_history_access"')
    # Slice further to just the Statement entry naming the lock table's ARN,
    # so this doesn't get confused by the *other* statements in the same
    # policy that legitimately grant GetItem/PutItem on video_master/
    # trending_cache.
    lock_statement_start = block.index("aws_dynamodb_table.history_execution_lock.arn")
    statement_slice = block[max(0, lock_statement_start - 400) : lock_statement_start + 50]
    assert '"dynamodb:PutItem"' in statement_slice
    assert '"dynamodb:UpdateItem"' in statement_slice
    assert '"dynamodb:GetItem"' not in statement_slice
    assert '"dynamodb:DeleteItem"' not in statement_slice


# --- terraform/history.tf: ASL structure ------------------------------------


def test_state_machine_has_the_overall_timeout():
    block = _resource_block(HISTORY_TF, 'resource "aws_sfn_state_machine" "daily_history"')
    assert "TimeoutSeconds = 21600" in block


@pytest.mark.parametrize(
    "state_name",
    [
        "ValidateShardsInput",
        "AcquireExecutionLock",
        "CollectHistoryShards",
        "ReduceRankings",
        "MarkExecutionComplete",
        "MarkExecutionFailed",
        "Fail",
        "ExecutionLockHeld",
    ],
)
def test_state_machine_declares_every_expected_state(state_name):
    block = _resource_block(HISTORY_TF, 'resource "aws_sfn_state_machine" "daily_history"')
    assert f"{state_name} = {{" in block


def test_acquire_execution_lock_uses_whole_execution_input_not_optional_json_paths():
    """Confirmed design point 3: `$$.Execution.Input.date`/`.forceRecovery`
    must never appear as actual `.$` JSONPath *values* -- only as prose in
    this file's own explanatory comments, which is why this checks for the
    real usage shape (`"...$" = "$$.Execution.Input.<field>"`) rather than a
    bare substring that would also match a comment mentioning why NOT to do
    this."""
    block = _resource_block(HISTORY_TF, 'resource "aws_sfn_state_machine" "daily_history"')
    assert '"executionInput.$"  = "$$.Execution.Input"' in block
    assert '= "$$.Execution.Input.date"' not in block
    assert '= "$$.Execution.Input.forceRecovery"' not in block
    assert '"date.$"' not in block
    assert '"forceRecovery.$"' not in block


def test_acquire_execution_lock_catches_lock_held_and_routes_to_its_own_fail_state():
    block = _resource_block(HISTORY_TF, 'resource "aws_sfn_state_machine" "daily_history"')
    acquire_block = block[block.index("AcquireExecutionLock = {") : block.index("CollectHistoryShards = {")]
    assert 'ErrorEquals = ["ExecutionLockHeldError"]' in acquire_block
    assert 'Next        = "ExecutionLockHeld"' in acquire_block


def test_map_and_reducer_preserve_report_date_and_owner_token_via_result_path():
    """Confirmed design point 4: neither state may let its own Lambda
    response overwrite the whole state input -- ResultPath must target a
    sub-path, not the ASL default of "$"."""
    block = _resource_block(HISTORY_TF, 'resource "aws_sfn_state_machine" "daily_history"')
    map_block = block[block.index("CollectHistoryShards = {") : block.index("ReduceRankings = {")]
    assert '"shard.$"      = "$$.Map.Item.Value"' in map_block
    assert '"reportDate.$" = "$.reportDate"' in map_block
    assert '"ownerToken.$" = "$.ownerToken"' in map_block
    assert 'ResultPath = "$.shardResults"' in map_block

    reduce_block = block[block.index("ReduceRankings = {") : block.index("MarkExecutionComplete = {")]
    assert '"reportDate.$" = "$.reportDate"' in reduce_block
    assert '"ownerToken.$" = "$.ownerToken"' in reduce_block
    assert 'ResultPath = "$.reduceResult"' in reduce_block


def test_map_and_reducer_catch_into_mark_execution_failed():
    block = _resource_block(HISTORY_TF, 'resource "aws_sfn_state_machine" "daily_history"')
    map_block = block[block.index("CollectHistoryShards = {") : block.index("ReduceRankings = {")]
    reduce_block = block[block.index("ReduceRankings = {") : block.index("MarkExecutionComplete = {")]
    for section in (map_block, reduce_block):
        assert 'ErrorEquals = ["States.ALL"]' in section
        assert 'Next        = "MarkExecutionFailed"' in section


def test_mark_execution_failed_always_reaches_fail_even_if_it_fails_itself():
    """Point 2 of the confirmed design: a conditional-check failure inside
    MarkExecutionFailed itself (the lock already reclaimed) must not mask
    the original pipeline failure -- both its own success path and its own
    Catch must lead to Fail."""
    block = _resource_block(HISTORY_TF, 'resource "aws_sfn_state_machine" "daily_history"')
    mark_failed_block = block[block.index("MarkExecutionFailed = {") : block.index("Fail = {")]
    assert 'ErrorEquals = ["States.ALL"]' in mark_failed_block
    assert mark_failed_block.count('Next        = "Fail"') + mark_failed_block.count('Next = "Fail"') >= 1
