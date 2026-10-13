"""Tests for stores.dynamodb_store.set_video_live_status.

The write is a targeted, UNCONDITIONAL (on the previous liveStatus value) UpdateItem: it only requires the video
to exist and already be classified content_type="live", and never touches any other attribute -- unlike
set_video_classification (tests/stores/test_dynamodb_video_classification.py), which only ever fills a still-
unclassified record, this is the completion-lifecycle's own targeted write for a status transition that happens
AFTER initial classification (upcoming -> live -> completed).
"""

from __future__ import annotations

import boto3
import pytest
from moto import mock_aws

from stores.dynamodb_store import CREATOR_ID_INDEX, VIDEO_MASTER_TABLE, set_video_live_status, upsert_videos
from tracking.video_master import Video

REGION = "ap-northeast-1"


@pytest.fixture
def table(aws_credentials):
    """An empty YobiVideoMaster on moto, returned as a boto3 Table for raw-item assertions."""
    with mock_aws():
        boto3.client("dynamodb", region_name=REGION).create_table(
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
        yield boto3.resource("dynamodb", region_name=REGION).Table(VIDEO_MASTER_TABLE)


def _video(video_id="v1", *, content_type=None, live_status=None) -> Video:
    return Video(
        video_id=video_id,
        creator_id="c1",
        title="Original Title",
        published_at="2026-09-01T00:00:00Z",
        thumbnail_url="https://i.ytimg.com/vi/v1/hq.jpg",
        activity_state="Hot",
        last_checked_at="2026-10-01T18:00:00+09:00",
        last_view_count=4321,
        snapshot_count=9,
        quiet_streak=1,
        discovered_at="2026-09-02T00:00:00+09:00",
        topic="apex",
        content_type=content_type,
        live_status=live_status,
    )


def _raw(table, video_id="v1") -> dict:
    return table.get_item(Key={"videoId": video_id}, ConsistentRead=True).get("Item")


def test_marks_an_upcoming_stream_completed(table):
    upsert_videos([_video(content_type="live", live_status="upcoming")])

    assert set_video_live_status("v1", "completed") is True

    assert _raw(table)["liveStatus"] == "completed"


def test_marks_a_live_stream_completed(table):
    upsert_videos([_video(content_type="live", live_status="live")])

    assert set_video_live_status("v1", "completed") is True

    assert _raw(table)["liveStatus"] == "completed"


def test_is_idempotent_writing_the_same_status_twice_succeeds_both_times(table):
    upsert_videos([_video(content_type="live", live_status="live")])

    assert set_video_live_status("v1", "completed") is True
    assert set_video_live_status("v1", "completed") is True

    assert _raw(table)["liveStatus"] == "completed"


def test_only_the_live_status_attribute_changes(table):
    upsert_videos([_video(content_type="live", live_status="live")])
    before = _raw(table)

    assert set_video_live_status("v1", "completed") is True

    after = _raw(table)
    assert {k: v for k, v in after.items() if k != "liveStatus"} == {k: v for k, v in before.items() if k != "liveStatus"}


def test_a_missing_video_is_never_created(table):
    assert set_video_live_status("ghost", "completed") is False

    assert _raw(table, "ghost") is None


def test_an_upload_is_rejected_its_content_type_is_not_live(table):
    upsert_videos([_video(content_type="upload", live_status=None)])

    assert set_video_live_status("v1", "completed") is False

    assert "liveStatus" not in _raw(table)


def test_an_unclassified_video_is_rejected(table):
    upsert_videos([_video(content_type=None, live_status=None)])

    assert set_video_live_status("v1", "completed") is False


def test_an_unknown_live_status_is_rejected_before_any_write(table):
    upsert_videos([_video(content_type="live", live_status="live")])
    before = _raw(table)

    with pytest.raises(ValueError):
        set_video_live_status("v1", "bogus")

    assert _raw(table) == before
