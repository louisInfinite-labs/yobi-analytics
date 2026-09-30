"""Focused tests for the video-ranking Phase C reducer wiring
(analytics.ranking_reducer._build_and_persist_video_rankings): S3-only,
one object per (report date, creator), same-date overwrite, zero DynamoDB
interaction.
"""

from __future__ import annotations

from datetime import date, timedelta
from types import SimpleNamespace

import boto3
import pytest
from moto import mock_aws

from analytics import ranking_reducer
from analytics.video_ranking import rank_video_rows
from stores import dynamodb_store
from stores.history_store import HISTORY_SHARD_COUNT, HistoryRow, S3HistoryStore, partition_history_rows
from stores.video_ranking_store import S3VideoRankingStore
from tracking.tracking_manifest import S3TrackingManifestStore, publish_tracking_manifest

BUCKET = "test-history-bucket"
REGION = "ap-northeast-1"
REPORT_DATE = date(2026, 9, 29)


def _video(
    video_id: str,
    creator_id: str,
    topic: str,
    *,
    title: str | None = None,
    thumbnail_url: str | None = None,
    content_type: str | None = None,
    live_status: str | None = None,
):
    return SimpleNamespace(
        video_id=video_id,
        creator_id=creator_id,
        discovered_at=None,
        published_at=None,
        activity_state=None,
        topic=topic,
        title=title,
        thumbnail_url=thumbnail_url,
        content_type=content_type,
        live_status=live_status,
    )


def _row(video_id: str, creator_id: str, view_count: int, observed_at="2026-09-29T18:00:00+09:00") -> HistoryRow:
    return HistoryRow(
        video_id=video_id, creator_id=creator_id, view_count=view_count, observed_at=observed_at, availability_status="available"
    )


def _write_all_history_shards(history_store: S3HistoryStore, collection_date: date, rows: list[HistoryRow]) -> None:
    partitions = partition_history_rows(rows)
    for shard, shard_rows in partitions.items():
        history_store.write_daily_shard(collection_date, shard, shard_rows)


@pytest.fixture
def wired_bucket(aws_credentials, monkeypatch):
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", BUCKET)
    with mock_aws():
        client = boto3.client("s3", region_name=REGION)
        client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})

        history_store = S3HistoryStore(BUCKET, s3_client=client)
        manifest_store = S3TrackingManifestStore(BUCKET, s3_client=client)

        today_rows = [
            _row("v1", "creator_a", 500),
            _row("v2", "creator_a", 300),
            _row("v3", "creator_b", 100),
        ]
        _write_all_history_shards(history_store, REPORT_DATE, today_rows)
        anchor_rows = [_row("v1", "creator_a", 400, observed_at="2026-09-22T18:00:00+09:00")]
        _write_all_history_shards(history_store, REPORT_DATE - timedelta(days=7), anchor_rows)

        videos = [
            _video(
                "v1",
                "creator_a",
                "valorant",
                title="V1 Title",
                thumbnail_url="https://i.ytimg.com/vi/v1/maxresdefault.jpg",
            ),
            _video("v2", "creator_a", "sf6"),
            _video("v3", "creator_b", "apex"),
        ]
        publish_tracking_manifest(videos, manifest_store)

        yield client


def _spy_dynamodb(monkeypatch) -> dict[str, int]:
    calls = {"count": 0}

    def _spy(*args, **kwargs):
        calls["count"] += 1
        return None

    for name in (
        "get_video",
        "get_videos",
        "put_cached_trending",
        "get_cached_trending",
        "scan_video_topic_items",
        "load_videos",
        "get_video_topics",
        "upsert_videos",
    ):
        if hasattr(dynamodb_store, name):
            monkeypatch.setattr(dynamodb_store, name, _spy, raising=True)
    return calls


def test_writes_one_s3_object_per_creator_with_eligible_videos(wired_bucket):
    ranking_reducer._build_and_persist_video_rankings(report_date=REPORT_DATE, generated_at="2026-09-29T18:05:00+09:00")

    store = S3VideoRankingStore(BUCKET, s3_client=wired_bucket)
    creator_a_result = store.read_result(REPORT_DATE, "creator_a")
    creator_b_result = store.read_result(REPORT_DATE, "creator_b")

    assert creator_a_result is not None
    assert {row["videoId"] for row in creator_a_result["videos"]} == {"v1", "v2"}
    # Exactly one canonical row per video -- never a duplicated row per metric.
    assert len(creator_a_result["videos"]) == 2
    assert creator_b_result is not None
    assert {row["videoId"] for row in creator_b_result["videos"]} == {"v3"}


def test_creator_a_result_never_contains_creator_bs_videos(wired_bucket):
    ranking_reducer._build_and_persist_video_rankings(report_date=REPORT_DATE, generated_at="2026-09-29T18:05:00+09:00")

    store = S3VideoRankingStore(BUCKET, s3_client=wired_bucket)
    creator_a_result = store.read_result(REPORT_DATE, "creator_a")

    assert all(row["videoId"] != "v3" for row in creator_a_result["videos"])


def test_topic_and_growth_are_present_in_the_persisted_result(wired_bucket):
    ranking_reducer._build_and_persist_video_rankings(report_date=REPORT_DATE, generated_at="2026-09-29T18:05:00+09:00")

    store = S3VideoRankingStore(BUCKET, s3_client=wired_bucket)
    result = store.read_result(REPORT_DATE, "creator_a")

    v1_row = next(row for row in result["videos"] if row["videoId"] == "v1")
    assert v1_row["topic"] == "valorant"
    assert v1_row["anchor7dViewCount"] == 400

    v1_growth = next(row for row in rank_video_rows(result["videos"], metric="7d", topic="all") if row["videoId"] == "v1")
    assert v1_growth["absoluteGrowth"] == 100  # 500 - 400


def test_content_type_is_persisted_and_independently_filterable(wired_bucket):
    """content_type flows Video-like object -> manifest -> persisted S3 row,
    the same path as topic, and can be filtered independently of it."""
    ranking_reducer._build_and_persist_video_rankings(report_date=REPORT_DATE, generated_at="2026-09-29T18:05:00+09:00")

    store = S3VideoRankingStore(BUCKET, s3_client=wired_bucket)
    result = store.read_result(REPORT_DATE, "creator_a")

    # wired_bucket's videos were built with content_type=None (not set) --
    # confirms the field round-trips as None, never fabricated as "upload".
    v1_row = next(row for row in result["videos"] if row["videoId"] == "v1")
    assert v1_row["contentType"] is None

    live_only = rank_video_rows(result["videos"], metric="total", topic="all", content_type="live")
    assert live_only == []


def test_title_and_thumbnail_url_are_propagated_from_the_manifest(wired_bucket):
    """video-ranking metadata propagation: title/thumbnailUrl flow from the
    tracking manifest (ultimately Video Master, discovery-time data) into
    the persisted canonical row -- no runtime DynamoDB enrichment."""
    ranking_reducer._build_and_persist_video_rankings(report_date=REPORT_DATE, generated_at="2026-09-29T18:05:00+09:00")

    store = S3VideoRankingStore(BUCKET, s3_client=wired_bucket)
    result = store.read_result(REPORT_DATE, "creator_a")

    v1_row = next(row for row in result["videos"] if row["videoId"] == "v1")
    assert v1_row["title"] == "V1 Title"
    assert v1_row["thumbnailUrl"] == "https://i.ytimg.com/vi/v1/maxresdefault.jpg"

    v2_row = next(row for row in result["videos"] if row["videoId"] == "v2")
    assert v2_row["title"] is None
    assert v2_row["thumbnailUrl"] is None


def test_same_date_rerun_deterministically_overwrites_not_duplicates(wired_bucket):
    ranking_reducer._build_and_persist_video_rankings(report_date=REPORT_DATE, generated_at="2026-09-29T18:05:00+09:00")
    ranking_reducer._build_and_persist_video_rankings(report_date=REPORT_DATE, generated_at="2026-09-29T19:00:00+09:00")

    store = S3VideoRankingStore(BUCKET, s3_client=wired_bucket)
    result = store.read_result(REPORT_DATE, "creator_a")

    assert result["generatedAt"] == "2026-09-29T19:00:00+09:00"  # the rebuild replaced it, not a second object
    assert {row["videoId"] for row in result["videos"]} == {"v1", "v2"}


def test_no_dynamodb_ranking_writes_and_no_video_master_scan(wired_bucket, monkeypatch):
    calls = _spy_dynamodb(monkeypatch)

    ranking_reducer._build_and_persist_video_rankings(report_date=REPORT_DATE, generated_at="2026-09-29T18:05:00+09:00")

    assert calls["count"] == 0


def test_missing_bucket_configuration_is_a_silent_no_op(monkeypatch, capsys):
    monkeypatch.delenv("YOBI_HISTORY_BUCKET", raising=False)

    ranking_reducer._build_and_persist_video_rankings(report_date=REPORT_DATE, generated_at="2026-09-29T18:05:00+09:00")

    captured = capsys.readouterr()
    assert "Traceback" not in captured.out
    assert "Traceback" not in captured.err
