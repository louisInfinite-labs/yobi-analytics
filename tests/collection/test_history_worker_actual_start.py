"""F37: collect_history_shard captures a livestream's actualStartTime inside the scheduler update it already writes -- no extra
write, no re-write of an unchanged value -- and mirrors it onto the manifest entry (real S3 manifest via moto)."""

from datetime import date

import boto3
import pytest
from moto import mock_aws

import collection.history_worker as history_worker_module
from collection.history_worker import collect_history_shard, normalize_actual_start
from stores.history_store import S3HistoryStore, shard_for_video
from tracking.tracking_manifest import S3TrackingManifestStore, publish_tracking_manifest
from tracking.video_master import Video

BUCKET = "test-history-bucket"
REGION = "ap-northeast-1"
VIDEO_ID = "video-000000"
SHARD = shard_for_video(VIDEO_ID)


class _CountingVideoMaster:
    """In-memory Video Master that records every upsert batch, to prove how many writes an observation costs."""

    def __init__(self, videos):
        self.videos = {video.video_id: video for video in videos}
        self.upserts: list[list[str]] = []

    def get_video(self, video_id):
        return self.videos.get(video_id)

    def upsert_videos(self, videos):
        self.upserts.append([video.video_id for video in videos])
        for video in videos:
            self.videos[video.video_id] = video


@pytest.fixture
def s3(aws_credentials):
    with mock_aws():
        client = boto3.client("s3", region_name=REGION)
        client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})
        yield client


def _setup(s3, **video_fields):
    manifest_store = S3TrackingManifestStore(BUCKET, s3_client=s3)
    history_store = S3HistoryStore(BUCKET, s3_client=s3)
    video = Video(video_id=VIDEO_ID, creator_id="c1", title="T", published_at="2020-01-01T00:00:00Z", activity_state="Hot", **video_fields)
    publish_tracking_manifest([video], manifest_store)
    return manifest_store, history_store, _CountingVideoMaster([video])


def _observe(monkeypatch, stores, observation, day):
    manifest_store, history_store, master = stores
    monkeypatch.setattr(history_worker_module, "get_video_statistics", lambda youtube, ids: ([{**observation, "videoId": i} for i in ids], {}))
    collect_history_shard(
        youtube=object(),
        manifest_store=manifest_store,
        history_store=history_store,
        video_master_store=master,
        collection_date=day,
        shard=SHARD,
        observed_at=f"{day.isoformat()}T18:00:00+09:00",
    )


_COMPLETED = {"title": "T", "publishedAt": "2020-01-01T09:00:00Z", "viewCount": 10, "contentType": "live", "liveStatus": "completed"}


def test_first_observation_stores_the_start_in_the_existing_update_and_the_manifest(s3, monkeypatch):
    """The start rides in the one scheduler upsert the observation already makes, normalized to +00:00, and the manifest mirrors it."""
    stores = _setup(s3)
    _observe(monkeypatch, stores, {**_COMPLETED, "actualStartTime": "2026-09-14T15:30:00Z"}, date(2026, 9, 15))

    manifest_store, _history, master = stores
    assert master.get_video(VIDEO_ID).actual_start_at == "2026-09-14T15:30:00+00:00"
    assert master.upserts == [[VIDEO_ID]]  # exactly the one write per observed video that existed before F37
    assert {e.video_id: e for e in manifest_store.read_shard(SHARD)}[VIDEO_ID].actual_start_at == "2026-09-14T15:30:00+00:00"


def test_a_stored_start_is_never_replaced_and_costs_no_extra_write(s3, monkeypatch):
    """Re-observing the stream (even with a different reported time) keeps the stored start; the write count is unchanged."""
    stores = _setup(s3, content_type="live", live_status="completed", actual_start_at="2026-09-14T15:30:00+00:00")
    _observe(monkeypatch, stores, {**_COMPLETED, "actualStartTime": "2026-09-14T15:30:00Z"}, date(2026, 9, 15))
    _observe(monkeypatch, stores, {**_COMPLETED, "actualStartTime": "2026-09-14T16:45:00Z"}, date(2026, 9, 16))

    _manifest, _history, master = stores
    assert master.get_video(VIDEO_ID).actual_start_at == "2026-09-14T15:30:00+00:00"
    assert master.upserts == [[VIDEO_ID], [VIDEO_ID]]  # one scheduler write per observation, none added for F37


def test_an_observation_without_a_start_leaves_it_unknown(s3, monkeypatch):
    """No actualStartTime in the observation -> the field stays None (never filled from publishedAt)."""
    stores = _setup(s3)
    _observe(monkeypatch, stores, _COMPLETED, date(2026, 9, 15))

    assert stores[2].get_video(VIDEO_ID).actual_start_at is None


def test_an_upload_never_records_a_start(s3, monkeypatch):
    """Only a livestream owns an actual start; an upload (e.g. a Premiere) that reports one still stores none."""
    stores = _setup(s3)
    _observe(monkeypatch, stores, {**_COMPLETED, "contentType": "upload", "liveStatus": None, "actualStartTime": "2026-09-14T15:30:00Z"}, date(2026, 9, 15))

    assert stores[2].get_video(VIDEO_ID).actual_start_at is None


def test_an_upcoming_stream_records_no_start_until_it_starts(s3, monkeypatch):
    """An upcoming observation carries no actualStartTime; the later live/completed observation fills it."""
    stores = _setup(s3)
    _observe(monkeypatch, stores, {**_COMPLETED, "liveStatus": "upcoming"}, date(2026, 9, 14))
    assert stores[2].get_video(VIDEO_ID).actual_start_at is None

    _observe(monkeypatch, stores, {**_COMPLETED, "liveStatus": "live", "actualStartTime": "2026-09-15T01:00:00Z"}, date(2026, 9, 15))
    assert stores[2].get_video(VIDEO_ID).actual_start_at == "2026-09-15T01:00:00+00:00"


def test_normalize_actual_start():
    """Z and offset forms normalize to one stored shape; absent or malformed values are None."""
    assert normalize_actual_start("2026-09-14T15:30:00Z") == "2026-09-14T15:30:00+00:00"
    assert normalize_actual_start("2026-09-15T00:30:00+09:00") == "2026-09-14T15:30:00+00:00"  # same instant, canonical UTC
    assert normalize_actual_start("2026-09-14T15:30:00") is None  # no offset: the instant would be a guess
    assert normalize_actual_start(None) is None
    assert normalize_actual_start("nope") is None


def test_start_and_published_dates_stay_independent_across_the_jst_midnight(s3, monkeypatch):
    """Started 23:50 JST on the 14th, published 01:10 JST on the 15th: both survive as reported, in their own fields."""
    stores = _setup(s3)
    _observe(monkeypatch, stores, {**_COMPLETED, "publishedAt": "2026-10-14T16:10:00Z", "actualStartTime": "2026-10-14T14:50:07Z"}, date(2026, 10, 15))

    video = stores[2].get_video(VIDEO_ID)
    assert video.actual_start_at == "2026-10-14T14:50:07+00:00"
    assert video.published_at == "2020-01-01T00:00:00Z"  # the master keeps its discovery-time publishedAt untouched
    assert video.title == "T" and video.activity_state is not None  # no existing field lost in the update


def test_a_start_stored_by_the_completion_lifecycle_reaches_the_manifest_on_the_next_daily_observation(s3, monkeypatch):
    """Lifecycle -> Video Master -> daily run: an observation that carries no start keeps the stored one and mirrors it onto the manifest (-> ranking -> API)."""
    stores = _setup(s3, content_type="live", live_status="completed", actual_start_at="2026-09-14T15:30:00+00:00")
    _observe(monkeypatch, stores, _COMPLETED, date(2026, 9, 15))

    manifest_store, _history, master = stores
    assert master.get_video(VIDEO_ID).actual_start_at == "2026-09-14T15:30:00+00:00"
    assert {e.video_id: e for e in manifest_store.read_shard(SHARD)}[VIDEO_ID].actual_start_at == "2026-09-14T15:30:00+00:00"
