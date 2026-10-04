"""Tests for stores.dynamodb_store.set_video_classification / scan_video_classification_items.

The write is a targeted, CONDITIONAL UpdateItem: it only ever fills a still-incomplete classification (the same rule as
tracking.video_master.is_classification_incomplete, which this file checks against the real DynamoDB condition) and never
touches any other attribute.
"""

from __future__ import annotations

import boto3
import pytest
from moto import mock_aws

from stores import dynamodb_store
from stores.dynamodb_store import (
    CREATOR_ID_INDEX,
    VIDEO_MASTER_TABLE,
    scan_video_classification_items,
    set_video_classification,
    upsert_videos,
)
from tracking.video_master import Video, is_classification_incomplete

REGION = "ap-northeast-1"

STORED_STATES = [
    (None, None),
    ("live", None),
    ("upload", None),
    ("live", "upcoming"),
    ("live", "live"),
    ("live", "completed"),
]


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


@pytest.mark.parametrize("stored", STORED_STATES)
@pytest.mark.parametrize("new", [("upload", None), ("live", "completed")])
def test_the_condition_accepts_exactly_the_incomplete_states(table, stored, new):
    """The DynamoDB condition and is_classification_incomplete must agree for every stored state."""
    upsert_videos([_video(content_type=stored[0], live_status=stored[1])])

    written = set_video_classification("v1", *new)

    assert written is is_classification_incomplete(*stored)
    item = _raw(table)
    assert (item.get("contentType"), item.get("liveStatus")) == (new if written else stored)


def test_only_the_two_classification_attributes_change(table):
    upsert_videos([_video()])
    before = _raw(table)

    assert set_video_classification("v1", "live", "completed") is True

    after = _raw(table)
    assert {k: v for k, v in after.items() if k not in {"contentType", "liveStatus"}} == {
        k: v for k, v in before.items() if k not in {"contentType", "liveStatus"}
    }
    assert (after["contentType"], after["liveStatus"]) == ("live", "completed")


def test_an_upload_has_no_live_status_attribute_at_all_not_a_null(table):
    upsert_videos([_video(content_type="live", live_status=None)])

    assert set_video_classification("v1", "upload", None) is True

    item = _raw(table)
    assert item["contentType"] == "upload" and "liveStatus" not in item


def test_a_stray_live_status_without_a_content_type_is_replaced_by_the_new_pair(table):
    table.put_item(Item={**dynamodb_store._video_to_item(_video()), "liveStatus": "completed"})

    assert set_video_classification("v1", "upload", None) is True

    item = _raw(table)
    assert item["contentType"] == "upload" and "liveStatus" not in item


def test_a_missing_video_is_never_created(table):
    assert set_video_classification("ghost", "upload", None) is False

    assert _raw(table, "ghost") is None


@pytest.mark.parametrize(
    ("content_type", "live_status"),
    [("podcast", None), ("live", None), ("live", "bogus"), ("upload", "completed"), (None, None)],
)
def test_invalid_pairs_are_rejected_before_any_write(table, content_type, live_status):
    upsert_videos([_video()])
    before = _raw(table)

    with pytest.raises(ValueError):
        set_video_classification("v1", content_type, live_status)

    assert _raw(table) == before


def test_the_scan_projects_only_the_three_classification_attributes(table):
    upsert_videos([_video("v1", content_type="live", live_status="completed"), _video("v2"), _video("v3", content_type="upload")])

    items = {item["videoId"]: item for item in scan_video_classification_items()}

    assert items == {
        "v1": {"videoId": "v1", "contentType": "live", "liveStatus": "completed"},
        "v2": {"videoId": "v2"},
        "v3": {"videoId": "v3", "contentType": "upload"},
    }


def test_a_loaded_video_carries_the_classification_that_the_collector_republish_reads(table):
    upsert_videos([_video()])
    set_video_classification("v1", "live", "upcoming")

    [video] = dynamodb_store.load_videos()

    assert (video.content_type, video.live_status) == ("live", "upcoming")
    assert (video.title, video.topic, video.last_view_count, video.snapshot_count) == ("Original Title", "apex", 4321, 9)
