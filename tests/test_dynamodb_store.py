import threading
from datetime import date
from decimal import Decimal

import boto3
import pytest
from moto import mock_aws

from stores.dynamodb_store import (
    CREATOR_ID_INDEX,
    KNOWN_INCOMPLETE_LEGACY_DATES,
    RUN_SUMMARIES_TABLE,
    SNAPSHOTS_TABLE,
    TRENDING_CACHE_TABLE,
    VIDEO_MASTER_TABLE,
    get_cached_trending,
    get_snapshot,
    get_videos_by_creator,
    load_videos,
    put_cached_trending,
    save_daily_collection,
    save_run_summary,
    upsert_videos,
)
from stores.snapshot_store import SkippedVideo, Snapshot, SnapshotRunSummary, SnapshotStoreError
from tracking.video_master import Video, VideoMasterError

AWS_REGION = "ap-northeast-1"




@pytest.fixture
def dynamodb_tables(aws_credentials):
    """Create the three production-shaped tables inside moto's fully mocked DynamoDB."""
    with mock_aws():
        client = boto3.client("dynamodb", region_name=AWS_REGION)
        client.create_table(
            TableName=VIDEO_MASTER_TABLE,
            AttributeDefinitions=[
                {"AttributeName": "videoId", "AttributeType": "S"},
                {"AttributeName": "creatorId", "AttributeType": "S"},
            ],
            KeySchema=[{"AttributeName": "videoId", "KeyType": "HASH"}],
            GlobalSecondaryIndexes=[
                {
                    "IndexName": CREATOR_ID_INDEX,
                    "KeySchema": [{"AttributeName": "creatorId", "KeyType": "HASH"}],
                    "Projection": {"ProjectionType": "ALL"},
                }
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        client.create_table(
            TableName=SNAPSHOTS_TABLE,
            AttributeDefinitions=[
                {"AttributeName": "videoId", "AttributeType": "S"},
                {"AttributeName": "snapshotDate", "AttributeType": "S"},
            ],
            KeySchema=[
                {"AttributeName": "videoId", "KeyType": "HASH"},
                {"AttributeName": "snapshotDate", "KeyType": "RANGE"},
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        client.create_table(
            TableName=RUN_SUMMARIES_TABLE,
            AttributeDefinitions=[{"AttributeName": "snapshotDate", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "snapshotDate", "KeyType": "HASH"}],
            BillingMode="PAY_PER_REQUEST",
        )
        client.create_table(
            TableName=TRENDING_CACHE_TABLE,
            AttributeDefinitions=[{"AttributeName": "cacheKey", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "cacheKey", "KeyType": "HASH"}],
            BillingMode="PAY_PER_REQUEST",
        )
        yield


def _snapshot(video_id: str = "v1", snapshot_date: str = "2026-09-01") -> Snapshot:
    """Build a minimal valid Snapshot for a test, overriding only videoId/snapshotDate."""
    return Snapshot(
        snapshot_date=snapshot_date,
        observed_at="2026-09-01T18:00:00+09:00",
        creator_id="aizawa_ema",
        video_id=video_id,
        title="A",
        published_at="2026-08-20T00:00:00Z",
        view_count=100,
        organization="vspo",
    )


def _summary(snapshot_date: str = "2026-09-01", collected: int = 1, skipped=None) -> SnapshotRunSummary:
    """Build a SnapshotRunSummary whose requestedCount is derived to stay internally consistent."""
    skipped = skipped or []
    return SnapshotRunSummary(
        snapshot_date=snapshot_date,
        requested_count=collected + len(skipped),
        collected_count=collected,
        skipped=skipped,
    )


# --- Video Master --------------------------------------------------------


def test_load_videos_returns_empty_list_when_table_empty(dynamodb_tables):
    """An untouched table behaves like an empty Video Master."""
    assert load_videos() == []


def test_upsert_with_no_videos_is_a_no_op(dynamodb_tables):
    """Calling upsert_videos([]) does not error or write anything."""
    upsert_videos([])

    assert load_videos() == []


def test_upsert_and_load_round_trips_full_scheduler_state(dynamodb_tables):
    """A video's full scheduler state, including the velocity floats, survives
    a write/read round trip through DynamoDB (Decimal <-> float)."""
    video = Video(
        video_id="v1",
        creator_id="aizawa_ema",
        title="A",
        published_at="2026-08-20T00:00:00Z",
        activity_state="Hot",
        last_checked_at="2026-08-30T18:00:00+09:00",
        last_view_count=12345,
        snapshot_count=4,
        quiet_streak=1,
        last_classification_reason="strong_growth",
        last_percent_growth_per_day=20.0,
        last_avg_views_per_day=2000.0,
    )

    upsert_videos([video])

    assert load_videos() == [video]


def test_upsert_and_load_round_trips_bootstrap_defaults(dynamodb_tables):
    """A video with no scheduler state yet (all optional fields at their
    dataclass defaults, including the None velocity fields) round-trips too."""
    video = Video(video_id="v1", creator_id="aizawa_ema", title="A", published_at="2026-08-20T00:00:00Z")

    upsert_videos([video])

    assert load_videos() == [video]


@pytest.mark.parametrize("bad_value", [float("nan"), float("inf"), float("-inf")])
def test_upsert_rejects_non_finite_velocity_value(dynamodb_tables, bad_value):
    """A NaN/Infinity velocity float is rejected before DynamoDB's serializer
    would otherwise raise an uncaught TypeError building a non-finite Decimal."""
    video = Video(
        video_id="v1",
        creator_id="c1",
        title="A",
        published_at="2026-08-20T00:00:00Z",
        last_avg_views_per_day=bad_value,
    )

    with pytest.raises(VideoMasterError):
        upsert_videos([video])


def test_upsert_overwrites_existing_video_by_id(dynamodb_tables):
    """Upserting an existing video ID updates the record instead of duplicating it."""
    upsert_videos([Video(video_id="v1", creator_id="c1", title="Old", published_at="2026-08-20T00:00:00Z")])
    upsert_videos([Video(video_id="v1", creator_id="c1", title="New", published_at="2026-08-20T00:00:00Z")])

    loaded = load_videos()

    assert len(loaded) == 1
    assert loaded[0].title == "New"


def test_load_videos_returns_every_upserted_video(dynamodb_tables):
    """load_videos returns every video written, not just the first one.

    This does not exercise genuine multi-page Scan pagination (moto returns
    a handful of small items in a single page), only that the LastEvaluatedKey
    loop doesn't accidentally drop or truncate results for a normal-sized batch.
    """
    videos = [
        Video(video_id=f"v{i}", creator_id="c1", title=f"Video {i}", published_at="2026-08-20T00:00:00Z")
        for i in range(5)
    ]
    upsert_videos(videos)

    loaded = load_videos()

    assert {video.video_id for video in loaded} == {video.video_id for video in videos}


def test_get_videos_by_creator_returns_only_that_creators_videos(dynamodb_tables):
    """The GSI query never leaks another creator's videos into the result."""
    upsert_videos(
        [
            Video(video_id="v1", creator_id="c1", title="A", published_at="2026-08-20T00:00:00Z"),
            Video(video_id="v2", creator_id="c1", title="B", published_at="2026-08-20T00:00:00Z"),
            Video(video_id="v3", creator_id="c2", title="C", published_at="2026-08-20T00:00:00Z"),
        ]
    )

    assert {video.video_id for video in get_videos_by_creator("c1")} == {"v1", "v2"}
    assert {video.video_id for video in get_videos_by_creator("c2")} == {"v3"}


def test_get_videos_by_creator_returns_empty_list_for_unknown_creator(dynamodb_tables):
    """A creator with no videos yet returns [], not an error."""
    assert get_videos_by_creator("no_such_creator") == []


def test_get_videos_by_creator_returns_every_video_for_a_prolific_creator(dynamodb_tables):
    """Exact ranking must not lose later GSI pages before gain is known."""
    videos = [
        Video(video_id=f"v{i}", creator_id="prolific", title=f"Video {i}", published_at="2026-08-20T00:00:00Z")
        for i in range(550)
    ]
    upsert_videos(videos)

    result = get_videos_by_creator("prolific")

    assert len(result) == 550


# --- Trending cache ---------------------------------------------------------


def test_get_cached_trending_returns_none_for_a_missing_key(dynamodb_tables):
    """An unpopulated cache key is a clean miss, not an error."""
    assert get_cached_trending("no-such-key") is None


def test_put_then_get_cached_trending_round_trips_the_payload(dynamodb_tables):
    """A cached payload — including nested lists/dicts — survives the JSON round trip unchanged."""
    payload = {"organization": "vspo", "results": [{"rank": 1, "videoId": "v1", "value": 12.5}]}

    put_cached_trending("org:vspo:1d:daily_trending:2026-09-01:Asia/Tokyo", payload, computed_at="2026-09-01T18:00:00+09:00")

    assert get_cached_trending("org:vspo:1d:daily_trending:2026-09-01:Asia/Tokyo") == payload


def test_put_cached_trending_overwrites_an_existing_key(dynamodb_tables):
    """Re-running the precompute job for the same key replaces yesterday's cached entry, not duplicates it."""
    key = "creator:aizawa_ema:1d:daily_trending:2026-09-01:Asia/Tokyo"
    put_cached_trending(key, {"results": ["old"]}, computed_at="2026-09-01T18:00:00+09:00")

    put_cached_trending(key, {"results": ["new"]}, computed_at="2026-09-02T18:00:00+09:00")

    assert get_cached_trending(key) == {"results": ["new"]}


# --- Snapshots + run summaries --------------------------------------------


def test_save_daily_collection_writes_snapshots_and_summary(dynamodb_tables):
    """Both the snapshot items and the run summary land in their own tables."""
    snapshots = [_snapshot(video_id="v1"), _snapshot(video_id="v2")]
    summary = _summary(collected=2)

    snapshot_dest, summary_dest = save_daily_collection(snapshots, summary, date(2026, 9, 1))

    assert SNAPSHOTS_TABLE in snapshot_dest
    assert RUN_SUMMARIES_TABLE in summary_dest

    resource = boto3.resource("dynamodb", region_name=AWS_REGION)
    snapshot_items = resource.Table(SNAPSHOTS_TABLE).scan()["Items"]
    assert len(snapshot_items) == 2

    summary_item = resource.Table(RUN_SUMMARIES_TABLE).get_item(Key={"snapshotDate": "2026-09-01"})["Item"]
    assert summary_item["collectedCount"] == 2


def test_get_snapshot_returns_none_when_no_item_exists(dynamodb_tables):
    """A (videoId, snapshotDate) with no item at all returns None, not an error."""
    assert get_snapshot("v1", date(2026, 9, 1)) is None


def test_get_snapshot_returns_none_for_a_video_not_in_that_days_collection(dynamodb_tables):
    """A missing video on an otherwise-recorded date is None, not KeyError —
    the caller (Roadmap 3.1) decides what that means (pending vs. not available)."""
    save_daily_collection([_snapshot(video_id="v1")], _summary(collected=1), date(2026, 9, 1))

    assert get_snapshot("v2", date(2026, 9, 1)) is None


def test_get_snapshot_round_trips_view_count_as_int_not_decimal(dynamodb_tables):
    """viewCount must come back as a plain int (DynamoDB's Number type has no
    int/float distinction — boto3 returns Decimal on read unless converted)."""
    save_daily_collection([_snapshot(video_id="v1")], _summary(collected=1), date(2026, 9, 1))

    found = get_snapshot("v1", date(2026, 9, 1))

    assert found is not None
    assert found.video_id == "v1"
    assert isinstance(found.view_count, int)


def test_get_snapshot_rejects_a_fractional_decimal_view_count(dynamodb_tables):
    """A fractional Decimal viewCount (data corruption — this field should
    always be a whole number) must be rejected, not silently truncated."""
    resource = boto3.resource("dynamodb", region_name=AWS_REGION)
    resource.Table(SNAPSHOTS_TABLE).put_item(
        Item={
            "snapshotDate": "2026-09-01",
            "observedAt": "2026-09-01T18:00:05+09:00",
            "creatorId": "aizawa_ema",
            "videoId": "v1",
            "title": "A",
            "publishedAt": "2026-08-20T00:00:00Z",
            "viewCount": Decimal("100.7"),
            "organization": "vspo",
        }
    )

    with pytest.raises(SnapshotStoreError):
        get_snapshot("v1", date(2026, 9, 1))


def test_save_daily_collection_rejects_duplicate_date(dynamodb_tables):
    """A second collection run for an already-recorded date is refused, matching
    the JSON store's exclusive-create behavior for same-day retries."""
    save_daily_collection([_snapshot()], _summary(collected=1), date(2026, 9, 1))

    with pytest.raises(FileExistsError):
        save_daily_collection([_snapshot()], _summary(collected=1), date(2026, 9, 1))


def test_save_daily_collection_leaves_original_snapshots_untouched_on_duplicate(dynamodb_tables):
    """A rejected duplicate-date retry must not corrupt or add to the data
    already written for that date."""
    save_daily_collection([_snapshot(video_id="v1")], _summary(collected=1), date(2026, 9, 1))

    with pytest.raises(FileExistsError):
        save_daily_collection(
            [_snapshot(video_id="v1"), _snapshot(video_id="v2")], _summary(collected=2), date(2026, 9, 1)
        )

    resource = boto3.resource("dynamodb", region_name=AWS_REGION)
    snapshot_items = resource.Table(SNAPSHOTS_TABLE).scan()["Items"]
    assert len(snapshot_items) == 1


def test_save_daily_collection_rejects_mismatched_snapshot_date(dynamodb_tables):
    """A Snapshot whose own snapshotDate doesn't match the requested date is rejected
    before anything is written."""
    with pytest.raises(SnapshotStoreError):
        save_daily_collection([_snapshot(snapshot_date="2026-08-31")], _summary(), date(2026, 9, 1))

    resource = boto3.resource("dynamodb", region_name=AWS_REGION)
    assert resource.Table(SNAPSHOTS_TABLE).scan()["Items"] == []
    assert resource.Table(RUN_SUMMARIES_TABLE).scan()["Items"] == []


def test_save_daily_collection_rejects_duplicate_video_id(dynamodb_tables):
    """Two snapshots for the same videoId in one call would silently collapse
    into a single DynamoDB item (same key), masking a bug where a video was
    double-processed within the same run."""
    with pytest.raises(SnapshotStoreError):
        save_daily_collection(
            [_snapshot(video_id="v1"), _snapshot(video_id="v1")], _summary(collected=2), date(2026, 9, 1)
        )

    resource = boto3.resource("dynamodb", region_name=AWS_REGION)
    assert resource.Table(SNAPSHOTS_TABLE).scan()["Items"] == []
    assert resource.Table(RUN_SUMMARIES_TABLE).scan()["Items"] == []


def test_save_daily_collection_rejects_collected_count_mismatch(dynamodb_tables):
    """summary.collectedCount must match the actual number of snapshots provided,
    or the persisted summary would misreport what was actually collected."""
    with pytest.raises(SnapshotStoreError):
        save_daily_collection([_snapshot(video_id="v1")], _summary(collected=2), date(2026, 9, 1))


def test_save_daily_collection_rejects_requested_count_arithmetic_mismatch(dynamodb_tables):
    """requestedCount must equal collectedCount + len(skipped) — an inconsistent
    summary would misrepresent the day's actual completeness."""
    bad_summary = SnapshotRunSummary(snapshot_date="2026-09-01", requested_count=5, collected_count=1, skipped=[])

    with pytest.raises(SnapshotStoreError):
        save_daily_collection([_snapshot(video_id="v1")], bad_summary, date(2026, 9, 1))


def test_save_daily_collection_rejects_duplicate_skipped_video_id(dynamodb_tables):
    """Two SkippedVideo entries for the same videoId would make the persisted
    summary internally inconsistent about how many distinct videos were
    actually skipped, even though the raw counts might still add up."""
    bad_summary = SnapshotRunSummary(
        snapshot_date="2026-09-01",
        requested_count=3,
        collected_count=1,
        skipped=[
            SkippedVideo(video_id="v2", reason="a"),
            SkippedVideo(video_id="v2", reason="b"),
        ],
    )

    with pytest.raises(SnapshotStoreError):
        save_daily_collection([_snapshot(video_id="v1")], bad_summary, date(2026, 9, 1))


def test_save_daily_collection_rejects_video_id_both_collected_and_skipped(dynamodb_tables):
    """A videoId reported as both collected (has a snapshot) and skipped would
    let the persisted summary contradict itself about that video's outcome,
    even though collectedCount/requestedCount arithmetic alone wouldn't catch it."""
    bad_summary = SnapshotRunSummary(
        snapshot_date="2026-09-01",
        requested_count=2,
        collected_count=1,
        skipped=[SkippedVideo(video_id="v1", reason="malformed item")],
    )

    with pytest.raises(SnapshotStoreError):
        save_daily_collection([_snapshot(video_id="v1")], bad_summary, date(2026, 9, 1))


def test_save_run_summary_standalone(dynamodb_tables):
    """save_run_summary alone (no snapshots) records a fully-failed run's completeness."""
    summary = _summary(collected=0, skipped=[SkippedVideo(video_id="v1", reason="YouTube API failure")])

    save_run_summary(summary, date(2026, 9, 1))

    resource = boto3.resource("dynamodb", region_name=AWS_REGION)
    item = resource.Table(RUN_SUMMARIES_TABLE).get_item(Key={"snapshotDate": "2026-09-01"})["Item"]
    assert item["skippedCount"] == 1
    assert item["skipped"][0]["reason"] == "YouTube API failure"


def test_save_run_summary_standalone_is_immediately_complete(dynamodb_tables):
    """The zero-snapshot bootstrap path has nothing to protect against a
    mid-write timeout — it must be COMPLETE the instant it succeeds, and a
    later collection attempt for the same date must be rejected, exactly
    like a normal successful save_daily_collection would be (item 7:
    existing behavior stays compatible; item 6: a completed date stays
    protected)."""
    save_run_summary(_summary(collected=0, skipped=[SkippedVideo(video_id="v1", reason="x")]), date(2026, 9, 1))

    resource = boto3.resource("dynamodb", region_name=AWS_REGION)
    item = resource.Table(RUN_SUMMARIES_TABLE).get_item(Key={"snapshotDate": "2026-09-01"})["Item"]
    assert item["status"] == "COMPLETE"

    with pytest.raises(FileExistsError):
        save_daily_collection([_snapshot(video_id="v1")], _summary(collected=1), date(2026, 9, 1))


def test_save_run_summary_rejects_duplicate_date(dynamodb_tables):
    """A second summary for an already-recorded, COMPLETE date is refused."""
    save_run_summary(_summary(), date(2026, 9, 1))

    with pytest.raises(FileExistsError):
        save_run_summary(_summary(), date(2026, 9, 1))


def test_normal_successful_collection_ends_up_complete(dynamodb_tables):
    """The ordinary happy path (item 7): a clean, uninterrupted
    save_daily_collection call ends with status COMPLETE, not merely a row
    existing — proving the new two-phase write doesn't change behavior for
    the common case."""
    save_daily_collection(
        [_snapshot(video_id="v1"), _snapshot(video_id="v2")], _summary(collected=2), date(2026, 9, 1)
    )

    resource = boto3.resource("dynamodb", region_name=AWS_REGION)
    item = resource.Table(RUN_SUMMARIES_TABLE).get_item(Key={"snapshotDate": "2026-09-01"})["Item"]
    assert item["status"] == "COMPLETE"
    assert item["collectedCount"] == 2


def _fail_on_nth_snapshot(monkeypatch, n: int):
    """Make the batch write raise a ClientError partway through, simulating
    the uncatchable-timeout scenario at the DynamoDB-item-boundary level:
    everything up to (not including) the nth snapshot is really written,
    the rest never are, and nothing here gets a chance to clean up (which is
    exactly the point being tested — nothing should try to)."""
    from stores import dynamodb_store
    from botocore.exceptions import ClientError

    real_snapshot_to_raw = dynamodb_store._snapshot_to_raw
    call_count = {"n": 0}

    def _maybe_failing_snapshot_to_raw(snapshot):
        call_count["n"] += 1
        if call_count["n"] == n:
            raise ClientError({"Error": {"Code": "InternalServerError", "Message": "boom"}}, "PutItem")
        return real_snapshot_to_raw(snapshot)

    monkeypatch.setattr(dynamodb_store, "_snapshot_to_raw", _maybe_failing_snapshot_to_raw)


def test_partial_write_leaves_in_progress_state_that_a_retry_can_recover(dynamodb_tables, monkeypatch):
    """This is the 2026-09-14 production incident, reproduced: a batch write
    fails partway through (items 1 and 2), and neither the partial snapshot
    rows nor the IN_PROGRESS run summary are deleted (item 1's setup). A
    retry with the *complete* original list must then be able to finish the
    date (items 1, 2) and end with exactly one row per videoId — no
    duplicates from the earlier partial attempt (items 3, 5)."""
    _fail_on_nth_snapshot(monkeypatch, n=3)

    with pytest.raises(SnapshotStoreError):
        save_daily_collection(
            [_snapshot(video_id="v1"), _snapshot(video_id="v2"), _snapshot(video_id="v3")],
            _summary(collected=3),
            date(2026, 9, 1),
        )

    resource = boto3.resource("dynamodb", region_name=AWS_REGION)
    # Nothing was deleted: the reservation and the two snapshots that did
    # make it through the batch writer before the failure are still there.
    summary_item = resource.Table(RUN_SUMMARIES_TABLE).get_item(Key={"snapshotDate": "2026-09-01"})["Item"]
    assert summary_item["status"] == "IN_PROGRESS"
    assert len(resource.Table(SNAPSHOTS_TABLE).scan()["Items"]) == 2

    # A retry with the complete list (not just the missing one) must succeed
    # -- existing partial state does not permanently block it.
    save_daily_collection(
        [_snapshot(video_id="v1"), _snapshot(video_id="v2"), _snapshot(video_id="v3")],
        _summary(collected=3),
        date(2026, 9, 1),
    )

    summary_item = resource.Table(RUN_SUMMARIES_TABLE).get_item(Key={"snapshotDate": "2026-09-01"})["Item"]
    assert summary_item["status"] == "COMPLETE"
    assert summary_item["collectedCount"] == 3
    snapshot_items = resource.Table(SNAPSHOTS_TABLE).scan()["Items"]
    # Exactly one logical row per (videoId, snapshotDate) -- no duplicates
    # left behind from the interrupted first attempt.
    assert sorted(item["videoId"] for item in snapshot_items) == ["v1", "v2", "v3"]


def test_run_summary_is_not_complete_until_every_snapshot_is_actually_written(dynamodb_tables, monkeypatch):
    """Item 4: a row existing (even with the "right" collectedCount already
    on it) must never be mistaken for the date being done -- only status
    tells the truth about whether persistence actually finished."""
    _fail_on_nth_snapshot(monkeypatch, n=2)

    with pytest.raises(SnapshotStoreError):
        save_daily_collection([_snapshot(video_id="v1"), _snapshot(video_id="v2")], _summary(collected=2), date(2026, 9, 1))

    resource = boto3.resource("dynamodb", region_name=AWS_REGION)
    summary_item = resource.Table(RUN_SUMMARIES_TABLE).get_item(Key={"snapshotDate": "2026-09-01"})["Item"]
    # The row already carries the full intended collectedCount from the
    # claim step -- exactly the misleading state that caused the real
    # incident. status is what must actually gate completeness.
    assert summary_item["collectedCount"] == 2
    assert summary_item["status"] == "IN_PROGRESS"


def test_retry_after_full_write_but_before_completion_mark_is_still_idempotent(dynamodb_tables, monkeypatch):
    """Covers the narrower timeout window (task F.3): every snapshot was
    actually written, but the process was killed before
    _mark_run_summary_complete ever ran. A retry must still succeed and must
    not create duplicate rows, even though nothing was actually missing."""
    from stores import dynamodb_store

    def _simulate_kill_before_completion(snapshot_date):
        raise SnapshotStoreError("simulated kill before completion")

    monkeypatch.setattr(dynamodb_store, "_mark_run_summary_complete", _simulate_kill_before_completion)
    with pytest.raises(SnapshotStoreError):
        save_daily_collection(
            [_snapshot(video_id="v1"), _snapshot(video_id="v2")], _summary(collected=2), date(2026, 9, 1)
        )

    resource = boto3.resource("dynamodb", region_name=AWS_REGION)
    assert resource.Table(RUN_SUMMARIES_TABLE).get_item(Key={"snapshotDate": "2026-09-01"})["Item"]["status"] == "IN_PROGRESS"
    assert len(resource.Table(SNAPSHOTS_TABLE).scan()["Items"]) == 2

    monkeypatch.undo()
    save_daily_collection(
        [_snapshot(video_id="v1"), _snapshot(video_id="v2")], _summary(collected=2), date(2026, 9, 1)
    )

    summary_item = resource.Table(RUN_SUMMARIES_TABLE).get_item(Key={"snapshotDate": "2026-09-01"})["Item"]
    assert summary_item["status"] == "COMPLETE"
    snapshot_items = resource.Table(SNAPSHOTS_TABLE).scan()["Items"]
    assert sorted(item["videoId"] for item in snapshot_items) == ["v1", "v2"]


def test_known_incomplete_legacy_date_with_no_status_field_is_still_retryable(dynamodb_tables):
    """The one real, confirmed-incomplete row this fix exists to unblock
    (2026-09-14) has no `status` attribute at all, predating this fix. It
    must remain retryable via the explicit KNOWN_INCOMPLETE_LEGACY_DATES
    allowlist -- otherwise deploying this fix would do nothing for the very
    incident it was written to solve."""
    known_incomplete_date = sorted(KNOWN_INCOMPLETE_LEGACY_DATES)[0]
    resource = boto3.resource("dynamodb", region_name=AWS_REGION)
    resource.Table(RUN_SUMMARIES_TABLE).put_item(
        Item={
            "snapshotDate": known_incomplete_date,
            "requestedCount": 1,
            "collectedCount": 1,
            "skippedCount": 0,
            "skipped": [],
            # deliberately no "status" key
        }
    )

    save_daily_collection(
        [_snapshot(video_id="v1", snapshot_date=known_incomplete_date)],
        _summary(snapshot_date=known_incomplete_date, collected=1),
        date.fromisoformat(known_incomplete_date),
    )

    summary_item = resource.Table(RUN_SUMMARIES_TABLE).get_item(Key={"snapshotDate": known_incomplete_date})["Item"]
    assert summary_item["status"] == "COMPLETE"


def test_other_legacy_date_with_no_status_field_is_not_retryable(dynamodb_tables):
    """A pre-fix row for a date that is NOT on the known-incomplete allowlist
    (standing in for 2026-08-30 through 2026-09-13, each individually
    confirmed complete during the T2.7 backfill scan) must be treated as
    already COMPLETE by default -- treating every status-missing row as
    retryable would let already-correct historical dates be silently
    reclaimed and overwritten by anything that still calls
    save_daily_collection with an explicit past date."""
    assert "2026-09-01" not in KNOWN_INCOMPLETE_LEGACY_DATES
    resource = boto3.resource("dynamodb", region_name=AWS_REGION)
    resource.Table(RUN_SUMMARIES_TABLE).put_item(
        Item={
            "snapshotDate": "2026-09-01",
            "requestedCount": 1,
            "collectedCount": 1,
            "skippedCount": 0,
            "skipped": [],
            # deliberately no "status" key -- a genuinely pre-fix, otherwise-good row
        }
    )

    with pytest.raises(FileExistsError):
        save_daily_collection([_snapshot(video_id="v1")], _summary(collected=1), date(2026, 9, 1))


def test_completed_date_still_rejects_a_fresh_duplicate_collection_attempt(dynamodb_tables):
    """Item 6: once a date is genuinely COMPLETE, a brand-new (not a retry of
    a failure) collection attempt for that same date must still be rejected
    -- the original exclusivity guarantee, now correctly gated on actual
    completion rather than on a row merely existing."""
    save_daily_collection([_snapshot(video_id="v1")], _summary(collected=1), date(2026, 9, 1))

    with pytest.raises(FileExistsError):
        save_daily_collection(
            [_snapshot(video_id="v1"), _snapshot(video_id="v2")], _summary(collected=2), date(2026, 9, 1)
        )

    resource = boto3.resource("dynamodb", region_name=AWS_REGION)
    assert len(resource.Table(SNAPSHOTS_TABLE).scan()["Items"]) == 1


def test_resource_is_cached_per_thread_not_shared_as_a_global_singleton(dynamodb_tables):
    """Boto3 Resource instances are documented as not thread-safe, so
    dynamodb_store._resource() must not hand every thread the same cached
    Resource object — only the calling thread's own cached one."""
    from stores import dynamodb_store

    first_call = dynamodb_store._resource()
    second_call = dynamodb_store._resource()
    assert first_call is second_call  # cached within the same thread

    other_thread_resource: list = []
    thread = threading.Thread(target=lambda: other_thread_resource.append(dynamodb_store._resource()))
    thread.start()
    thread.join()

    assert other_thread_resource[0] is not first_call
