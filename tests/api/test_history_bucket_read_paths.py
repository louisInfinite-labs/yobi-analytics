"""Home read paths resolve the history bucket on real (moto) S3 with NO store stubbing.

The API Lambda is deployed without YOBI_HISTORY_BUCKET, so recent / ranking / Oshi Status must find their data in the
fixed `yobi-analytics-history` bucket, while an explicit YOBI_HISTORY_BUCKET (moto, staging) still overrides it.
Each bucket holds a DIFFERENT marker so a test can tell exactly which one was read.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import boto3
import pytest
from moto import mock_aws

from api import api_handler, read_api
from stores.history_bucket import DEFAULT_HISTORY_BUCKET
from stores.subscriber_ranking_store import S3SubscriberRankingStore
from stores.video_ranking_store import S3VideoRankingStore
from tracking.creator_master import get_active_creators

REGION = "ap-northeast-1"
OVERRIDE_BUCKET = "test-override-history-bucket"
REPORT_DATE = "2026-10-01"
NOW = datetime(2026, 10, 1, 3, 0, 0, tzinfo=timezone.utc)
CREATOR_ID = get_active_creators()[0].creator_id


def _video_row(video_id: str, *, current: int) -> dict:
    return {
        "videoId": video_id,
        "creatorId": CREATOR_ID,
        "topic": "other",
        "contentType": "upload",
        "liveStatus": None,
        "currentViewCount": current,
        "anchor1dViewCount": current - 10,
        "anchor7dViewCount": None,
        "anchor30dViewCount": None,
        "title": f"title {video_id}",
        "thumbnailUrl": None,
        "publishedAt": "2026-09-30T00:00:00Z",
        "discoveredAt": "2026-09-01T00:00:00Z",
    }


def _video_ranking_payload(video_id: str) -> dict:
    return {
        "reportDate": REPORT_DATE,
        "creatorId": CREATOR_ID,
        "generatedAt": f"{REPORT_DATE}T18:05:00+09:00",
        "videos": [_video_row(video_id, current=1000)],
    }


def _subscriber_payload(subscriber_count: int) -> dict:
    return {
        "reportDate": REPORT_DATE,
        "generatedAt": f"{REPORT_DATE}T18:05:00+09:00",
        "total": {
            "rows": [
                {"rank": 1, "creatorId": CREATOR_ID, "organization": "vspo", "subscriberCount": subscriber_count}
            ],
            "ineligible": {},
        },
    }


@pytest.fixture
def two_buckets(aws_credentials, monkeypatch):
    """Default and override buckets, each holding a different video id and subscriber count; env var unset."""
    monkeypatch.delenv("YOBI_HISTORY_BUCKET", raising=False)
    with mock_aws():
        client = boto3.client("s3", region_name=REGION)
        for bucket, video_id, subscribers in (
            (DEFAULT_HISTORY_BUCKET, "vid_from_default_bucket", 111),
            (OVERRIDE_BUCKET, "vid_from_override_bucket", 222),
        ):
            client.create_bucket(Bucket=bucket, CreateBucketConfiguration={"LocationConstraint": REGION})
            S3VideoRankingStore(bucket, s3_client=client).write_result(
                datetime.fromisoformat(REPORT_DATE).date(), CREATOR_ID, _video_ranking_payload(video_id)
            )
            S3SubscriberRankingStore(bucket, s3_client=client).write_result(
                datetime.fromisoformat(REPORT_DATE).date(), _subscriber_payload(subscribers)
            )
        yield client


def _recent_ids() -> list[str]:
    result = read_api.get_recent_creator_videos({"creatorId": CREATOR_ID, "reportDate": REPORT_DATE})
    return [row["videoId"] for row in result["videos"]]


def _ranking_ids() -> list[str]:
    result = read_api.get_video_ranking({"creatorId": CREATOR_ID, "metric": "total", "reportDate": REPORT_DATE})
    return [row["videoId"] for row in result["rows"]]


def _oshi_status() -> dict:
    return read_api.get_oshi_status({"creatorId": CREATOR_ID, "reportDate": REPORT_DATE}, now=NOW)


# --- unset: the fixed bucket -----------------------------------------------------------------------------


def test_recent_reads_the_fixed_bucket_when_the_env_var_is_unset(two_buckets):
    """GET /creators/{id}/videos/recent finds its data in yobi-analytics-history."""
    assert _recent_ids() == ["vid_from_default_bucket"]


def test_video_ranking_reads_the_fixed_bucket_when_the_env_var_is_unset(two_buckets):
    """GET /creators/{id}/videos/ranking finds its data in yobi-analytics-history."""
    assert _ranking_ids() == ["vid_from_default_bucket"]


def test_oshi_status_reads_the_fixed_bucket_for_both_stores_when_the_env_var_is_unset(two_buckets):
    """Oshi Status reads the video-ranking store AND the subscriber-ranking store (subscriberCount) from it."""
    status = _oshi_status()

    assert status["latestVideo"]["videoId"] == "vid_from_default_bucket"
    assert status["subscriberCount"] == 111


# --- set: the override -----------------------------------------------------------------------------------


def test_recent_ranking_and_oshi_status_honour_an_explicit_override(two_buckets, monkeypatch):
    """With YOBI_HISTORY_BUCKET set, all three read paths use that bucket and ignore the fixed one."""
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", OVERRIDE_BUCKET)

    assert _recent_ids() == ["vid_from_override_bucket"]
    assert _ranking_ids() == ["vid_from_override_bucket"]
    status = _oshi_status()
    assert status["latestVideo"]["videoId"] == "vid_from_override_bucket"
    assert status["subscriberCount"] == 222


def test_a_blank_override_falls_back_to_the_fixed_bucket(two_buckets, monkeypatch):
    """An emptied Lambda variable behaves like an unset one on every read path."""
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", "")

    assert _recent_ids() == ["vid_from_default_bucket"]
    assert _oshi_status()["subscriberCount"] == 111


def test_an_override_pointing_at_a_bucket_without_the_result_is_not_ready_not_a_fallback_read(
    two_buckets, aws_credentials, monkeypatch
):
    """The override is authoritative: a missing result there is 503 RANKING_NOT_READY, never silently read from the default."""
    two_buckets.create_bucket(Bucket="empty-bucket", CreateBucketConfiguration={"LocationConstraint": REGION})
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", "empty-bucket")

    with pytest.raises(read_api.RankingNotReadyError):
        _recent_ids()


# --- through the Lambda entry point ----------------------------------------------------------------------


def test_the_lambda_handler_serves_recent_from_the_fixed_bucket_with_no_env_var(two_buckets):
    """The full API Lambda path (routeKey -> handler -> read_api -> S3) works with the variable absent."""
    event = {
        "routeKey": "GET /creators/{creatorId}/videos/recent",
        "pathParameters": {"creatorId": CREATOR_ID},
        "queryStringParameters": {"reportDate": REPORT_DATE},
    }

    response = api_handler.lambda_handler(event, None)

    assert response["statusCode"] == 200
    assert [row["videoId"] for row in json.loads(response["body"])["videos"]] == ["vid_from_default_bucket"]


def test_the_lambda_handler_serves_oshi_status_from_the_fixed_bucket_with_no_env_var(two_buckets):
    """Same for /oshi-status, including the subscriber count read from the second store."""
    event = {
        "routeKey": "GET /creators/{creatorId}/oshi-status",
        "pathParameters": {"creatorId": CREATOR_ID},
        "queryStringParameters": {"reportDate": REPORT_DATE},
    }

    response = api_handler.lambda_handler(event, None)

    body = json.loads(response["body"])
    assert response["statusCode"] == 200
    assert body["latestVideo"]["videoId"] == "vid_from_default_bucket"
    assert body["subscriberCount"] == 111


def test_the_lambda_handler_is_not_ready_when_the_fixed_bucket_has_no_result(aws_credentials, monkeypatch):
    """No data yet in the default bucket -> the documented 503 RANKING_NOT_READY, not a 500."""
    monkeypatch.delenv("YOBI_HISTORY_BUCKET", raising=False)
    with mock_aws():
        boto3.client("s3", region_name=REGION).create_bucket(
            Bucket=DEFAULT_HISTORY_BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION}
        )
        event = {
            "routeKey": "GET /creators/{creatorId}/videos/ranking",
            "pathParameters": {"creatorId": CREATOR_ID},
            "queryStringParameters": {"metric": "total", "reportDate": REPORT_DATE},
        }

        response = api_handler.lambda_handler(event, None)

    assert response["statusCode"] == 503
    assert json.loads(response["body"])["code"] == "RANKING_NOT_READY"
