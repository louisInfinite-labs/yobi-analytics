"""Tests for collection.subscriber_snapshot.collect_subscriber_snapshot
(ranking-simplification, subscriber-history foundation, R1) -- the thin
orchestration function tying get_channel_statistics + S3SubscriberHistoryStore
together into one callable daily snapshot.
"""

from datetime import date
from unittest.mock import MagicMock

import boto3
import pytest
from moto import mock_aws

from collection.subscriber_snapshot import collect_subscriber_snapshot
from stores.subscriber_history_store import S3SubscriberHistoryStore
from tracking.creator_master import Creator

BUCKET = "test-history-bucket"
REGION = "ap-northeast-1"
DAY = date(2026, 9, 29)
OBSERVED_AT = "2026-09-29T18:00:00+09:00"


def _creator(creator_id: str, channel_id: str) -> Creator:
    return Creator(
        creator_id=creator_id,
        display_name=creator_id,
        organization="hololive",
        youtube_channel_id=channel_id,
        active=True,
        branch="holo_jp",
        group_key=["NO"],
        channel_type="member",
        lifecycle_stage="active",
        display_order=1,
    )


def _make_channels_client(response):
    youtube = MagicMock()
    youtube.channels.return_value.list.return_value.execute.return_value = response
    return youtube


@pytest.fixture
def s3_store(aws_credentials):
    with mock_aws():
        client = boto3.client("s3", region_name=REGION)
        client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})
        yield S3SubscriberHistoryStore(BUCKET, s3_client=client)


def test_collects_and_persists_visible_and_hidden_creators_in_one_snapshot(s3_store):
    creators = [_creator("creator_a", "UC_a"), _creator("creator_b", "UC_b")]
    response = {
        "items": [
            {"id": "UC_a", "statistics": {"subscriberCount": "500000", "hiddenSubscriberCount": False}},
            {"id": "UC_b", "statistics": {"subscriberCount": "0", "hiddenSubscriberCount": True}},
        ]
    }
    youtube = _make_channels_client(response)

    key, skip_reasons = collect_subscriber_snapshot(
        youtube, creators, collection_date=DAY, observed_at=OBSERVED_AT, store=s3_store
    )

    assert key == "subscriber-history/date=2026-09-29.parquet"
    assert skip_reasons == {}
    rows = {row.creator_id: row for row in s3_store.read_daily_snapshot(DAY)}
    assert rows["creator_a"].subscriber_count == 500000
    assert rows["creator_a"].hidden_subscriber_count is False
    # Hidden must persist as None, never the API's own fabricated "0".
    assert rows["creator_b"].subscriber_count is None
    assert rows["creator_b"].hidden_subscriber_count is True


def test_creator_with_failed_collection_has_no_row_and_is_reported_as_skipped(s3_store):
    creators = [_creator("creator_a", "UC_a"), _creator("creator_missing", "UC_missing")]
    response = {"items": [{"id": "UC_a", "statistics": {"subscriberCount": "10", "hiddenSubscriberCount": False}}]}
    youtube = _make_channels_client(response)

    key, skip_reasons = collect_subscriber_snapshot(
        youtube, creators, collection_date=DAY, observed_at=OBSERVED_AT, store=s3_store
    )

    rows = {row.creator_id for row in s3_store.read_daily_snapshot(DAY)}
    assert rows == {"creator_a"}
    assert "UC_missing" in skip_reasons


def test_empty_roster_still_writes_an_empty_snapshot_object(s3_store):
    key, skip_reasons = collect_subscriber_snapshot(
        MagicMock(), [], collection_date=DAY, observed_at=OBSERVED_AT, store=s3_store
    )

    assert key == "subscriber-history/date=2026-09-29.parquet"
    assert skip_reasons == {}
    assert s3_store.read_daily_snapshot(DAY) == []


def test_a_retry_for_the_same_day_overwrites_rather_than_appends(s3_store):
    creators = [_creator("creator_a", "UC_a")]
    first_response = {"items": [{"id": "UC_a", "statistics": {"subscriberCount": "100", "hiddenSubscriberCount": False}}]}
    second_response = {"items": [{"id": "UC_a", "statistics": {"subscriberCount": "150", "hiddenSubscriberCount": False}}]}

    collect_subscriber_snapshot(
        _make_channels_client(first_response), creators, collection_date=DAY, observed_at=OBSERVED_AT, store=s3_store
    )
    collect_subscriber_snapshot(
        _make_channels_client(second_response), creators, collection_date=DAY, observed_at=OBSERVED_AT, store=s3_store
    )

    rows = s3_store.read_daily_snapshot(DAY)
    assert len(rows) == 1
    assert rows[0].subscriber_count == 150


def test_batches_channel_ids_efficiently_across_many_creators(s3_store):
    """More than one YouTube API batch worth of creators is still collected
    into exactly one daily snapshot object, batched under the hood by
    get_channel_statistics -- collect_subscriber_snapshot itself issues no
    per-creator API calls."""
    creators = [_creator(f"creator_{i}", f"UC_{i}") for i in range(60)]
    response_batch = {
        "items": [
            {"id": f"UC_{i}", "statistics": {"subscriberCount": str(i), "hiddenSubscriberCount": False}} for i in range(50)
        ]
    }
    youtube = _make_channels_client(response_batch)

    collect_subscriber_snapshot(youtube, creators, collection_date=DAY, observed_at=OBSERVED_AT, store=s3_store)

    assert youtube.channels.return_value.list.call_count == 2  # 60 ids -> two batches of <=50
