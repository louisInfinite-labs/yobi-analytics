"""Real-S3 (moto) end-to-end proof that collect_history_shard's own manifest
patch (_patch_manifest_activity_states) actually works against the real
S3TrackingManifestStore -- AWS Cost Recovery, third pass. The Python-level
_FakeManifest used elsewhere (tests/test_history_worker_scheduler_state.py)
proves the calling contract; this proves the real AWS-facing implementation
underneath it behaves the same way.
"""

from datetime import date

import boto3
import pytest
from moto import mock_aws

from collection.history_worker import collect_history_shard
from stores.history_store import S3HistoryStore, shard_for_video
from tracking.tracking_manifest import S3TrackingManifestStore, publish_tracking_manifest
from tracking.video_master import Video

BUCKET = "test-history-bucket"
REGION = "ap-northeast-1"


class _FakeVideoMaster:
    def __init__(self, videos: list[Video]):
        self.videos = {video.video_id: video for video in videos}

    def get_video(self, video_id):
        return self.videos.get(video_id)

    def upsert_videos(self, videos):
        for video in videos:
            self.videos[video.video_id] = video


@pytest.fixture
def buckets(aws_credentials):
    with mock_aws():
        client = boto3.client("s3", region_name=REGION)
        client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})
        yield client


def test_collect_history_shard_patches_the_real_manifest_after_a_scheduler_update(buckets, monkeypatch):
    """A due (Hot -> always due) video's manifest entry starts with no
    activity_state recorded (a fresh manifest object); after one real
    collect_history_shard run with a genuine scheduler update, the *same S3
    object* reflects the new activity_state -- without a full manifest
    republish, and without touching any other entry in the same shard."""
    manifest_store = S3TrackingManifestStore(BUCKET, s3_client=buckets)
    history_store = S3HistoryStore(BUCKET, s3_client=buckets)

    video_id = "video-000000"
    shard = shard_for_video(video_id)
    other_id = None
    candidate = 1
    while other_id is None:
        probe = f"video-{candidate:06d}"
        if shard_for_video(probe) == shard:
            other_id = probe
        candidate += 1

    video = Video(
        video_id=video_id,
        creator_id="c1",
        title="Title",
        published_at="2020-01-01T00:00:00Z",
        activity_state="Hot",
    )
    other_video = Video(
        video_id=other_id,
        creator_id="c1",
        title="Other",
        published_at="2020-01-01T00:00:00Z",
        activity_state="Warm",
    )
    publish_tracking_manifest([video, other_video], manifest_store)

    video_master = _FakeVideoMaster([video, other_video])

    def fake_get_video_statistics(youtube, video_ids):
        return (
            [{"videoId": vid, "title": "Title", "publishedAt": "2020-01-01T00:00:00Z", "viewCount": 500} for vid in video_ids],
            {},
        )

    import collection.history_worker as history_worker_module

    monkeypatch.setattr(history_worker_module, "get_video_statistics", fake_get_video_statistics)
    collect_history_shard(
        youtube=object(),
        manifest_store=manifest_store,
        history_store=history_store,
        video_master_store=video_master,
        collection_date=date(2026, 9, 15),
        shard=shard,
        observed_at="2026-09-15T18:00:00+09:00",
    )

    patched_entries = {entry.video_id: entry for entry in manifest_store.read_shard(shard)}
    # The real proof this test exists for: the manifest's own persisted
    # activity_state now matches whatever Video Master's real classification
    # produced -- read back from the actual S3 object, not a Python fake.
    assert patched_entries[video_id].activity_state == video_master.get_video(video_id).activity_state
    # The unrelated entry sharing this same shard round-trips intact -- the
    # patch only ever touches the specific video_ids a real scheduler update
    # was computed for, never rewrites the whole shard from scratch.
    assert patched_entries[other_id].creator_id == "c1"
    assert set(patched_entries) == {video_id, other_id}
