"""F37 Phase 0: set_video_live_status carries the livestream's actual start inside its one existing completion write -- filling a
missing actualStartAt only, never replacing a stored one, never touching any other attribute."""

from __future__ import annotations

import boto3
import pytest
from moto import mock_aws

from stores.dynamodb_store import CREATOR_ID_INDEX, VIDEO_MASTER_TABLE, set_video_live_status, upsert_videos
from tracking.video_master import Video

REGION = "ap-northeast-1"
START = "2026-10-14T14:50:00+00:00"


@pytest.fixture
def table(aws_credentials):
    """An empty YobiVideoMaster on moto, returned as a boto3 Table for raw-item assertions."""
    with mock_aws():
        boto3.client("dynamodb", region_name=REGION).create_table(
            TableName=VIDEO_MASTER_TABLE,
            AttributeDefinitions=[{"AttributeName": "videoId", "AttributeType": "S"}, {"AttributeName": "creatorId", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "videoId", "KeyType": "HASH"}],
            GlobalSecondaryIndexes=[{"IndexName": CREATOR_ID_INDEX, "KeySchema": [{"AttributeName": "creatorId", "KeyType": "HASH"}], "Projection": {"ProjectionType": "ALL"}}],
            BillingMode="PAY_PER_REQUEST",
        )
        yield boto3.resource("dynamodb", region_name=REGION).Table(VIDEO_MASTER_TABLE)


def _store(**fields) -> None:
    """Store one livestream record (upcoming by default) with the given overrides."""
    base = {"content_type": "live", "live_status": "live"}
    base.update(fields)
    upsert_videos([Video(video_id="v1", creator_id="c1", title="Title", published_at="2026-10-14T16:10:00+00:00", topic="mv", snapshot_count=7, last_view_count=99, **base)])


def _item(table):
    return table.get_item(Key={"videoId": "v1"})["Item"]


def test_completion_write_fills_the_start_and_changes_nothing_else(table):
    """liveStatus becomes completed and actualStartAt is filled in ONE update; every other attribute is exactly as it was."""
    _store()
    before = dict(_item(table))

    assert set_video_live_status("v1", "completed", START) is True

    after = _item(table)
    assert after["liveStatus"] == "completed" and after["actualStartAt"] == START
    assert {k: v for k, v in after.items() if k not in ("liveStatus", "actualStartAt")} == {k: v for k, v in before.items() if k != "liveStatus"}


def test_a_stored_start_is_never_replaced_by_a_later_completion_update(table):
    """The daily run (or an earlier cycle) already stored the start: a repeated/later completion keeps it, whatever it reports."""
    _store(actual_start_at=START)

    assert set_video_live_status("v1", "completed", "2026-10-14T15:30:00+00:00") is True
    assert set_video_live_status("v1", "completed", "2026-10-14T15:30:00+00:00") is True  # repeated completion

    assert _item(table)["actualStartAt"] == START


def test_a_completion_without_a_start_never_creates_one(table):
    """No start from YouTube -> the attribute is not created (it is never filled from publishedAt or a scheduled time)."""
    _store()

    assert set_video_live_status("v1", "completed") is True

    assert "actualStartAt" not in _item(table)
    assert _item(table)["liveStatus"] == "completed"


def test_a_record_without_the_field_still_completes_and_an_upload_is_never_touched(table):
    """A legacy record parses and completes; a non-livestream record rejects the write and gets no start."""
    _store()
    assert "actualStartAt" not in _item(table)  # a historical record without the field
    assert set_video_live_status("v1", "completed", START) is True

    upsert_videos([Video(video_id="u1", creator_id="c1", title="Upload", published_at="2026-10-14T16:10:00+00:00", content_type="upload")])
    assert set_video_live_status("u1", "completed", START) is False
    assert "actualStartAt" not in table.get_item(Key={"videoId": "u1"})["Item"]
