from datetime import date

import boto3
import pytest
from moto import mock_aws

import dynamodb_store
import read_api
from dynamodb_store import (
    CREATOR_ID_INDEX,
    RUN_SUMMARIES_TABLE,
    SNAPSHOTS_TABLE,
    TRENDING_CACHE_TABLE,
    VIDEO_MASTER_TABLE,
    get_cached_trending,
    save_daily_collection,
    upsert_videos,
)
from snapshot_store import Snapshot, SnapshotRunSummary
from video_master import Video

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
def dynamodb_tables(aws_credentials, monkeypatch):
    """Create the same production-shaped tables test_dynamodb_store.py does.

    Also forces read_api's own get_snapshot/get_video — which
    _compute_growth_results/_trending_response call by read_api's own
    module-global binding — to the real DynamoDB-backed versions, regardless
    of which backend read_api.py happened to resolve at its own first
    import in this test process (test_read_api.py's own suite deliberately
    exercises the JSON-backed import path, and Python caches that binding
    for the rest of the session once read_api has been imported once).
    """
    monkeypatch.setattr(read_api, "get_snapshot", dynamodb_store.get_snapshot)
    monkeypatch.setattr(read_api, "get_video", dynamodb_store.get_video)
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


def _snapshot(video_id: str, snapshot_date: str, view_count: int, creator_id: str = "aizawa_ema") -> Snapshot:
    return Snapshot(
        snapshot_date=snapshot_date,
        observed_at=f"{snapshot_date}T18:00:00+09:00",
        creator_id=creator_id,
        video_id=video_id,
        title=f"Video {video_id}",
        published_at="2026-08-20T00:00:00Z",
        view_count=view_count,
        organization="vspo",
    )


def _seed_videos_and_snapshots(entries: list[tuple[str, str, int, int]]) -> None:
    """Write each (video_id, creator_id, older_views, newer_views) entry's Video Master record, then
    write every entry's two days of snapshots (comparison_date, report_date) in one shared collection
    per date — save_daily_collection's exclusive-create is keyed only by date, so multiple entries
    sharing the same two dates must be written together, not via repeated per-video calls."""
    upsert_videos(
        [
            Video(video_id=video_id, creator_id=creator_id, title=f"Video {video_id}", published_at="2026-08-20T00:00:00Z")
            for video_id, creator_id, _older, _newer in entries
        ]
    )
    save_daily_collection(
        [_snapshot(video_id, "2026-08-31", older_views, creator_id=creator_id) for video_id, creator_id, older_views, _newer in entries],
        SnapshotRunSummary(snapshot_date="2026-08-31", requested_count=len(entries), collected_count=len(entries), skipped=[]),
        date(2026, 8, 31),
    )
    save_daily_collection(
        [_snapshot(video_id, "2026-09-01", newer_views, creator_id=creator_id) for video_id, creator_id, _older, newer_views in entries],
        SnapshotRunSummary(snapshot_date="2026-09-01", requested_count=len(entries), collected_count=len(entries), skipped=[]),
        date(2026, 9, 1),
    )


def test_run_caches_a_creators_trending_for_every_period(dynamodb_tables, monkeypatch):
    """After run(), a live get_creator_trending-shaped cache entry exists for the 1d scope."""
    monkeypatch.setattr(
        "trending_precompute.load_creators",
        lambda: [_FakeCreator(creator_id="aizawa_ema", organization="vspo")],
    )
    _seed_videos_and_snapshots([("v1", "aizawa_ema", 100, 150)])

    import trending_precompute

    stats = trending_precompute.run(date(2026, 9, 1))

    assert stats["scopes_failed"] == 0
    cached = get_cached_trending("creator:aizawa_ema:1d:daily_trending:2026-09-01:Asia/Tokyo")
    assert cached is not None
    assert [entry["videoId"] for entry in cached["results"]] == ["v1"]


def test_run_with_a_single_period_only_caches_that_period(dynamodb_tables, monkeypatch):
    """Passing periods=("7d",) (one of the three EventBridge schedules) never touches 1d/30d
    cache keys — each schedule's own invocation must stay scoped to its own period."""
    monkeypatch.setattr(
        "trending_precompute.load_creators",
        lambda: [_FakeCreator(creator_id="aizawa_ema", organization="vspo")],
    )
    _seed_videos_and_snapshots([("v1", "aizawa_ema", 100, 150)])

    import trending_precompute

    stats = trending_precompute.run(date(2026, 9, 1), periods=("7d",))

    assert stats["scopes_failed"] == 0
    assert get_cached_trending("creator:aizawa_ema:7d:7d_trending:2026-09-01:Asia/Tokyo") is not None
    assert get_cached_trending("creator:aizawa_ema:1d:daily_trending:2026-09-01:Asia/Tokyo") is None
    assert get_cached_trending("creator:aizawa_ema:30d:30d_trending:2026-09-01:Asia/Tokyo") is None


def test_run_caches_an_organizations_trending_scoped_to_its_own_creators(dynamodb_tables, monkeypatch):
    """A video from a different organization's creator never leaks into another org's cached entry."""
    monkeypatch.setattr(
        "trending_precompute.load_creators",
        lambda: [
            _FakeCreator(creator_id="aizawa_ema", organization="vspo"),
            _FakeCreator(creator_id="other_org_creator", organization="hololive"),
        ],
    )
    _seed_videos_and_snapshots([("v1", "aizawa_ema", 100, 150), ("v_other", "other_org_creator", 1, 9999)])

    import trending_precompute

    trending_precompute.run(date(2026, 9, 1))

    cached = get_cached_trending("org:vspo:1d:daily_trending:2026-09-01:Asia/Tokyo")
    assert [entry["videoId"] for entry in cached["results"]] == ["v1"]


def test_run_continues_past_one_creators_failure(dynamodb_tables, monkeypatch):
    """One creator raising during precompute must not stop the rest of the run."""

    def _boom_get_videos_by_creator(creator_id):
        if creator_id == "broken_creator":
            raise RuntimeError("simulated DynamoDB failure")
        return []

    monkeypatch.setattr(
        "trending_precompute.load_creators",
        lambda: [
            _FakeCreator(creator_id="broken_creator", organization="vspo"),
            _FakeCreator(creator_id="aizawa_ema", organization="vspo"),
        ],
    )
    monkeypatch.setattr("trending_precompute.get_videos_by_creator", _boom_get_videos_by_creator)

    import trending_precompute

    stats = trending_precompute.run(date(2026, 9, 1))

    assert stats["scopes_failed"] > 0
    assert stats["scopes_written"] > 0


class _FakeCreator:
    """Minimal stand-in with just the fields trending_precompute.run actually reads."""

    def __init__(self, *, creator_id: str, organization: str):
        self.creator_id = creator_id
        self.organization = organization
