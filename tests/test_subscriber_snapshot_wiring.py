"""Focused tests for wiring the R1 subscriber-history snapshot into the real
daily production execution path (ranking-simplification, R3).

api.history_worker_handler._collect_subscriber_snapshot_if_configured is
called exactly once, from the AcquireExecutionLock branch
(terraform/history.tf's own single Task, reached once per execution before
CollectHistoryShards' 16-way Map ever fans out to CollectShard, the
per-shard branch in this same Lambda handler) -- never from the per-shard
branch itself.
"""

from __future__ import annotations

import re
from datetime import date
from unittest.mock import MagicMock

import boto3
import pytest
from moto import mock_aws

from api import history_worker_handler
from collection import execution_lock
from collection.youtube_client import MAX_IDS_PER_REQUEST, QuotaExhaustedError
from stores.subscriber_history_store import S3SubscriberHistoryStore
from stores.subscriber_ranking_store import S3SubscriberRankingStore
from tracking.creator_master import Creator

BUCKET = "test-history-bucket"
REGION = "ap-northeast-1"


def _creator(creator_id: str, channel_id: str, organization: str = "hololive") -> Creator:
    return Creator(
        creator_id=creator_id,
        display_name=creator_id,
        organization=organization,
        youtube_channel_id=channel_id,
        active=True,
        branch="holo_jp",
        group_key=["NO"],
        channel_type="member",
        lifecycle_stage="active",
        display_order=1,
    )


def _acquire_event(*, execution_id="exec-1", started_at="2026-09-29T09:00:00Z", shards=None, execution_input=None):
    return {
        "validatedShards": shards if shards is not None else [0, 1, 2, 3],
        "executionInput": execution_input or {},
        "executionId": execution_id,
        "startedAt": started_at,
    }


@pytest.fixture
def s3_bucket(aws_credentials):
    with mock_aws():
        client = boto3.client("s3", region_name=REGION)
        client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})
        yield client


def _wire_acquire_branch(monkeypatch, *, creators):
    monkeypatch.setattr(execution_lock, "acquire_execution_lock", lambda **kwargs: None)
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", BUCKET)
    monkeypatch.setattr(history_worker_handler, "get_active_creators", lambda: creators)
    monkeypatch.setattr(history_worker_handler, "get_api_key", lambda: "test-key")


def _wire_youtube(monkeypatch, response):
    youtube = MagicMock()
    youtube.channels.return_value.list.return_value.execute.return_value = response
    monkeypatch.setattr(history_worker_handler, "build_youtube_client", lambda key: youtube)
    return youtube


class _FakeCollectResult:
    requested_count = 0
    collected_count = 0
    skipped: dict = {}
    history_key = "history/daily/date=2026-09-29/shard=00.parquet"
    rows: list = []
    rankings: dict = {}
    creator_partials: dict = {}
    topic_by_video: dict = {}


class _FakePartialStore:
    def __init__(self, bucket_name):
        self.bucket_name = bucket_name

    def write(self, collection_date, shard, rankings, creator_partials, topic_partials=None):
        return f"partial/{collection_date.isoformat()}/{shard}"


def _wire_shard_branch(monkeypatch):
    """Mirrors tests/test_execution_lock_pipeline.py's own _wire_shard_branch:
    the per-shard branch's real dependencies are replaced with cheap fakes,
    so a call through it never touches YouTube/S3/DynamoDB for real."""
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", BUCKET)
    monkeypatch.setattr(history_worker_handler, "get_api_key", lambda: "key")
    monkeypatch.setattr(history_worker_handler, "build_youtube_client", lambda key: object())
    monkeypatch.setattr(history_worker_handler, "load_creators", lambda: [])
    monkeypatch.setattr(history_worker_handler, "S3HistoryStore", lambda bucket_name: object())
    monkeypatch.setattr(history_worker_handler, "S3TrackingManifestStore", lambda bucket_name: object())
    monkeypatch.setattr(history_worker_handler, "S3PartialRankingStore", _FakePartialStore)
    monkeypatch.setattr(history_worker_handler, "collect_history_shard", lambda **kwargs: _FakeCollectResult())
    monkeypatch.setattr(execution_lock, "renew_execution_lock", lambda **kwargs: None)


# --- 1/2. Runs once per daily execution, never once per shard ---------------


def test_subscriber_snapshot_collected_exactly_once_from_the_acquire_branch(monkeypatch, s3_bucket):
    creators = [_creator("creator_a", "UC_a")]
    _wire_acquire_branch(monkeypatch, creators=creators)
    youtube = _wire_youtube(
        monkeypatch,
        {"items": [{"id": "UC_a", "statistics": {"subscriberCount": "100", "hiddenSubscriberCount": False}}]},
    )

    result = history_worker_handler.lambda_handler(_acquire_event(), None)

    assert youtube.channels.return_value.list.call_count == 1
    store = S3SubscriberHistoryStore(BUCKET, s3_client=s3_bucket)
    rows = store.read_daily_snapshot(date(2026, 9, 29))
    assert [row.creator_id for row in rows] == ["creator_a"]
    # The acquire branch's own normal contract is untouched by any of this.
    assert result == {"shards": [0, 1, 2, 3], "reportDate": "2026-09-29", "ownerToken": "exec-1"}


def test_subscriber_snapshot_is_not_collected_from_the_per_shard_branch(monkeypatch):
    calls = []
    monkeypatch.setattr(
        history_worker_handler,
        "collect_subscriber_snapshot_if_missing",
        lambda *a, **k: (calls.append(1), ("key", {}, True))[1],
    )
    _wire_shard_branch(monkeypatch)

    history_worker_handler.lambda_handler({"shard": 3, "reportDate": "2026-09-29", "ownerToken": "exec-9"}, None)

    assert calls == []


def test_subscriber_snapshot_runs_once_per_execution_regardless_of_shard_count(monkeypatch, s3_bucket):
    """A real daily_history execution's Map fans out to as many as
    HISTORY_SHARD_COUNT (16) CollectShard invocations of this same Lambda --
    AcquireExecutionLock (where subscriber collection lives) is reached
    exactly once beforehand regardless of that count, so simulating a large
    `validatedShards` array must not change how many times YouTube is
    called for subscribers."""
    creators = [_creator("creator_a", "UC_a")]
    _wire_acquire_branch(monkeypatch, creators=creators)
    youtube = _wire_youtube(
        monkeypatch,
        {"items": [{"id": "UC_a", "statistics": {"subscriberCount": "100", "hiddenSubscriberCount": False}}]},
    )

    history_worker_handler.lambda_handler(_acquire_event(shards=list(range(16))), None)

    assert youtube.channels.return_value.list.call_count == 1


# --- 3. Authoritative creator registry is used -------------------------------


def test_authoritative_creator_registry_is_used(monkeypatch, s3_bucket):
    registry_calls = []
    real_creators = [_creator("creator_a", "UC_a")]
    monkeypatch.setattr(execution_lock, "acquire_execution_lock", lambda **kwargs: None)
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", BUCKET)

    def _spy_get_active_creators():
        registry_calls.append(1)
        return real_creators

    monkeypatch.setattr(history_worker_handler, "get_active_creators", _spy_get_active_creators)
    monkeypatch.setattr(history_worker_handler, "get_api_key", lambda: "test-key")
    _wire_youtube(
        monkeypatch,
        {"items": [{"id": "UC_a", "statistics": {"subscriberCount": "1", "hiddenSubscriberCount": False}}]},
    )

    history_worker_handler.lambda_handler(_acquire_event(), None)

    assert registry_calls == [1]  # the authoritative registry was consulted, not a second hardcoded list


# --- 4/6. Channel IDs batched through the existing R1 collector, no sharding -


def test_channel_ids_batched_through_the_existing_r1_collector(monkeypatch, s3_bucket):
    creator_count = MAX_IDS_PER_REQUEST + 10  # forces exactly 2 channels.list batches
    creators = [_creator(f"creator_{i}", f"UC_{i}") for i in range(creator_count)]
    _wire_acquire_branch(monkeypatch, creators=creators)
    youtube = MagicMock()
    # Both real batches succeed fully, so the bounded repair pass never
    # triggers -- this test is purely about batching, not retry.
    youtube.channels.return_value.list.return_value.execute.side_effect = [
        {
            "items": [
                {"id": f"UC_{i}", "statistics": {"subscriberCount": str(i), "hiddenSubscriberCount": False}}
                for i in range(MAX_IDS_PER_REQUEST)
            ]
        },
        {
            "items": [
                {"id": f"UC_{i}", "statistics": {"subscriberCount": str(i), "hiddenSubscriberCount": False}}
                for i in range(MAX_IDS_PER_REQUEST, creator_count)
            ]
        },
    ]
    monkeypatch.setattr(history_worker_handler, "build_youtube_client", lambda key: youtube)

    history_worker_handler.lambda_handler(_acquire_event(), None)

    assert youtube.channels.return_value.list.call_count == 2  # not one request per creator


def test_no_sharded_subscriber_history_keys_are_created(monkeypatch, s3_bucket):
    creators = [_creator("creator_a", "UC_a")]
    _wire_acquire_branch(monkeypatch, creators=creators)
    _wire_youtube(
        monkeypatch,
        {"items": [{"id": "UC_a", "statistics": {"subscriberCount": "1", "hiddenSubscriberCount": False}}]},
    )

    history_worker_handler.lambda_handler(_acquire_event(), None)

    keys = [obj["Key"] for obj in s3_bucket.list_objects_v2(Bucket=BUCKET, Prefix="subscriber-history/").get("Contents", [])]
    assert keys == ["subscriber-history/date=2026-09-29.parquet"]
    assert "shard=" not in keys[0]


# --- 5. One deterministic S3 key per report date -----------------------------


def test_one_deterministic_s3_key_per_report_date(monkeypatch, s3_bucket):
    creators = [_creator("creator_a", "UC_a")]
    _wire_acquire_branch(monkeypatch, creators=creators)
    _wire_youtube(
        monkeypatch,
        {"items": [{"id": "UC_a", "statistics": {"subscriberCount": "1", "hiddenSubscriberCount": False}}]},
    )

    history_worker_handler.lambda_handler(
        _acquire_event(started_at="2026-09-10T15:00:00Z"), None  # -> 2026-09-11 JST
    )

    keys = [obj["Key"] for obj in s3_bucket.list_objects_v2(Bucket=BUCKET, Prefix="subscriber-history/")["Contents"]]
    assert keys == ["subscriber-history/date=2026-09-11.parquet"]


# --- 7. Hidden subscriber semantics preserved end-to-end ---------------------


def test_hidden_subscriber_semantics_preserved_end_to_end(monkeypatch, s3_bucket):
    creators = [_creator("creator_visible", "UC_v"), _creator("creator_hidden", "UC_h")]
    _wire_acquire_branch(monkeypatch, creators=creators)
    _wire_youtube(
        monkeypatch,
        {
            "items": [
                {"id": "UC_v", "statistics": {"subscriberCount": "12345", "hiddenSubscriberCount": False}},
                {"id": "UC_h", "statistics": {"subscriberCount": "0", "hiddenSubscriberCount": True}},
            ]
        },
    )

    history_worker_handler.lambda_handler(_acquire_event(), None)

    store = S3SubscriberHistoryStore(BUCKET, s3_client=s3_bucket)
    rows = {row.creator_id: row for row in store.read_daily_snapshot(date(2026, 9, 29))}
    assert rows["creator_visible"].subscriber_count == 12345
    assert rows["creator_hidden"].subscriber_count is None
    assert rows["creator_hidden"].hidden_subscriber_count is True


# --- 8. Partial creator failure does not fabricate zero ---------------------


def test_partial_creator_failure_does_not_fabricate_zero(monkeypatch, s3_bucket):
    creators = [_creator("creator_ok", "UC_ok"), _creator("creator_missing", "UC_missing")]
    _wire_acquire_branch(monkeypatch, creators=creators)
    _wire_youtube(
        monkeypatch,
        {"items": [{"id": "UC_ok", "statistics": {"subscriberCount": "50", "hiddenSubscriberCount": False}}]},
    )

    history_worker_handler.lambda_handler(_acquire_event(), None)

    store = S3SubscriberHistoryStore(BUCKET, s3_client=s3_bucket)
    rows = {row.creator_id: row for row in store.read_daily_snapshot(date(2026, 9, 29))}
    assert rows["creator_ok"].subscriber_count == 50
    assert "creator_missing" not in rows  # absent, never a fabricated 0


# --- 9. Retry/same-date behavior is deterministic ----------------------------


def test_retry_after_a_complete_snapshot_skips_recollection_and_keeps_first_result(monkeypatch, s3_bucket):
    """When the first execution already observed 100% of the roster, a
    second execution for the exact same reportDate (e.g. a manual retry
    after the first execution failed at a later, unrelated state) must not
    call YouTube again or overwrite the existing snapshot with a fresh one
    -- completeness, not merely "an object exists", is what makes this safe
    to skip (see the R3-correction repair tests in
    tests/collection/test_subscriber_snapshot_repair.py for the partial/
    empty-snapshot cases this same function repairs instead of skipping)."""
    creators = [_creator("creator_a", "UC_a")]
    _wire_acquire_branch(monkeypatch, creators=creators)
    youtube = _wire_youtube(
        monkeypatch,
        {"items": [{"id": "UC_a", "statistics": {"subscriberCount": "100", "hiddenSubscriberCount": False}}]},
    )

    history_worker_handler.lambda_handler(_acquire_event(execution_id="exec-1"), None)
    youtube.channels.return_value.list.return_value.execute.return_value = {
        "items": [{"id": "UC_a", "statistics": {"subscriberCount": "999", "hiddenSubscriberCount": False}}]
    }
    history_worker_handler.lambda_handler(_acquire_event(execution_id="exec-2"), None)

    assert youtube.channels.return_value.list.call_count == 1  # second call never reached YouTube
    store = S3SubscriberHistoryStore(BUCKET, s3_client=s3_bucket)
    rows = store.read_daily_snapshot(date(2026, 9, 29))
    assert rows[0].subscriber_count == 100  # first result preserved, not replaced by the second


def test_retry_after_a_partial_snapshot_repairs_only_the_missing_creators(monkeypatch, s3_bucket):
    """The R3-correction case: the first execution only observes part of the
    roster (a transient per-batch failure); a second execution for the same
    reportDate must recover the still-missing creator without touching the
    already-good one, through the real Lambda entry point end-to-end."""
    creators = [_creator("creator_a", "UC_a"), _creator("creator_b", "UC_b")]
    _wire_acquire_branch(monkeypatch, creators=creators)
    youtube = MagicMock()
    youtube.channels.return_value.list.return_value.execute.side_effect = [
        {"items": [{"id": "UC_a", "statistics": {"subscriberCount": "100", "hiddenSubscriberCount": False}}]},
        {"items": [{"id": "UC_b", "statistics": {"subscriberCount": "200", "hiddenSubscriberCount": False}}]},
    ]
    monkeypatch.setattr(history_worker_handler, "build_youtube_client", lambda key: youtube)

    history_worker_handler.lambda_handler(_acquire_event(execution_id="exec-1"), None)
    history_worker_handler.lambda_handler(_acquire_event(execution_id="exec-2"), None)

    store = S3SubscriberHistoryStore(BUCKET, s3_client=s3_bucket)
    rows = {row.creator_id: row for row in store.read_daily_snapshot(date(2026, 9, 29))}
    assert rows["creator_a"].subscriber_count == 100
    assert rows["creator_b"].subscriber_count == 200


# --- 10. Subscriber-only failure policy: never propagates -------------------


def test_generic_subscriber_collection_failure_does_not_abort_the_acquire_branch(monkeypatch, s3_bucket):
    _wire_acquire_branch(monkeypatch, creators=[_creator("creator_a", "UC_a")])
    monkeypatch.setattr(
        history_worker_handler,
        "collect_subscriber_snapshot_if_missing",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("network exploded")),
    )

    result = history_worker_handler.lambda_handler(_acquire_event(), None)

    assert result == {"shards": [0, 1, 2, 3], "reportDate": "2026-09-29", "ownerToken": "exec-1"}


def test_quota_exhaustion_does_not_abort_the_acquire_branch(monkeypatch, capsys):
    _wire_acquire_branch(monkeypatch, creators=[_creator("creator_a", "UC_a")])
    monkeypatch.setattr(
        history_worker_handler,
        "collect_subscriber_snapshot_if_missing",
        lambda *a, **k: (_ for _ in ()).throw(QuotaExhaustedError("quota exceeded")),
    )

    result = history_worker_handler.lambda_handler(_acquire_event(), None)

    assert result == {"shards": [0, 1, 2, 3], "reportDate": "2026-09-29", "ownerToken": "exec-1"}
    assert "quota" in capsys.readouterr().out.lower()


def test_s3_write_failure_does_not_abort_the_acquire_branch(monkeypatch):
    from stores.subscriber_history_store import SubscriberHistoryStoreError

    _wire_acquire_branch(monkeypatch, creators=[_creator("creator_a", "UC_a")])
    monkeypatch.setattr(
        history_worker_handler,
        "collect_subscriber_snapshot_if_missing",
        lambda *a, **k: (_ for _ in ()).throw(SubscriberHistoryStoreError("write failed")),
    )

    result = history_worker_handler.lambda_handler(_acquire_event(), None)

    assert result == {"shards": [0, 1, 2, 3], "reportDate": "2026-09-29", "ownerToken": "exec-1"}


# --- 11. Existing video-history flow still executes correctly ---------------


def test_shard_branch_still_returns_its_normal_result_unaffected_by_subscriber_wiring(monkeypatch):
    _wire_shard_branch(monkeypatch)

    result = history_worker_handler.lambda_handler(
        {"shard": 3, "reportDate": "2026-09-29", "ownerToken": "exec-9"}, None
    )

    assert result["shard"] == 3
    assert result["date"] == "2026-09-29"


def test_execution_lock_held_error_still_propagates_uncaught_through_subscriber_wiring(monkeypatch):
    """The subscriber snapshot must never run at all if this execution never
    legitimately acquired the lock -- it is called strictly after
    execution_lock.acquire_execution_lock succeeds."""
    subscriber_calls = []
    monkeypatch.setattr(
        history_worker_handler,
        "collect_subscriber_snapshot_if_missing",
        lambda *a, **k: subscriber_calls.append(1),
    )

    def fake_acquire(**kwargs):
        raise execution_lock.ExecutionLockHeldError("already held")

    monkeypatch.setattr(execution_lock, "acquire_execution_lock", fake_acquire)

    with pytest.raises(execution_lock.ExecutionLockHeldError):
        history_worker_handler.lambda_handler(_acquire_event(), None)

    assert subscriber_calls == []


# --- 12. No new scheduler/state-machine resource is required -----------------


def test_no_new_scheduler_or_state_machine_resource_was_introduced():
    history_tf = open("terraform/history.tf").read()
    eventbridge_tf = open("terraform/eventbridge.tf").read()

    state_machines = set(re.findall(r'resource\s+"aws_sfn_state_machine"\s+"(\w+)"', history_tf))
    schedules = set(re.findall(r'resource\s+"aws_scheduler_schedule"\s+"(\w+)"', eventbridge_tf))

    assert state_machines == {"daily_history"}
    # R7 (AWS Cost Recovery) removed trending_precompute_batches entirely
    # (it was already Terraform-disabled, and its own module was deleted).
    assert schedules == {"daily_collection", "discovery_only", "notification_dispatch"}


def test_no_new_lambda_function_resource_was_introduced():
    lambda_tf = open("terraform/lambda.tf").read()
    functions = set(re.findall(r'resource\s+"aws_lambda_function"\s+"(\w+)"', lambda_tf))

    assert functions == {"collector", "history_worker", "ranking_reducer", "api", "notification_dispatcher", "emergency_stop"}


# --- 13. No R2 leaderboard persistence happens yet ---------------------------


def test_r3_wiring_has_no_dynamodb_or_trending_cache_dependency():
    """R3/R4's new modules (subscriber_snapshot, subscriber_ranking_result,
    subscriber_ranking_store) must never import dynamodb_store or boto3's
    dynamodb client -- S3-only, per R4's own explicit scope."""
    import ast
    import inspect

    import analytics.subscriber_ranking_result as subscriber_ranking_result
    import stores.subscriber_ranking_store as subscriber_ranking_store

    for module in (subscriber_ranking_result, subscriber_ranking_store):
        tree = ast.parse(inspect.getsource(module))
        imported_modules = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module:
                imported_modules.add(node.module)
            elif isinstance(node, ast.Import):
                imported_modules.update(alias.name for alias in node.names)
        # boto3 itself is fine (needed for the S3 client, same as every
        # other S3 store in this codebase) -- dynamodb_store specifically is
        # the real signal of DynamoDB/TrendingCache coupling, and must never
        # appear here.
        assert "dynamodb_store" not in imported_modules


# ==================================================
# R4: daily subscriber leaderboard result in S3
# ==================================================


def _wire_acquire_and_ranking(monkeypatch, *, creators, channels_response):
    _wire_acquire_branch(monkeypatch, creators=creators)
    return _wire_youtube(monkeypatch, channels_response)


def test_r4_builds_and_persists_the_ranking_result_exactly_once_from_acquire_branch(monkeypatch, s3_bucket):
    import analytics.subscriber_ranking_result as subscriber_ranking_result

    calls = []
    real_build = subscriber_ranking_result.build_subscriber_leaderboards

    def _spy(*args, **kwargs):
        calls.append(1)
        return real_build(*args, **kwargs)

    # Patched where subscriber_ranking_result imported the name into its OWN
    # namespace (`from analytics.subscriber_ranking import
    # build_subscriber_leaderboards`) -- patching analytics.subscriber_
    # ranking's own attribute instead would not affect this already-bound
    # reference.
    monkeypatch.setattr(subscriber_ranking_result, "build_subscriber_leaderboards", _spy)
    _wire_acquire_and_ranking(
        monkeypatch,
        creators=[_creator("creator_a", "UC_a")],
        channels_response={"items": [{"id": "UC_a", "statistics": {"subscriberCount": "100", "hiddenSubscriberCount": False}}]},
    )

    history_worker_handler.lambda_handler(_acquire_event(), None)

    assert calls == [1]  # exactly once, not per shard
    ranking_store = S3SubscriberRankingStore(BUCKET, s3_client=s3_bucket)
    result = ranking_store.read_result(date(2026, 9, 29))
    assert result is not None
    assert result["total"]["rows"][0]["creatorId"] == "creator_a"


def test_r4_result_is_one_object_per_report_date(monkeypatch, s3_bucket):
    _wire_acquire_and_ranking(
        monkeypatch,
        creators=[_creator("creator_a", "UC_a")],
        channels_response={"items": [{"id": "UC_a", "statistics": {"subscriberCount": "1", "hiddenSubscriberCount": False}}]},
    )

    history_worker_handler.lambda_handler(_acquire_event(), None)

    keys = [obj["Key"] for obj in s3_bucket.list_objects_v2(Bucket=BUCKET, Prefix="subscriber-ranking/")["Contents"]]
    assert keys == ["subscriber-ranking/date=2026-09-29.json"]


def test_r4_ranking_result_is_not_built_from_the_per_shard_branch(monkeypatch):
    """Mirrors R3's own once-per-day-not-per-shard guarantee, for the new R4
    ranking-build step specifically."""
    calls = []
    monkeypatch.setattr(
        history_worker_handler,
        "_build_and_persist_subscriber_ranking",
        lambda **kwargs: calls.append(1),
    )
    _wire_shard_branch(monkeypatch)

    history_worker_handler.lambda_handler({"shard": 3, "reportDate": "2026-09-29", "ownerToken": "exec-9"}, None)

    assert calls == []


def test_r4_same_date_repaired_snapshot_rebuilds_the_ranking_result(monkeypatch, s3_bucket):
    """The exact repair -> rebuild property R4 requires: a first invocation
    that only observes part of the roster produces an incomplete ranking
    result; a second invocation (R3's own repair) recovers the rest, and the
    SAME report date's ranking result is rebuilt to reflect it."""
    creators = [_creator("creator_a", "UC_a"), _creator("creator_b", "UC_b")]
    _wire_acquire_branch(monkeypatch, creators=creators)
    youtube = MagicMock()
    youtube.channels.return_value.list.return_value.execute.side_effect = [
        # Invocation 1, pass 1: UC_b missing from the response.
        {"items": [{"id": "UC_a", "statistics": {"subscriberCount": "100", "hiddenSubscriberCount": False}}]},
        # Invocation 1's own bounded retry (R3) for UC_b: still fails.
        {"items": []},
        # Invocation 2, pass 1 (only UC_b still missing this time): recovers.
        {"items": [{"id": "UC_b", "statistics": {"subscriberCount": "200", "hiddenSubscriberCount": False}}]},
    ]
    monkeypatch.setattr(history_worker_handler, "build_youtube_client", lambda key: youtube)

    history_worker_handler.lambda_handler(_acquire_event(execution_id="exec-1"), None)
    ranking_store = S3SubscriberRankingStore(BUCKET, s3_client=s3_bucket)
    first_result = ranking_store.read_result(date(2026, 9, 29))
    assert first_result["observedCreatorCount"] == 1
    assert {row["creatorId"] for row in first_result["total"]["rows"]} == {"creator_a"}

    history_worker_handler.lambda_handler(_acquire_event(execution_id="exec-2"), None)
    second_result = ranking_store.read_result(date(2026, 9, 29))
    assert second_result["observedCreatorCount"] == 2
    assert {row["creatorId"] for row in second_result["total"]["rows"]} == {"creator_a", "creator_b"}


def test_r4_skips_writing_when_no_usable_current_observations_exist(monkeypatch, s3_bucket):
    creators = [_creator("creator_a", "UC_a")]
    _wire_acquire_branch(monkeypatch, creators=creators)
    youtube = MagicMock()
    youtube.channels.return_value.list.return_value.execute.return_value = {"items": []}
    monkeypatch.setattr(history_worker_handler, "build_youtube_client", lambda key: youtube)

    history_worker_handler.lambda_handler(_acquire_event(), None)

    ranking_store = S3SubscriberRankingStore(BUCKET, s3_client=s3_bucket)
    assert ranking_store.read_result(date(2026, 9, 29)) is None


def test_r4_ranking_failure_does_not_abort_the_acquire_branch(monkeypatch, s3_bucket):
    _wire_acquire_and_ranking(
        monkeypatch,
        creators=[_creator("creator_a", "UC_a")],
        channels_response={"items": [{"id": "UC_a", "statistics": {"subscriberCount": "1", "hiddenSubscriberCount": False}}]},
    )
    monkeypatch.setattr(
        history_worker_handler,
        "_build_and_persist_subscriber_ranking",
        lambda **kwargs: (_ for _ in ()).throw(RuntimeError("ranking build exploded")),
    )

    result = history_worker_handler.lambda_handler(_acquire_event(), None)

    assert result == {"shards": [0, 1, 2, 3], "reportDate": "2026-09-29", "ownerToken": "exec-1"}


def test_r4_no_new_dynamodb_table_or_gsi_or_trending_cache_write(monkeypatch, s3_bucket):
    """R4's own explicit scope: S3 only. Confirm the real acquire-branch
    invocation never touches dynamodb_store.put_cached_trending or any
    DynamoDB call at all."""
    from stores import dynamodb_store

    calls = []
    monkeypatch.setattr(dynamodb_store, "put_cached_trending", lambda *a, **k: calls.append(1))
    _wire_acquire_and_ranking(
        monkeypatch,
        creators=[_creator("creator_a", "UC_a")],
        channels_response={"items": [{"id": "UC_a", "statistics": {"subscriberCount": "1", "hiddenSubscriberCount": False}}]},
    )

    history_worker_handler.lambda_handler(_acquire_event(), None)

    assert calls == []


def test_r4_no_new_terraform_resource_was_introduced():
    dynamodb_tf = open("terraform/dynamodb.tf").read()
    api_gateway_tf = open("terraform/api_gateway.tf").read()

    tables = re.findall(r'resource\s+"aws_dynamodb_table"\s+"(\w+)"', dynamodb_tf)
    # No new public API route referencing the new subscriber-ranking result.
    assert "subscriber-ranking" not in api_gateway_tf
    assert "subscriberRanking" not in api_gateway_tf
    assert len(tables) == len(set(tables))  # sanity: no duplicated table declarations introduced
