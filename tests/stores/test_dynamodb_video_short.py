"""Tests for stores.dynamodb_store.set_video_short: a targeted, CONDITIONAL UpdateItem that only ever turns a stored
"upload" (or unclassified) record into a "short" and touches nothing else."""

from __future__ import annotations

import boto3
import pytest
from moto import mock_aws

from stores.dynamodb_store import CREATOR_ID_INDEX, VIDEO_MASTER_TABLE, set_video_short, upsert_videos
from tracking.video_master import Video

REGION = "ap-northeast-1"


@pytest.fixture
def table(aws_credentials):
    with mock_aws():
        boto3.client("dynamodb", region_name=REGION).create_table(
            TableName=VIDEO_MASTER_TABLE,
            AttributeDefinitions=[
                {"AttributeName": "videoId", "AttributeType": "S"},
                {"AttributeName": "creatorId", "AttributeType": "S"},
            ],
            KeySchema=[{"AttributeName": "videoId", "KeyType": "HASH"}],
            GlobalSecondaryIndexes=[
                {"IndexName": CREATOR_ID_INDEX, "KeySchema": [{"AttributeName": "creatorId", "KeyType": "HASH"}], "Projection": {"ProjectionType": "ALL"}}
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        yield boto3.resource("dynamodb", region_name=REGION).Table(VIDEO_MASTER_TABLE)


def _store(video_id="v1", *, content_type=None, live_status=None) -> None:
    upsert_videos(
        [
            Video(
                video_id=video_id, creator_id="c1", title="title", published_at="2026-09-01T00:00:00Z", topic="mv",
                snapshot_count=7, last_view_count=1234, content_type=content_type, live_status=live_status,
            )
        ]
    )


def _item(table, video_id="v1"):
    return table.get_item(Key={"videoId": video_id}).get("Item")


@pytest.mark.parametrize("stored", [None, "upload"])
def test_an_unclassified_or_upload_record_becomes_a_short_and_nothing_else_changes(table, stored):
    _store(content_type=stored)
    before = dict(_item(table))

    assert set_video_short("v1") is True

    after = _item(table)
    assert after["contentType"] == "short" and "liveStatus" not in after
    assert {key: value for key, value in after.items() if key != "contentType"} == {key: value for key, value in before.items() if key != "contentType"}


def test_a_livestream_record_is_never_rewritten(table):
    _store(content_type="live", live_status="completed")

    assert set_video_short("v1") is False

    assert (_item(table)["contentType"], _item(table)["liveStatus"]) == ("live", "completed")


def test_an_already_short_record_is_not_written_again(table):
    _store(content_type="short")

    assert set_video_short("v1") is False
    assert _item(table)["contentType"] == "short"


def test_a_missing_video_is_not_created(table):
    assert set_video_short("ghost") is False
    assert _item(table, "ghost") is None
