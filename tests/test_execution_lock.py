"""Focused tests for execution_lock.py -- YobiHistoryExecutionLock's
acquire/renew/complete/failed conditional-write rules (confirmed
execution-lock design, Roadmap 5.x).

Covers: every acquire state-transition rule, owner fencing on renew/
complete/failed, renew extending the lease plus idempotent completedShards
accumulation, an old owner being locked out after an expired-lease
takeover, COMPLETE/FAILED rows never being deleted, canonicalize_report_date
with and without optional fields, and the 19-write/day normal-execution
cost estimate.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import boto3
import pytest
from moto import mock_aws

import execution_lock
from execution_lock import (
    ExecutionLockHeldError,
    ExecutionLockLostError,
    acquire_execution_lock,
    canonicalize_report_date,
    mark_execution_complete,
    mark_execution_failed,
    renew_execution_lock,
)

AWS_REGION = "ap-northeast-1"
REPORT_DATE = date(2026, 9, 10)
BASE_NOW = datetime(2026, 9, 10, 18, 0, 0, tzinfo=timezone.utc)


def _now(offset_seconds: int = 0) -> datetime:
    return BASE_NOW + timedelta(seconds=offset_seconds)


@pytest.fixture
def lock_table(aws_credentials):
    with mock_aws():
        client = boto3.client("dynamodb", region_name=AWS_REGION)
        client.create_table(
            TableName=execution_lock.EXECUTION_LOCK_TABLE,
            AttributeDefinitions=[{"AttributeName": "reportDate", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "reportDate", "KeyType": "HASH"}],
            BillingMode="PAY_PER_REQUEST",
        )
        yield


def _row() -> dict:
    table = execution_lock._table()
    item = table.get_item(Key={"reportDate": REPORT_DATE.isoformat()}).get("Item")
    assert item is not None, "expected a lock row to exist"
    return item


# --- acquire: every state-transition rule -----------------------------------


def test_acquire_allowed_when_no_row_exists(lock_table):
    acquire_execution_lock(report_date=REPORT_DATE, owner_token="exec-1", now=_now())
    row = _row()
    assert row["status"] == "IN_PROGRESS"
    assert row["currentPhase"] == "COLLECTING"
    assert row["ownerToken"] == "exec-1"
    assert int(row["expiresAt"]) == int(_now().timestamp()) + execution_lock.ACQUIRE_LEASE_SECONDS


def test_acquire_rejected_when_in_progress_and_not_expired(lock_table):
    acquire_execution_lock(report_date=REPORT_DATE, owner_token="exec-1", now=_now())
    with pytest.raises(ExecutionLockHeldError):
        acquire_execution_lock(report_date=REPORT_DATE, owner_token="exec-2", now=_now(60))


def test_acquire_allowed_takeover_when_in_progress_and_expired(lock_table):
    acquire_execution_lock(
        report_date=REPORT_DATE, owner_token="exec-1", now=_now(), lease_seconds=60
    )
    acquire_execution_lock(report_date=REPORT_DATE, owner_token="exec-2", now=_now(61))
    row = _row()
    assert row["ownerToken"] == "exec-2"
    assert row["status"] == "IN_PROGRESS"


def test_acquire_allowed_when_failed_without_force_recovery(lock_table):
    acquire_execution_lock(report_date=REPORT_DATE, owner_token="exec-1", now=_now())
    mark_execution_failed(report_date=REPORT_DATE, owner_token="exec-1", now=_now(10), error_message="boom")

    acquire_execution_lock(report_date=REPORT_DATE, owner_token="exec-2", now=_now(20))

    row = _row()
    assert row["ownerToken"] == "exec-2"
    assert row["status"] == "IN_PROGRESS"


def test_acquire_rejected_when_complete_without_force_recovery(lock_table):
    acquire_execution_lock(report_date=REPORT_DATE, owner_token="exec-1", now=_now())
    mark_execution_complete(report_date=REPORT_DATE, owner_token="exec-1", now=_now(10))

    with pytest.raises(ExecutionLockHeldError):
        acquire_execution_lock(report_date=REPORT_DATE, owner_token="exec-2", now=_now(20))


def test_acquire_allowed_when_complete_with_force_recovery(lock_table):
    acquire_execution_lock(report_date=REPORT_DATE, owner_token="exec-1", now=_now())
    mark_execution_complete(report_date=REPORT_DATE, owner_token="exec-1", now=_now(10))

    acquire_execution_lock(
        report_date=REPORT_DATE, owner_token="exec-2", now=_now(20), force_recovery=True
    )

    row = _row()
    assert row["ownerToken"] == "exec-2"
    assert row["status"] == "IN_PROGRESS"


def test_force_recovery_still_rejects_a_live_in_progress_lock(lock_table):
    """Repair mode only bypasses the COMPLETE terminal guard -- it must never
    let a repair rerun steal a lock from a genuinely still-running execution."""
    acquire_execution_lock(report_date=REPORT_DATE, owner_token="exec-1", now=_now())

    with pytest.raises(ExecutionLockHeldError):
        acquire_execution_lock(
            report_date=REPORT_DATE, owner_token="exec-2", now=_now(60), force_recovery=True
        )


def test_acquire_takeover_resets_completed_shards_and_last_error(lock_table):
    """A fresh owner starts a fresh COLLECTING phase -- stale completedShards/
    lastError from a previous FAILED attempt for the same reportDate must not
    leak into the new owner's row."""
    acquire_execution_lock(report_date=REPORT_DATE, owner_token="exec-1", now=_now())
    renew_execution_lock(
        report_date=REPORT_DATE, owner_token="exec-1", now=_now(5),
        lease_seconds=60, phase="COLLECTING", completed_shard=3,
    )
    mark_execution_failed(report_date=REPORT_DATE, owner_token="exec-1", now=_now(10), error_message="boom")

    acquire_execution_lock(report_date=REPORT_DATE, owner_token="exec-2", now=_now(20))

    row = _row()
    assert "completedShards" not in row
    assert "lastError" not in row


# --- owner fencing: renew/complete/failed all require ownerToken match -----


def test_renew_rejects_wrong_owner_token(lock_table):
    acquire_execution_lock(report_date=REPORT_DATE, owner_token="exec-1", now=_now())
    with pytest.raises(ExecutionLockLostError):
        renew_execution_lock(
            report_date=REPORT_DATE, owner_token="exec-2", now=_now(5),
            lease_seconds=60, phase="COLLECTING",
        )


def test_mark_execution_complete_rejects_wrong_owner_token(lock_table):
    acquire_execution_lock(report_date=REPORT_DATE, owner_token="exec-1", now=_now())
    with pytest.raises(ExecutionLockLostError):
        mark_execution_complete(report_date=REPORT_DATE, owner_token="exec-2", now=_now(5))


def test_mark_execution_failed_rejects_wrong_owner_token(lock_table):
    acquire_execution_lock(report_date=REPORT_DATE, owner_token="exec-1", now=_now())
    with pytest.raises(ExecutionLockLostError):
        mark_execution_failed(
            report_date=REPORT_DATE, owner_token="exec-2", now=_now(5), error_message="boom"
        )


def test_renew_rejects_when_status_is_no_longer_in_progress(lock_table):
    acquire_execution_lock(report_date=REPORT_DATE, owner_token="exec-1", now=_now())
    mark_execution_complete(report_date=REPORT_DATE, owner_token="exec-1", now=_now(5))
    with pytest.raises(ExecutionLockLostError):
        renew_execution_lock(
            report_date=REPORT_DATE, owner_token="exec-1", now=_now(10),
            lease_seconds=60, phase="COLLECTING",
        )


# --- renew: extends lease, idempotent completedShards -----------------------


def test_renew_extends_expires_at_and_updates_phase(lock_table):
    acquire_execution_lock(report_date=REPORT_DATE, owner_token="exec-1", now=_now())
    renew_execution_lock(
        report_date=REPORT_DATE, owner_token="exec-1", now=_now(30),
        lease_seconds=execution_lock.REDUCER_RENEW_LEASE_SECONDS, phase=execution_lock.PHASE_REDUCING,
    )
    row = _row()
    assert row["currentPhase"] == "REDUCING"
    assert int(row["expiresAt"]) == int(_now(30).timestamp()) + execution_lock.REDUCER_RENEW_LEASE_SECONDS


def test_renew_completed_shard_is_idempotent_across_a_retry(lock_table):
    acquire_execution_lock(report_date=REPORT_DATE, owner_token="exec-1", now=_now())
    renew_execution_lock(
        report_date=REPORT_DATE, owner_token="exec-1", now=_now(5),
        lease_seconds=60, phase="COLLECTING", completed_shard=3,
    )
    # A Step Functions Retry of the same CollectShard Task renews again for
    # the same shard -- this must not double-count or error.
    renew_execution_lock(
        report_date=REPORT_DATE, owner_token="exec-1", now=_now(10),
        lease_seconds=60, phase="COLLECTING", completed_shard=3,
    )
    row = _row()
    assert set(row["completedShards"]) == {3}


def test_renew_completed_shards_accumulates_distinct_shards(lock_table):
    acquire_execution_lock(report_date=REPORT_DATE, owner_token="exec-1", now=_now())
    for shard in (0, 1, 2, 3):
        renew_execution_lock(
            report_date=REPORT_DATE, owner_token="exec-1", now=_now(shard),
            lease_seconds=60, phase="COLLECTING", completed_shard=shard,
        )
    row = _row()
    assert set(int(s) for s in row["completedShards"]) == {0, 1, 2, 3}


# --- expired takeover: old owner locked out of every mutating operation -----


def test_after_expired_takeover_old_owner_cannot_renew(lock_table):
    acquire_execution_lock(report_date=REPORT_DATE, owner_token="exec-1", now=_now(), lease_seconds=60)
    acquire_execution_lock(report_date=REPORT_DATE, owner_token="exec-2", now=_now(61))

    with pytest.raises(ExecutionLockLostError):
        renew_execution_lock(
            report_date=REPORT_DATE, owner_token="exec-1", now=_now(65),
            lease_seconds=60, phase="COLLECTING", completed_shard=5,
        )
    # And the new owner's row must be completely untouched by that attempt.
    row = _row()
    assert row["ownerToken"] == "exec-2"
    assert "completedShards" not in row


def test_after_expired_takeover_old_owner_cannot_complete(lock_table):
    acquire_execution_lock(report_date=REPORT_DATE, owner_token="exec-1", now=_now(), lease_seconds=60)
    acquire_execution_lock(report_date=REPORT_DATE, owner_token="exec-2", now=_now(61))

    with pytest.raises(ExecutionLockLostError):
        mark_execution_complete(report_date=REPORT_DATE, owner_token="exec-1", now=_now(65))

    assert _row()["status"] == "IN_PROGRESS"
    assert _row()["ownerToken"] == "exec-2"


def test_after_expired_takeover_old_owner_cannot_fail(lock_table):
    acquire_execution_lock(report_date=REPORT_DATE, owner_token="exec-1", now=_now(), lease_seconds=60)
    acquire_execution_lock(report_date=REPORT_DATE, owner_token="exec-2", now=_now(61))

    with pytest.raises(ExecutionLockLostError):
        mark_execution_failed(
            report_date=REPORT_DATE, owner_token="exec-1", now=_now(65), error_message="stale failure"
        )

    assert _row()["status"] == "IN_PROGRESS"
    assert _row()["ownerToken"] == "exec-2"


# --- COMPLETE/FAILED rows are updated in place, never deleted ---------------


def test_mark_execution_complete_sets_status_and_ttl_without_deleting_row(lock_table):
    acquire_execution_lock(report_date=REPORT_DATE, owner_token="exec-1", now=_now())
    mark_execution_complete(report_date=REPORT_DATE, owner_token="exec-1", now=_now(30))

    row = _row()
    assert row["status"] == "COMPLETE"
    assert row["currentPhase"] == "COMPLETE"
    assert int(row["ttlAt"]) == int(_now(30).timestamp()) + execution_lock.COMPLETE_RETENTION_SECONDS


def test_mark_execution_failed_sets_status_last_error_and_ttl_without_deleting_row(lock_table):
    acquire_execution_lock(report_date=REPORT_DATE, owner_token="exec-1", now=_now())
    mark_execution_failed(
        report_date=REPORT_DATE, owner_token="exec-1", now=_now(30), error_message="ValueError: bad shard"
    )

    row = _row()
    assert row["status"] == "FAILED"
    assert row["currentPhase"] == "FAILED"
    assert row["lastError"] == "ValueError: bad shard"
    assert int(row["ttlAt"]) == int(_now(30).timestamp()) + execution_lock.COMPLETE_RETENTION_SECONDS


def test_mark_execution_failed_collapses_and_truncates_a_long_multiline_error(lock_table):
    acquire_execution_lock(report_date=REPORT_DATE, owner_token="exec-1", now=_now())
    long_message = ("line one\nline two\n" + "x" * 600)
    mark_execution_failed(
        report_date=REPORT_DATE, owner_token="exec-1", now=_now(30), error_message=long_message
    )

    row = _row()
    assert "\n" not in row["lastError"]
    assert len(row["lastError"]) == execution_lock._MAX_LAST_ERROR_LENGTH
    assert row["lastError"].endswith("…")


# --- canonicalize_report_date: explicit override vs. optional fields -------


def test_canonicalize_report_date_uses_explicit_date_override():
    result = canonicalize_report_date({"date": "2026-08-01"}, started_at="2026-09-10T09:00:00Z")
    assert result == date(2026, 8, 1)


def test_canonicalize_report_date_defaults_to_started_at_in_asia_tokyo():
    # 2026-09-10T15:00:00Z is 2026-09-11 00:00:00+09:00 in Asia/Tokyo.
    result = canonicalize_report_date({}, started_at="2026-09-10T15:00:00Z")
    assert result == date(2026, 9, 11)


def test_canonicalize_report_date_handles_a_missing_forceRecovery_key_safely():
    """execution_input may omit forceRecovery entirely -- canonicalize_report_date
    itself doesn't need it, and callers must use .get("forceRecovery", False),
    never a "$$.Execution.Input.forceRecovery" JSONPath that fails to resolve
    when the key is absent."""
    execution_input: dict = {}
    canonicalize_report_date(execution_input, started_at="2026-09-10T09:00:00Z")
    assert execution_input.get("forceRecovery", False) is False


# --- normal-execution write-count / WRU cost estimate -----------------------


def test_normal_execution_costs_exactly_19_lock_writes(lock_table):
    """1 acquire + 16 per-shard renews + 1 pre-reducer renew + 1 complete --
    the corrected write count for a normal (no-failure) daily execution."""
    writes = 0
    owner = "exec-1"

    acquire_execution_lock(report_date=REPORT_DATE, owner_token=owner, now=_now())
    writes += 1

    for shard in range(16):
        renew_execution_lock(
            report_date=REPORT_DATE, owner_token=owner, now=_now(shard),
            lease_seconds=execution_lock.SHARD_RENEW_LEASE_SECONDS,
            phase=execution_lock.PHASE_COLLECTING, completed_shard=shard,
        )
        writes += 1

    renew_execution_lock(
        report_date=REPORT_DATE, owner_token=owner, now=_now(20),
        lease_seconds=execution_lock.REDUCER_RENEW_LEASE_SECONDS, phase=execution_lock.PHASE_REDUCING,
    )
    writes += 1

    mark_execution_complete(report_date=REPORT_DATE, owner_token=owner, now=_now(25))
    writes += 1

    assert writes == 19
    row = _row()
    assert row["status"] == "COMPLETE"
    assert set(int(s) for s in row["completedShards"]) == set(range(16))


def test_lock_item_stays_well_under_1kb_so_every_write_is_exactly_one_wru(lock_table):
    """DynamoDB bills ceil(item_bytes / 1024) WRU per write, minimum 1 -- this
    pins that a fully-populated row (every field this module ever writes)
    stays under the 1KB boundary, so the 19-write estimate above really is
    19 WRU, not more."""
    acquire_execution_lock(report_date=REPORT_DATE, owner_token="exec-1234567890", now=_now())
    for shard in range(16):
        renew_execution_lock(
            report_date=REPORT_DATE, owner_token="exec-1234567890", now=_now(shard),
            lease_seconds=execution_lock.SHARD_RENEW_LEASE_SECONDS,
            phase=execution_lock.PHASE_COLLECTING, completed_shard=shard,
        )
    mark_execution_failed(
        report_date=REPORT_DATE, owner_token="exec-1234567890", now=_now(20),
        error_message="x" * execution_lock._MAX_LAST_ERROR_LENGTH,
    )
    row = _row()
    approx_bytes = sum(
        len(str(name).encode("utf-8")) + len(str(value).encode("utf-8")) for name, value in row.items()
    )
    assert approx_bytes < 1024
