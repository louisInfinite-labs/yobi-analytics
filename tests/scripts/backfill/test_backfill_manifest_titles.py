"""Focused tests for scripts/backfill/backfill_manifest_titles.py (R8C):
one-time title-only manifest patch from Video Master, using the existing
ETag-conditional patch_shard mechanism -- never an unconditional full
tracking_manifest.publish_tracking_manifest rebuild.
"""

import importlib.util
import sys
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

_MODULE_PATH = Path(__file__).resolve().parents[3] / "scripts" / "backfill" / "backfill_manifest_titles.py"
_spec = importlib.util.spec_from_file_location("backfill_manifest_titles", _MODULE_PATH)
backfill_manifest_titles = importlib.util.module_from_spec(_spec)
sys.modules.setdefault("backfill_manifest_titles", backfill_manifest_titles)
_spec.loader.exec_module(backfill_manifest_titles)

from stores.dynamodb_store import CREATOR_ID_INDEX, VIDEO_MASTER_TABLE, upsert_videos  # noqa: E402
from stores.history_store import shard_for_video  # noqa: E402
from tracking.tracking_manifest import ManifestEntry, S3TrackingManifestStore, patch_shard  # noqa: E402
from tracking.video_master import Video  # noqa: E402

AWS_REGION = "ap-northeast-1"
BUCKET = "test-history-bucket"


@pytest.fixture
def env(aws_credentials, monkeypatch):
    """One moto context holding both YobiVideoMaster (DynamoDB) and the
    manifest bucket (S3) -- moto's mock_aws() mocks every AWS service at
    once, so both fit under one context the same way production has both
    backed by real AWS."""
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", BUCKET)
    with mock_aws():
        dynamodb_client = boto3.client("dynamodb", region_name=AWS_REGION)
        dynamodb_client.create_table(
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

        s3_client = boto3.client("s3", region_name=AWS_REGION)
        s3_client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": AWS_REGION})

        yield s3_client


def _manifest_store(s3_client) -> S3TrackingManifestStore:
    return S3TrackingManifestStore(BUCKET, s3_client=s3_client)


def test_dry_run_reports_counts_and_writes_nothing(env):
    upsert_videos([Video(video_id="v1", creator_id="c1", title="Real Title", published_at="2026-08-01T00:00:00Z")])
    store = _manifest_store(env)
    shard = shard_for_video("v1")
    store.write_shard(shard, [ManifestEntry("v1", "c1", True, topic="valorant", activity_state="Hot")])

    summary = backfill_manifest_titles.backfill_manifest_titles(execute=False)

    assert summary["entriesInspected"] == 1
    assert summary["entriesMissingTitle"] == 1
    assert summary["titlesAvailableInVideoMaster"] == 1
    assert summary["entriesPatchable"] == 1
    assert summary["entriesStillMissingTitle"] == 0
    assert summary["shardsPatched"] == 0

    entries = store.read_shard(shard)
    assert entries[0].title is None  # dry run performed zero writes


def test_execute_copies_title_from_video_master_into_the_manifest(env):
    upsert_videos([Video(video_id="v1", creator_id="c1", title="Real Title", published_at="2026-08-01T00:00:00Z")])
    store = _manifest_store(env)
    shard = shard_for_video("v1")
    store.write_shard(shard, [ManifestEntry("v1", "c1", True)])

    summary = backfill_manifest_titles.backfill_manifest_titles(execute=True)

    assert summary["shardsPatched"] == 1
    assert summary["affectedShards"] == [shard]
    entries = store.read_shard(shard)
    assert entries[0].title == "Real Title"


def test_a_missing_title_in_video_master_is_reported_but_left_none(env):
    """A manifest entry whose video_id no longer exists in Video Master (or
    whose Video Master record itself somehow has no title) is never given a
    fabricated title -- it stays None and is counted separately."""
    store = _manifest_store(env)
    shard = shard_for_video("ghost")
    store.write_shard(shard, [ManifestEntry("ghost", "c1", True)])

    summary = backfill_manifest_titles.backfill_manifest_titles(execute=True)

    assert summary["entriesStillMissingTitle"] == 1
    assert summary["entriesPatchable"] == 0
    entries = store.read_shard(shard)
    assert entries[0].title is None


def test_an_entry_that_already_has_a_title_is_left_untouched(env):
    upsert_videos([Video(video_id="v1", creator_id="c1", title="VideoMaster Title", published_at="2026-08-01T00:00:00Z")])
    store = _manifest_store(env)
    shard = shard_for_video("v1")
    store.write_shard(shard, [ManifestEntry("v1", "c1", True, title="Already Set")])

    summary = backfill_manifest_titles.backfill_manifest_titles(execute=True)

    assert summary["entriesMissingTitle"] == 0
    assert summary["shardsPatched"] == 0
    entries = store.read_shard(shard)
    assert entries[0].title == "Already Set"


def test_thumbnail_url_is_never_touched_by_this_backfill(env):
    """Thumbnail policy: this script only ever backfills title. An entry's
    existing thumbnail_url (whether null or already set) must be identical
    before and after, whether or not that entry's title got patched."""
    upsert_videos([Video(video_id="v1", creator_id="c1", title="Real Title", published_at="2026-08-01T00:00:00Z")])
    store = _manifest_store(env)
    shard = shard_for_video("v1")
    store.write_shard(shard, [ManifestEntry("v1", "c1", True, thumbnail_url=None)])

    backfill_manifest_titles.backfill_manifest_titles(execute=True)

    entries = store.read_shard(shard)
    assert entries[0].title == "Real Title"
    assert entries[0].thumbnail_url is None  # unchanged -- this backfill never sets it


def test_topic_activity_state_discovered_at_published_at_are_all_preserved(env):
    upsert_videos([Video(video_id="v1", creator_id="c1", title="Real Title", published_at="2026-08-01T00:00:00Z")])
    store = _manifest_store(env)
    shard = shard_for_video("v1")
    original = ManifestEntry(
        "v1",
        "c1",
        True,
        discovered_at="2026-07-01T00:00:00Z",
        published_at="2026-06-01T00:00:00Z",
        activity_state="Hot",
        topic="valorant",
    )
    store.write_shard(shard, [original])

    backfill_manifest_titles.backfill_manifest_titles(execute=True)

    [patched] = store.read_shard(shard)
    assert patched.discovered_at == original.discovered_at
    assert patched.published_at == original.published_at
    assert patched.activity_state == original.activity_state
    assert patched.topic == original.topic
    assert patched.title == "Real Title"


def test_a_shard_with_nothing_patchable_is_never_written_to(env):
    """A shard whose every entry already has a title (or has none available
    in Video Master either) must not be patched at all -- affectedShards
    only lists shards that actually needed a write."""
    store = _manifest_store(env)
    shard = shard_for_video("v1")
    store.write_shard(shard, [ManifestEntry("v1", "c1", True, title="Already Set")])

    summary = backfill_manifest_titles.backfill_manifest_titles(execute=True)

    assert shard not in summary["affectedShards"]
    assert summary["shardsPatched"] == 0


def test_concurrent_discovery_patch_is_not_lost(env, monkeypatch):
    """A concurrent writer (mirroring collection.main's own incremental
    discovery patch, also built on patch_shard) that adds a brand-new entry
    to the same shard right after this backfill's own report-building read
    must not be lost -- patch_shard's own ETag-conditional retry loop is
    what makes two independent patch_shard callers converge safely, unlike
    an unconditional publish_tracking_manifest rebuild.

    Patches S3TrackingManifestStore.read_shard_for_patch at the CLASS level
    (not on one instance): backfill_manifest_titles.backfill_manifest_titles
    constructs its own store instance internally, so an instance-level
    monkeypatch on a test-local store object would never actually intercept
    the calls the function under test makes.
    """
    upsert_videos([Video(video_id="v1", creator_id="c1", title="Real Title", published_at="2026-08-01T00:00:00Z")])
    store = _manifest_store(env)
    shard = shard_for_video("v1")
    store.write_shard(shard, [ManifestEntry("v1", "c1", True)])

    # A "concurrently discovered" video that hashes to this exact same shard.
    new_video_id = next(f"new{i}" for i in range(1000) if shard_for_video(f"new{i}") == shard)

    original_read_shard_for_patch = S3TrackingManifestStore.read_shard_for_patch
    call_counts: dict[int, int] = {}

    def _read_with_injected_race(self, shard_arg):
        call_counts[shard_arg] = call_counts.get(shard_arg, 0) + 1
        if shard_arg == shard and call_counts[shard_arg] == 1:
            # Simulate a concurrent discovery patch landing on this exact
            # shard right after our own first read.
            patch_shard(store, shard_arg, lambda entries: entries + [ManifestEntry(new_video_id, "c1", True)])
        return original_read_shard_for_patch(self, shard_arg)

    monkeypatch.setattr(S3TrackingManifestStore, "read_shard_for_patch", _read_with_injected_race)

    backfill_manifest_titles.backfill_manifest_titles(execute=True)

    entries = {entry.video_id: entry for entry in store.read_shard(shard)}
    assert entries["v1"].title == "Real Title"
    assert new_video_id in entries  # the concurrent writer's own new entry survived, not overwritten away
