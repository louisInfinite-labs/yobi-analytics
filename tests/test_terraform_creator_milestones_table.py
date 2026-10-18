"""Static, text-level checks that terraform/dynamodb.tf declares the CreatorMilestones table exactly as designed.

One table, partition key creatorId (String), on-demand, no GSI/LSI/TTL, no Lambda/EventBridge/IAM attached, and no existing table touched.
These are a textual substitute for `terraform validate`, not a replacement (same approach as test_terraform_client_credentials_table.py).
"""

from __future__ import annotations

import pathlib

from scripts.migration import seed_creator_milestones_dynamodb as seed

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
DYNAMODB_TF = (REPO_ROOT / "terraform" / "dynamodb.tf").read_text()
_RESOURCE_LINE = 'resource "aws_dynamodb_table" "creator_milestones"'


def _block() -> str:
    """The creator_milestones block, up to the next top-level resource."""
    start = DYNAMODB_TF.index(_RESOURCE_LINE)
    end = DYNAMODB_TF.find('\nresource "', start + len(_RESOURCE_LINE))
    return DYNAMODB_TF[start : end if end != -1 else len(DYNAMODB_TF)]


def _code() -> str:
    """The block without comment lines."""
    return "\n".join(line for line in _block().splitlines() if not line.lstrip().startswith("#"))


def test_table_name_matches_the_seed_script_default():
    """The declared name is the one the seed script writes to."""
    assert 'name         = "YobiCreatorMilestones"' in _block()
    assert seed.CREATOR_MILESTONES_TABLE == "YobiCreatorMilestones"


def test_key_schema_is_creator_id_hash_only_with_no_index_or_ttl():
    """Partition key creatorId (S) only; birthday/debutDate stay undeclared schemaless attributes."""
    code = _code()
    assert 'hash_key     = "creatorId"' in code
    assert code.count("attribute {") == 1
    assert 'name = "creatorId"' in code and 'type = "S"' in code
    for forbidden in ("range_key", "global_secondary_index", "local_secondary_index", "ttl {", "birthday", "debutDate"):
        assert forbidden not in code, forbidden


def test_follows_repo_table_conventions():
    """On-demand billing with the standard throughput cap, PITR and deletion protection like the other tables."""
    block = _block()
    assert 'billing_mode = "PAY_PER_REQUEST"' in block
    assert "max_read_request_units  = 200" in block and "max_write_request_units = 100" in block
    assert "point_in_time_recovery {" in block and "deletion_protection_enabled = true" in block


def test_exactly_one_table_added_and_existing_tables_still_declared():
    """The eleven pre-existing tables are all still declared next to the single new one."""
    existing = [
        "client_credentials", "heartbeat", "history_execution_lock", "notification_delivery_log", "notification_delivery_slots",
        "notification_events", "remote_config", "run_summaries", "snapshots", "video_master", "topic_catalog",
    ]
    for name in existing:
        assert f'resource "aws_dynamodb_table" "{name}"' in DYNAMODB_TF
    assert DYNAMODB_TF.count('resource "aws_dynamodb_table"') == len(existing) + 1


def test_nothing_else_references_the_table():
    """No Lambda, EventBridge rule or IAM file mentions it: it is a data-only table for now."""
    for name in ("lambda.tf", "eventbridge.tf", "iam.tf", "api_gateway.tf"):
        text = (REPO_ROOT / "terraform" / name).read_text()
        assert "creator_milestones" not in text and "YobiCreatorMilestones" not in text, name
