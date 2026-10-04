"""End-to-end proof of the Home API-data pipeline on real (moto) S3: tracking manifest -> history worker
(collect_history_shard) -> ranking reducer -> the three Home read endpoints.

Everything between YouTube and the HTTP read model is the real production code. Only YouTube
(get_video_statistics) and Video Master (an in-memory dict) are faked. The scenario starts from a LEGACY manifest
(no contentType/liveStatus at all, the state production is in today) and proves:

- day 1: every unclassified video is observed once (catch-up) and Home's contentType/liveStatus/topic filters, both
  sort orders, the ranking metrics and Oshi Status all return real data;
- day 2: a stream that was "upcoming" is re-observed (even though its cadence is not due), becomes "completed", and
  only then appears in the archived live shelf; classified videos that are not due are NOT re-requested.
"""

from __future__ import annotations

from datetime import date, timedelta

import boto3
import pytest
from moto import mock_aws

import collection.history_worker as history_worker
from analytics import ranking_reducer
from api import read_api
from stores.history_store import HISTORY_SHARD_COUNT, HistoryRow, S3HistoryStore, partition_history_rows
from tracking.creator_master import get_active_creators
from tracking.tracking_manifest import S3TrackingManifestStore, publish_tracking_manifest
from tracking.tracking_schedule import is_due_today, select_due_video_ids
from tracking.video_master import Video

BUCKET = "test-history-bucket"
REGION = "ap-northeast-1"
DAY1 = date(2026, 9, 29)
DAY2 = date(2026, 9, 30)

CREATOR_ID, OTHER_CREATOR_ID = (creator.creator_id for creator in get_active_creators()[:2])

DAY0 = DAY1 - timedelta(days=1)  # the last LEGACY run (history rows exist, but no contentType/liveStatus anywhere)


def _id_not_due(prefix: str, *, state_on_day: dict[date, str], published_at: str) -> str:
    """A videoId whose normal cadence leaves it NOT due on each given day (so only the fix under test can request it)."""
    counter = 0
    while True:
        video_id = f"{prefix}_{counter}"
        if not any(is_due_today(video_id, published_at, state, day) for day, state in state_on_day.items()):
            return video_id
        counter += 1


UP_NEW = "vid_up_new"
UP_OLD = _id_not_due("vid_up_old", state_on_day={DAY1: "Cold"}, published_at="2024-05-01T10:00:00Z")
LIVE_DONE = _id_not_due("vid_live_done", state_on_day={DAY1: "Cold"}, published_at="2024-06-01T10:00:00Z")
# Cold (not due) before its first observation, Unknown (2-day cycle) after it: must be not due on BOTH days.
LIVE_PENDING = _id_not_due(
    "vid_live_pending", state_on_day={DAY1: "Cold", DAY2: "Unknown"}, published_at="2026-08-01T10:00:00Z"
)
OTHER = "vid_other_creator"


def _video(video_id: str, creator_id: str, published_at: str, topic: str, activity_state: str = "Cold") -> Video:
    return Video(
        video_id=video_id,
        creator_id=creator_id,
        title=f"title {video_id}",
        published_at=published_at,
        thumbnail_url=f"https://i.ytimg.com/vi/{video_id}/hq.jpg",
        activity_state=activity_state,
        discovered_at="2026-09-01T00:00:00+09:00",
        topic=topic,
    )


CATALOG = [
    _video(UP_NEW, CREATOR_ID, "2026-09-27T10:00:00Z", "chatting", "Unknown"),
    _video(UP_OLD, CREATOR_ID, "2024-05-01T10:00:00Z", "sf6"),
    _video(LIVE_DONE, CREATOR_ID, "2024-06-01T10:00:00Z", "singing"),
    _video(LIVE_PENDING, CREATOR_ID, "2026-08-01T10:00:00Z", "valorant"),
    _video(OTHER, OTHER_CREATOR_ID, "2024-07-01T10:00:00Z", "apex"),
]

# videoId -> (contentType, liveStatus, viewCount) as YouTube would report it on each day.
YOUTUBE_DAY1 = {
    UP_NEW: ("upload", None, 1000),
    UP_OLD: ("upload", None, 5000),
    LIVE_DONE: ("live", "completed", 7000),
    LIVE_PENDING: ("live", "upcoming", 10),
    OTHER: ("upload", None, 300),
}
YOUTUBE_DAY2 = {
    UP_NEW: ("upload", None, 1010),
    UP_OLD: ("upload", None, 5010),
    LIVE_DONE: ("live", "completed", 7010),
    LIVE_PENDING: ("live", "completed", 900),
    OTHER: ("upload", None, 310),
}


class _InMemoryVideoMaster:
    def __init__(self, videos):
        self.videos = {video.video_id: video for video in videos}

    def get_video(self, video_id):
        return self.videos.get(video_id)

    def upsert_videos(self, videos):
        for video in videos:
            self.videos[video.video_id] = video


@pytest.fixture
def pipeline(aws_credentials, monkeypatch):
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", BUCKET)
    with mock_aws():
        client = boto3.client("s3", region_name=REGION)
        client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})
        manifest_store = S3TrackingManifestStore(BUCKET, s3_client=client)
        history_store = S3HistoryStore(BUCKET, s3_client=client)
        # A LEGACY manifest: every entry has topic/title/thumbnail but no contentType/liveStatus.
        publish_tracking_manifest(CATALOG, manifest_store)
        # ... and a legacy previous day's history (so non-due videos are carried forward, never force-collected).
        legacy_rows = [
            HistoryRow(
                video_id=video.video_id,
                creator_id=video.creator_id,
                view_count=1,
                observed_at=f"{DAY0.isoformat()}T18:00:00+09:00",
                availability_status="available",
            )
            for video in CATALOG
        ]
        for shard, rows in partition_history_rows(legacy_rows).items():
            history_store.write_daily_shard(DAY0, shard, rows)
        yield SimpleNamespaceLike(
            manifest_store=manifest_store, history_store=history_store, video_master=_InMemoryVideoMaster(CATALOG)
        )


class SimpleNamespaceLike:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


def _run_collection_day(pipeline, monkeypatch, day: date, youtube_by_video: dict) -> list[str]:
    """Run the real history worker for all 16 shards and the real reducer. Returns every videoId YouTube was asked for."""
    requested: list[str] = []

    def fake_get_video_statistics(youtube, video_ids):
        requested.extend(video_ids)
        return (
            [
                {
                    "videoId": video_id,
                    "title": f"title {video_id}",
                    "publishedAt": "2020-01-01T00:00:00Z",
                    "viewCount": youtube_by_video[video_id][2],
                    "contentType": youtube_by_video[video_id][0],
                    "liveStatus": youtube_by_video[video_id][1],
                }
                for video_id in video_ids
            ],
            {},
        )

    monkeypatch.setattr(history_worker, "get_video_statistics", fake_get_video_statistics)
    for shard in range(HISTORY_SHARD_COUNT):
        history_worker.collect_history_shard(
            youtube=object(),
            manifest_store=pipeline.manifest_store,
            history_store=pipeline.history_store,
            video_master_store=pipeline.video_master,
            collection_date=day,
            shard=shard,
            observed_at=f"{day.isoformat()}T18:00:00+09:00",
        )
    ranking_reducer._build_and_persist_video_rankings(report_date=day, generated_at=f"{day.isoformat()}T18:30:00+09:00")
    return requested


def _manifest_by_video(pipeline) -> dict:
    return {
        entry.video_id: entry
        for shard in range(HISTORY_SHARD_COUNT)
        for entry in pipeline.manifest_store.read_shard(shard)
    }


def _recent(day: date, **query) -> list[str]:
    params = {
        "creatorId": CREATOR_ID,
        "topic": "all",
        "contentType": "all",
        "liveStatus": "archived",
        "sort": "newest",
        "limit": "20",
        "offset": "0",
        "reportDate": day.isoformat(),
    }
    params.update(query)
    return [row["videoId"] for row in read_api.get_recent_creator_videos(params)["videos"]]


def _ranking(day: date, **query) -> list[str]:
    params = {
        "creatorId": CREATOR_ID,
        "metric": "total",
        "topic": "all",
        "contentType": "all",
        "liveStatus": "archived",
        "limit": "100",
        "reportDate": day.isoformat(),
    }
    params.update(query)
    return [row["videoId"] for row in read_api.get_video_ranking(params)["rows"]]


def test_day_one_observes_every_unclassified_video_and_populates_the_manifest(pipeline, monkeypatch):
    requested = _run_collection_day(pipeline, monkeypatch, DAY1, YOUTUBE_DAY1)

    # Catch-up: every legacy (unclassified) video is observed once, however its cadence would otherwise fall.
    assert sorted(requested) == sorted(video.video_id for video in CATALOG)
    manifest = _manifest_by_video(pipeline)
    assert {video_id: (entry.content_type, entry.live_status) for video_id, entry in manifest.items()} == {
        video_id: (content_type, live_status) for video_id, (content_type, live_status, _views) in YOUTUBE_DAY1.items()
    }
    # topic/title/thumbnail survive the manifest patch untouched.
    assert manifest[LIVE_DONE].topic == "singing"
    assert manifest[LIVE_DONE].title == f"title {LIVE_DONE}"


def test_day_one_home_filters_sorts_and_rankings_work_from_real_pipeline_output(pipeline, monkeypatch):
    _run_collection_day(pipeline, monkeypatch, DAY1, YOUTUBE_DAY1)

    # ALL (archive scope drops the still-upcoming stream) and creator isolation.
    assert set(_recent(DAY1)) == {UP_NEW, UP_OLD, LIVE_DONE}
    assert OTHER not in _recent(DAY1)
    # 最新影片 / 最新直播 (contentType filters, archived only).
    assert _recent(DAY1, contentType="upload") == [UP_NEW, UP_OLD]
    assert _recent(DAY1, contentType="live") == [LIVE_DONE]
    # topic filters.
    assert _recent(DAY1, topic="sf6") == [UP_OLD]
    assert _recent(DAY1, topic="singing") == [LIVE_DONE]
    assert _recent(DAY1, topic="valorant") == []  # its only video is still upcoming
    # newest / oldest are true opposite orders.
    assert _recent(DAY1, sort="newest") == [UP_NEW, LIVE_DONE, UP_OLD]
    assert _recent(DAY1, sort="oldest") == [UP_OLD, LIVE_DONE, UP_NEW]
    # views total, contentType-scoped.
    assert _ranking(DAY1) == [LIVE_DONE, UP_OLD, UP_NEW]
    assert _ranking(DAY1, contentType="upload") == [UP_OLD, UP_NEW]


def test_day_one_oshi_status_reads_real_data(pipeline, monkeypatch):
    _run_collection_day(pipeline, monkeypatch, DAY1, YOUTUBE_DAY1)

    status = read_api.get_oshi_status(
        {"creatorId": CREATOR_ID, "recentLimit": "6", "reportDate": DAY1.isoformat()},
        now=read_api.datetime(2026, 9, 29, 12, 0, tzinfo=read_api.timezone.utc),
    )

    assert status["latestVideo"]["videoId"] == UP_NEW
    assert {row["videoId"] for row in status["recent"]} == {UP_NEW, UP_OLD, LIVE_DONE}


def test_day_two_in_progress_stream_is_reobserved_and_then_joins_the_archive(pipeline, monkeypatch):
    _run_collection_day(pipeline, monkeypatch, DAY1, YOUTUBE_DAY1)
    assert LIVE_PENDING not in _recent(DAY1, contentType="live")

    manifest_after_day1 = _manifest_by_video(pipeline)
    cadence_due = set(
        select_due_video_ids(
            ((entry.video_id, entry.published_at, entry.activity_state) for entry in manifest_after_day1.values()),
            as_of=DAY2,
        )
    )

    requested = _run_collection_day(pipeline, monkeypatch, DAY2, YOUTUBE_DAY2)

    # Day 2 requests exactly: what the Hot/Warm/Cold cadence says is due, plus the one stream last seen
    # "upcoming". Already-classified videos that are not due are NOT requested again.
    assert LIVE_PENDING not in cadence_due  # only the in-progress rule can request it
    assert set(requested) == cadence_due | {LIVE_PENDING}
    assert len(requested) == len(set(requested))
    assert _manifest_by_video(pipeline)[LIVE_PENDING].live_status == "completed"
    assert set(_recent(DAY2, contentType="live")) == {LIVE_DONE, LIVE_PENDING}
    assert _recent(DAY2, topic="valorant") == [LIVE_PENDING]
    # 1d growth ranking works once a D-1 anchor exists; the stream that gained the most ranks first.
    assert _ranking(DAY2, metric="1d")[0] == LIVE_PENDING
