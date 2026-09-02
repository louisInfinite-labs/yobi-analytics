from datetime import date

import boto3
import pytest
from moto import mock_aws

from dynamodb_store import (
    RUN_SUMMARIES_TABLE,
    SNAPSHOTS_TABLE,
    VIDEO_MASTER_TABLE,
    load_videos,
    save_daily_collection,
    save_run_summary,
    upsert_videos,
)
from snapshot_store import SkippedVideo, Snapshot, SnapshotRunSummary, SnapshotStoreError
from video_master import Video, VideoMasterError

AWS_REGION = "ap-northeast-1"


@pytest.fixture(autouse=True)
def aws_credentials(monkeypatch):
    """moto still requires boto3 to resolve *some* credentials; these never reach real AWS."""
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_SECURITY_TOKEN", "testing")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", AWS_REGION)


@pytest.fixture
def dynamodb_tables(aws_credentials):
    """Create the three production-shaped tables inside moto's fully mocked DynamoDB."""
    with mock_aws():
        client = boto3.client("dynamodb", region_name=AWS_REGION)
        client.create_table(
            TableName=VIDEO_MASTER_TABLE,
            AttributeDefinitions=[{"AttributeName": "videoId", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "videoId", "KeyType": "HASH"}],
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
        yield


def _snapshot(video_id: str = "v1", snapshot_date: str = "2026-09-01") -> Snapshot:
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


def test_save_run_summary_standalone(dynamodb_tables):
    """save_run_summary alone (no snapshots) records a fully-failed run's completeness."""
    summary = _summary(collected=0, skipped=[SkippedVideo(video_id="v1", reason="YouTube API failure")])

    save_run_summary(summary, date(2026, 9, 1))

    resource = boto3.resource("dynamodb", region_name=AWS_REGION)
    item = resource.Table(RUN_SUMMARIES_TABLE).get_item(Key={"snapshotDate": "2026-09-01"})["Item"]
    assert item["skippedCount"] == 1
    assert item["skipped"][0]["reason"] == "YouTube API failure"


def test_save_daily_collection_rolls_back_run_summary_on_snapshot_write_failure(dynamodb_tables, monkeypatch):
    """If the snapshot batch write fails partway through, the reserved run
    summary is rolled back so a retry for that date is not permanently
    blocked by a completion marker for data that was never fully written."""
    import dynamodb_store
    from botocore.exceptions import ClientError

    real_snapshot_to_raw = dynamodb_store._snapshot_to_raw
    call_count = {"n": 0}

    def _failing_snapshot_to_raw(snapshot):
        call_count["n"] += 1
        if call_count["n"] == 2:
            raise ClientError({"Error": {"Code": "InternalServerError", "Message": "boom"}}, "PutItem")
        return real_snapshot_to_raw(snapshot)

    monkeypatch.setattr(dynamodb_store, "_snapshot_to_raw", _failing_snapshot_to_raw)

    with pytest.raises(SnapshotStoreError):
        save_daily_collection(
            [_snapshot(video_id="v1"), _snapshot(video_id="v2"), _snapshot(video_id="v3")],
            _summary(collected=3),
            date(2026, 9, 1),
        )

    resource = boto3.resource("dynamodb", region_name=AWS_REGION)
    assert "Item" not in resource.Table(RUN_SUMMARIES_TABLE).get_item(Key={"snapshotDate": "2026-09-01"})

    # The rollback must actually unblock a retry, not just delete-and-still-fail.
    save_daily_collection([_snapshot(video_id="v1")], _summary(collected=1), date(2026, 9, 1))
    summary_item = resource.Table(RUN_SUMMARIES_TABLE).get_item(Key={"snapshotDate": "2026-09-01"})["Item"]
    assert summary_item["collectedCount"] == 1


def test_save_run_summary_rejects_duplicate_date(dynamodb_tables):
    """A second summary for an already-recorded date is refused."""
    save_run_summary(_summary(), date(2026, 9, 1))

    with pytest.raises(FileExistsError):
        save_run_summary(_summary(), date(2026, 9, 1))
