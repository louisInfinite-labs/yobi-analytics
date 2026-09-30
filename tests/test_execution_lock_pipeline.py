"""Focused tests for how the execution lock wires into the two Lambda entry
points it actually runs inside -- history_worker_handler.lambda_handler
(AcquireExecutionLock + per-shard renew) and ranking_reducer.lambda_handler
(pre-reduce renew + MarkExecutionComplete + MarkExecutionFailed).

These are Lambda-handler-level tests: every AWS-facing call (execution_lock's
own DynamoDB writes, S3 partial storage, YouTube, Creator Master) is
monkeypatched to a spy/fake so each test isolates exactly one data-flow
contract -- most importantly, that reportDate/ownerToken always come from
the event, never from an independent "now" computation inside either
handler.
"""

from __future__ import annotations

from datetime import date

from stores import dynamodb_store
from collection import execution_lock
from api import history_worker_handler
import pytest
from analytics import ranking_reducer


# --- history_worker_handler: AcquireExecutionLock branch --------------------


def test_acquire_branch_computes_report_date_once_and_forwards_shards(monkeypatch):
    captured = {}

    def fake_acquire(*, report_date, owner_token, now, force_recovery=False):
        captured["report_date"] = report_date
        captured["owner_token"] = owner_token
        captured["force_recovery"] = force_recovery

    monkeypatch.setattr(execution_lock, "acquire_execution_lock", fake_acquire)

    event = {
        "validatedShards": [0, 1, 2],
        "executionInput": {"shards": [0, 1, 2]},
        "executionId": "arn:aws:states:ap-northeast-1:1:execution:daily-history:exec-1",
        # 2026-09-10T15:00:00Z == 2026-09-11T00:00:00+09:00 in Asia/Tokyo.
        "startedAt": "2026-09-10T15:00:00Z",
    }

    result = history_worker_handler.lambda_handler(event, None)

    assert result == {
        "shards": [0, 1, 2],
        "reportDate": "2026-09-11",
        "ownerToken": event["executionId"],
    }
    assert captured["report_date"] == date(2026, 9, 11)
    assert captured["owner_token"] == event["executionId"]
    assert captured["force_recovery"] is False


def test_acquire_branch_honors_an_explicit_date_override_and_force_recovery(monkeypatch):
    captured = {}

    def fake_acquire(*, report_date, owner_token, now, force_recovery=False):
        captured["report_date"] = report_date
        captured["force_recovery"] = force_recovery

    monkeypatch.setattr(execution_lock, "acquire_execution_lock", fake_acquire)

    event = {
        "validatedShards": [3],
        "executionInput": {"date": "2026-08-01", "forceRecovery": True},
        "executionId": "exec-2",
        "startedAt": "2026-09-10T15:00:00Z",
    }

    result = history_worker_handler.lambda_handler(event, None)

    assert captured["report_date"] == date(2026, 8, 1)
    assert captured["force_recovery"] is True
    assert result["reportDate"] == "2026-08-01"


def test_acquire_branch_handles_missing_optional_execution_input_fields(monkeypatch):
    """executionInput may omit both `date` and `forceRecovery` entirely --
    the ASL layer passes the whole $$.Execution.Input object precisely so
    this never depends on a JSONPath to an optional key that might not
    resolve."""
    captured = {}
    monkeypatch.setattr(
        execution_lock, "acquire_execution_lock", lambda **kwargs: captured.update(kwargs)
    )

    event = {
        "validatedShards": [0],
        "executionInput": {},
        "executionId": "exec-3",
        "startedAt": "2026-09-10T09:00:00Z",
    }

    result = history_worker_handler.lambda_handler(event, None)

    assert result["shards"] == [0]
    assert captured["force_recovery"] is False


def test_acquire_branch_lets_execution_lock_held_error_propagate_uncaught(monkeypatch):
    def fake_acquire(**kwargs):
        raise execution_lock.ExecutionLockHeldError("already held")

    monkeypatch.setattr(execution_lock, "acquire_execution_lock", fake_acquire)
    event = {
        "validatedShards": [0],
        "executionInput": {},
        "executionId": "exec-4",
        "startedAt": "2026-09-10T09:00:00Z",
    }

    with pytest.raises(execution_lock.ExecutionLockHeldError):
        history_worker_handler.lambda_handler(event, None)


# --- history_worker_handler: per-shard branch renews the lock ---------------


class _FakeCollectResult:
    requested_count = 1
    collected_count = 1
    skipped: dict = {}
    history_key = "history/daily/date=2026-01-01/shard=03.parquet"
    rows: list = []
    topic_by_video: dict = {}


def _wire_shard_branch(monkeypatch, *, collect_spy=None):
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", "test-bucket")
    monkeypatch.setattr(history_worker_handler, "get_api_key", lambda: "key")
    monkeypatch.setattr(history_worker_handler, "build_youtube_client", lambda key: object())
    monkeypatch.setattr(history_worker_handler, "S3HistoryStore", lambda bucket_name: object())
    monkeypatch.setattr(history_worker_handler, "S3TrackingManifestStore", lambda bucket_name: object())

    def fake_collect(
        *,
        youtube,
        manifest_store,
        history_store,
        video_master_store,
        collection_date,
        shard,
        observed_at,
    ):
        if collect_spy is not None:
            collect_spy(collection_date=collection_date, shard=shard)
        return _FakeCollectResult()

    monkeypatch.setattr(history_worker_handler, "collect_history_shard", fake_collect)


def test_shard_branch_uses_the_passed_report_date_not_a_freshly_computed_today(monkeypatch):
    captured_dates = []
    _wire_shard_branch(monkeypatch, collect_spy=lambda collection_date, shard: captured_dates.append(collection_date))
    monkeypatch.setattr(execution_lock, "renew_execution_lock", lambda **kwargs: None)

    result = history_worker_handler.lambda_handler(
        {"shard": 3, "reportDate": "2026-01-01", "ownerToken": "exec-9"}, None
    )

    # 2026-01-01 is deliberately not "today" by any real-clock measure at
    # test-run time -- proves collect_history_shard is called with the
    # event's own reportDate, never a self-computed "now".
    assert captured_dates == [date(2026, 1, 1)]
    assert result["date"] == "2026-01-01"


def test_shard_branch_renews_the_lock_after_a_successful_collection(monkeypatch):
    _wire_shard_branch(monkeypatch)
    renew_calls = []
    monkeypatch.setattr(execution_lock, "renew_execution_lock", lambda **kwargs: renew_calls.append(kwargs))

    history_worker_handler.lambda_handler({"shard": 3, "reportDate": "2026-01-01", "ownerToken": "exec-9"}, None)

    assert len(renew_calls) == 1
    call = renew_calls[0]
    assert call["report_date"] == date(2026, 1, 1)
    assert call["owner_token"] == "exec-9"
    assert call["completed_shard"] == 3
    assert call["phase"] == execution_lock.PHASE_COLLECTING
    assert call["lease_seconds"] == execution_lock.SHARD_RENEW_LEASE_SECONDS


def test_shard_branch_never_reads_topics_via_the_full_catalog_dynamodb_batch_get(monkeypatch):
    """AWS Cost Recovery second pass: the per-shard branch must never call
    dynamodb_store.get_video_topics -- the full-catalog BatchGetItem
    identified as the strongest code-grounded cause of the 2026-09-21
    YobiVideoMaster read increase. result.topic_by_video is still computed
    by collect_history_shard itself (manifest-sourced, no DynamoDB read at
    all), it is just never read by this handler.
    """
    from stores.history_store import HistoryRow

    _wire_shard_branch(monkeypatch)
    monkeypatch.setattr(execution_lock, "renew_execution_lock", lambda **kwargs: None)

    def _boom(video_ids):
        raise AssertionError("get_video_topics must not be called by the per-shard branch")

    monkeypatch.setattr(dynamodb_store, "get_video_topics", _boom)

    class _FakeCollectResultWithTopics(_FakeCollectResult):
        rows = [
            HistoryRow(video_id="v1", creator_id="c1", view_count=100, observed_at="2026-01-01T18:00:00+09:00", availability_status="available"),
        ]
        topic_by_video = {"v1": "valorant"}

    monkeypatch.setattr(
        history_worker_handler,
        "collect_history_shard",
        lambda **kwargs: _FakeCollectResultWithTopics(),
    )

    result = history_worker_handler.lambda_handler({"shard": 3, "reportDate": "2026-01-01", "ownerToken": "exec-9"}, None)

    assert result["historyKey"] == _FakeCollectResultWithTopics.history_key


def test_shard_branch_lets_execution_lock_lost_error_propagate_uncaught(monkeypatch):
    """If this owner's lease was already reclaimed while the shard was being
    collected, the renew call raises ExecutionLockLostError -- this must
    surface as a Task failure, not be swallowed (so it reaches the Map's own
    Catch instead of returning a false success)."""
    _wire_shard_branch(monkeypatch)

    def fake_renew(**kwargs):
        raise execution_lock.ExecutionLockLostError("lease reclaimed")

    monkeypatch.setattr(execution_lock, "renew_execution_lock", fake_renew)

    with pytest.raises(execution_lock.ExecutionLockLostError):
        history_worker_handler.lambda_handler({"shard": 3, "reportDate": "2026-01-01", "ownerToken": "exec-9"}, None)


# --- ranking_reducer: normal reduce branch renews before building video ranking ----


def _wire_reducer_normal_branch(monkeypatch):
    """R9 (org-trending retirement): the reducer's only remaining work after
    renewing the lock is _build_and_persist_video_rankings, which no-ops
    immediately when YOBI_HISTORY_BUCKET isn't configured (S3VideoRankingStore.
    from_environment() returns None) -- leaving it unset here is what lets
    these tests isolate execution-lock wiring without needing a real/moto S3."""
    monkeypatch.delenv("YOBI_HISTORY_BUCKET", raising=False)


def test_reducer_normal_branch_renews_the_lock_with_the_passed_report_date(monkeypatch):
    renew_calls = []
    monkeypatch.setattr(
        execution_lock, "renew_execution_lock", lambda **kwargs: renew_calls.append(kwargs)
    )
    _wire_reducer_normal_branch(monkeypatch)

    ranking_reducer.lambda_handler({"reportDate": "2026-01-05", "ownerToken": "exec-9"}, None)

    assert len(renew_calls) == 1
    renew_kwargs = renew_calls[0]
    assert renew_kwargs["report_date"] == date(2026, 1, 5)
    assert renew_kwargs["owner_token"] == "exec-9"
    assert renew_kwargs["phase"] == execution_lock.PHASE_REDUCING
    assert renew_kwargs["lease_seconds"] == execution_lock.REDUCER_RENEW_LEASE_SECONDS


def test_reducer_normal_branch_returns_report_date_and_owner_token_for_mark_execution_complete(monkeypatch):
    monkeypatch.setattr(execution_lock, "renew_execution_lock", lambda **kwargs: None)
    _wire_reducer_normal_branch(monkeypatch)

    result = ranking_reducer.lambda_handler({"reportDate": "2026-01-05", "ownerToken": "exec-9"}, None)

    assert result["reportDate"] == "2026-01-05"
    assert result["ownerToken"] == "exec-9"


def test_reducer_normal_branch_lets_execution_lock_lost_error_propagate_uncaught(monkeypatch):
    def fake_renew(**kwargs):
        raise execution_lock.ExecutionLockLostError("lease reclaimed")

    monkeypatch.setattr(execution_lock, "renew_execution_lock", fake_renew)

    with pytest.raises(execution_lock.ExecutionLockLostError):
        ranking_reducer.lambda_handler({"reportDate": "2026-01-05", "ownerToken": "exec-9"}, None)


# --- ranking_reducer: MarkExecutionComplete / MarkExecutionFailed branches --


def test_mark_execution_complete_branch_calls_execution_lock_with_parsed_date(monkeypatch):
    captured = {}
    monkeypatch.setattr(
        execution_lock, "mark_execution_complete", lambda **kwargs: captured.update(kwargs)
    )

    result = ranking_reducer.lambda_handler(
        {"markCompleteForDate": "2026-01-05", "ownerToken": "exec-9"}, None
    )

    assert captured["report_date"] == date(2026, 1, 5)
    assert captured["owner_token"] == "exec-9"
    assert result == {"date": "2026-01-05", "status": "COMPLETE"}


def test_mark_execution_failed_branch_forwards_the_error_message(monkeypatch):
    captured = {}
    monkeypatch.setattr(
        execution_lock, "mark_execution_failed", lambda **kwargs: captured.update(kwargs)
    )

    result = ranking_reducer.lambda_handler(
        {"markFailedForDate": "2026-01-05", "ownerToken": "exec-9", "error": {"Error": "States.TaskFailed", "Cause": "boom"}},
        None,
    )

    assert captured["report_date"] == date(2026, 1, 5)
    assert captured["owner_token"] == "exec-9"
    assert "States.TaskFailed" in captured["error_message"]
    assert result == {"date": "2026-01-05", "status": "FAILED"}


def test_mark_execution_failed_branch_lets_execution_lock_lost_error_propagate(monkeypatch):
    """If this owner's lease was already reclaimed, mark_execution_failed
    itself raises ExecutionLockLostError -- this must NOT be swallowed here.
    terraform/history.tf's own Catch on the MarkExecutionFailed state (not
    this function) is what guarantees the pipeline still reaches its
    terminal Fail state either way, so the original pipeline failure that
    triggered this call is never masked by this secondary error."""

    def fake_mark_failed(**kwargs):
        raise execution_lock.ExecutionLockLostError("lease reclaimed")

    monkeypatch.setattr(execution_lock, "mark_execution_failed", fake_mark_failed)

    with pytest.raises(execution_lock.ExecutionLockLostError):
        ranking_reducer.lambda_handler(
            {"markFailedForDate": "2026-01-05", "ownerToken": "exec-9", "error": "boom"}, None
        )
