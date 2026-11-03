"""Tests for stores.dynamodb_store.set_video_actual_start (F37 backfill): a targeted, CONDITIONAL UpdateItem that only fills a missing
actualStartAt on a livestream, plus the whole-item upsert/scan round trip of the new attribute."""

from __future__ import annotations

import boto3
import pytest
from moto import mock_aws

from stores.dynamodb_store import (
    CREATOR_ID_INDEX,
    VIDEO_MASTER_TABLE,
    get_video,
    scan_video_actual_start_items,
    set_video_actual_start,
    upsert_videos,
)
from tracking.video_master import Video

REGION = "ap-northeast-1"
START = "2026-09-14T15:30:00+00:00"


@pytest.fixture
def table(aws_credentials):
    with mock_aws():
        boto3.client("dynamodb", region_name=REGION).create_table(
            TableName=VIDEO_MASTER_TABLE,
            AttributeDefinitions=[{"AttributeName": "videoId", "AttributeType": "S"}, {"AttributeName": "creatorId", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "videoId", "KeyType": "HASH"}],
            GlobalSecondaryIndexes=[
                {"IndexName": CREATOR_ID_INDEX, "KeySchema": [{"AttributeName": "creatorId", "KeyType": "HASH"}], "Projection": {"ProjectionType": "ALL"}}
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        yield boto3.resource("dynamodb", region_name=REGION).Table(VIDEO_MASTER_TABLE)


def _store(video_id="v1", **fields) -> None:
    upsert_videos([Video(video_id=video_id, creator_id="c1", title="title", published_at="2026-09-01T00:00:00Z", snapshot_count=7, **fields)])


def test_a_livestream_without_a_start_gets_only_the_start(table):
    """Only actualStartAt changes; every other attribute is untouched."""
    _store(content_type="live", live_status="completed")
    before = dict(table.get_item(Key={"videoId": "v1"})["Item"])

    assert set_video_actual_start("v1", START) is True

    after = table.get_item(Key={"videoId": "v1"})["Item"]
    assert after["actualStartAt"] == START
    assert {k: v for k, v in after.items() if k != "actualStartAt"} == before
    assert get_video("v1").actual_start_at == START


def test_a_stored_start_is_never_overwritten_and_a_rerun_is_a_rejection(table):
    """The same or a different time cannot replace a stored start."""
    _store(content_type="live", live_status="completed", actual_start_at=START)

    assert set_video_actual_start("v1", START) is False
    assert set_video_actual_start("v1", "2026-09-14T16:00:00+00:00") is False
    assert get_video("v1").actual_start_at == START


@pytest.mark.parametrize("content_type", [None, "upload", "short"])
def test_only_a_livestream_can_receive_a_start(table, content_type):
    """An upload, Short or unclassified record is never given a start."""
    _store(content_type=content_type)
    assert set_video_actual_start("v1", START) is False
    assert "actualStartAt" not in table.get_item(Key={"videoId": "v1"})["Item"]


def test_a_missing_video_is_never_created(table):
    """The write cannot create a record."""
    assert set_video_actual_start("ghost", START) is False
    assert "Item" not in table.get_item(Key={"videoId": "ghost"})


def test_the_planning_scan_projects_the_start(table):
    """The backfill's scan returns the four fields it plans from."""
    _store("a", content_type="live", live_status="completed", actual_start_at=START)
    _store("b", content_type="live", live_status="completed")
    items = {item["videoId"]: item for item in scan_video_actual_start_items()}
    assert items["a"]["actualStartAt"] == START
    assert "actualStartAt" not in items["b"] and items["b"]["contentType"] == "live"
    assert set(items["a"]) == {"videoId", "creatorId", "contentType", "liveStatus", "actualStartAt"}
