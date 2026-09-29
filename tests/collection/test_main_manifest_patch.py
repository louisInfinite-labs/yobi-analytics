"""Real-S3 (moto) integration tests for the manifest side of AWS Cost Recovery's
third pass: collection.main._known_ids_by_creator and
_patch_manifest_with_new_videos_if_configured -- proving discovery's own known-
ids derivation and new-video manifest patch actually work end to end against a
real S3-backed tracking manifest, never a full-catalog VideoMaster Scan.
"""

import boto3
import pytest
from moto import mock_aws

from collection import main as main_module
from stores.history_store import shard_for_video
from tracking.tracking_manifest import ManifestEntry, S3TrackingManifestStore, publish_tracking_manifest
from tracking.video_master import Video

BUCKET = "test-history-bucket"
REGION = "ap-northeast-1"


def _video(video_id: str, creator_id: str = "c1", **overrides) -> Video:
    fields = {
        "video_id": video_id,
        "creator_id": creator_id,
        "title": f"Video {video_id}",
        "published_at": "2026-08-01T00:00:00Z",
    }
    fields.update(overrides)
    return Video(**fields)


@pytest.fixture
def manifest_bucket(aws_credentials, monkeypatch):
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", BUCKET)
    with mock_aws():
        client = boto3.client("s3", region_name=REGION)
        client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})
        yield S3TrackingManifestStore(BUCKET, s3_client=client)


def test_known_ids_by_creator_reads_the_manifest_not_video_master(manifest_bucket, monkeypatch):
    """The whole point of this function: derive known ids from the S3 manifest
    (bounded shard reads) when configured, never from a VideoMaster Scan."""
    publish_tracking_manifest(
        [_video("v1", creator_id="c1"), _video("v2", creator_id="c2")], manifest_bucket
    )

    def _boom():
        raise AssertionError("load_videos (a VideoMaster Scan) must not be called when the manifest is configured")

    monkeypatch.setattr(main_module, "load_videos", _boom)

    result = main_module._known_ids_by_creator()

    assert result == {"c1": {"v1"}, "c2": {"v2"}}


def test_known_ids_by_creator_falls_back_to_video_master_when_no_bucket_is_configured(monkeypatch):
    """Local/manual development (no YOBI_HISTORY_BUCKET) has no manifest at all
    to read from -- this must still work, unchanged, from load_videos()."""
    monkeypatch.delenv("YOBI_HISTORY_BUCKET", raising=False)
    monkeypatch.setattr(main_module, "load_videos", lambda: [_video("v1", creator_id="c1")])

    assert main_module._known_ids_by_creator() == {"c1": {"v1"}}


def test_known_ids_by_creator_treats_a_shard_that_was_never_published_as_empty(manifest_bucket):
    """A brand-new environment (before the very first video was ever discovered
    for a given shard's own hash range) must not crash -- an unpublished shard
    reads back as simply having no known ids, not an error."""
    assert main_module._known_ids_by_creator() == {}


def test_patch_manifest_with_new_videos_adds_only_the_affected_shards(manifest_bucket):
    new_videos = [_video("new-1", creator_id="c1"), _video("new-2", creator_id="c2")]

    main_module._patch_manifest_with_new_videos_if_configured(new_videos)

    shard_1 = shard_for_video("new-1")
    shard_2 = shard_for_video("new-2")
    assert {entry.video_id for entry in manifest_bucket.read_shard(shard_1)} >= {"new-1"}
    assert {entry.video_id for entry in manifest_bucket.read_shard(shard_2)} >= {"new-2"}


def test_patch_manifest_with_new_videos_preserves_existing_entries_in_the_same_shard(manifest_bucket):
    existing = _video("existing", creator_id="c1", activity_state="Hot")
    publish_tracking_manifest([existing], manifest_bucket)
    shard = shard_for_video("existing")
    new_video = None
    # Find a new video id that lands in the exact same shard as "existing", so
    # this genuinely exercises merging into a non-empty shard.
    candidate = 0
    while new_video is None:
        video_id = f"new-{candidate:06d}"
        if shard_for_video(video_id) == shard:
            new_video = _video(video_id, creator_id="c1")
        candidate += 1

    main_module._patch_manifest_with_new_videos_if_configured([new_video])

    entries_by_id = {entry.video_id: entry for entry in manifest_bucket.read_shard(shard)}
    assert entries_by_id["existing"].activity_state == "Hot"
    assert new_video.video_id in entries_by_id


def test_patch_manifest_with_new_videos_never_regresses_an_already_tracked_video(manifest_bucket):
    """Race protection: if a video already exists in the shard by the time this
    patch actually applies (an overlapping concurrent discovery run believed it
    was new too), the existing entry -- with whatever real, evolved
    activity_state it already has -- must win, never be reset back to a fresh
    "Unknown" placeholder."""
    existing = _video("v1", creator_id="c1", activity_state="Cold")
    publish_tracking_manifest([existing], manifest_bucket)

    # A second discovery run's own view of "v1" as brand new -- activity_state
    # defaults to "Unknown" the way a genuinely fresh Video always does.
    rediscovered = _video("v1", creator_id="c1")
    assert rediscovered.activity_state == "Unknown"

    main_module._patch_manifest_with_new_videos_if_configured([rediscovered])

    shard = shard_for_video("v1")
    entry = next(entry for entry in manifest_bucket.read_shard(shard) if entry.video_id == "v1")
    assert entry.activity_state == "Cold"


def test_patch_manifest_with_new_videos_is_a_no_op_with_no_new_videos(manifest_bucket):
    main_module._patch_manifest_with_new_videos_if_configured([])

    # No shard was ever created.
    entries, version = manifest_bucket.read_shard_for_patch(0)
    assert entries == []
    assert version is None


def test_patch_manifest_with_new_videos_is_best_effort_when_not_configured(monkeypatch):
    monkeypatch.delenv("YOBI_HISTORY_BUCKET", raising=False)

    # Must not raise even though there is no manifest at all to patch.
    main_module._patch_manifest_with_new_videos_if_configured([_video("v1")])
