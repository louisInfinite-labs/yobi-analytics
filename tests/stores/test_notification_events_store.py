import boto3
import pytest
from botocore.exceptions import EndpointConnectionError
from moto import mock_aws

from stores.notification_events_store import (
    NOTIFICATION_EVENTS_TABLE,
    NotificationEventsStoreError,
    list_events_for_date,
    new_video_event_id,
    record_new_video_events,
)
from tracking.discovery_windows import LEGACY_SOURCE, discovery_source
from tracking.video_master import Video

AWS_REGION = "ap-northeast-1"


@pytest.fixture
def notification_events_table(aws_credentials):
    """Create the production-shaped Notification Events table inside moto's fully mocked DynamoDB."""
    with mock_aws():
        client = boto3.client("dynamodb", region_name=AWS_REGION)
        client.create_table(
            TableName=NOTIFICATION_EVENTS_TABLE,
            AttributeDefinitions=[
                {"AttributeName": "eventDate", "AttributeType": "S"},
                {"AttributeName": "videoId", "AttributeType": "S"},
            ],
            KeySchema=[
                {"AttributeName": "eventDate", "KeyType": "HASH"},
                {"AttributeName": "videoId", "KeyType": "RANGE"},
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        yield


def _video(**overrides) -> Video:
    fields = {
        "video_id": "v1",
        "creator_id": "aizawa_ema",
        "title": "Test Video",
        "published_at": "2026-08-20T00:00:00Z",
        "discovered_at": "2026-09-03T18:00:00+09:00",
    }
    fields.update(overrides)
    return Video(**fields)


def test_recorded_event_is_queryable_by_its_discovery_date(notification_events_table):
    record_new_video_events([_video()])

    events = list_events_for_date("2026-09-03")

    assert len(events) == 1
    assert events[0]["videoId"] == "v1"
    assert events[0]["creatorId"] == "aizawa_ema"
    assert events[0]["discoveredAt"] == "2026-09-03T18:00:00+09:00"


def test_the_event_marks_a_short_so_the_dispatcher_can_deliver_it_only_to_clients_that_enabled_shorts(notification_events_table):
    record_new_video_events(
        [
            _video(video_id="ordinary", topic="mv", content_type="upload"),
            _video(video_id="short", topic="mv", content_type="short"),
            _video(video_id="unclassified"),
        ]
    )

    events = {event["videoId"]: event for event in list_events_for_date("2026-09-03")}

    assert "contentType" not in events["ordinary"]
    assert events["short"]["contentType"] == "short"
    assert "contentType" not in events["unclassified"]
    assert all("topic" not in event for event in events.values())  # Short is a format; no topic is stored on the event


def test_list_events_for_date_only_returns_that_dates_events(notification_events_table):
    record_new_video_events([_video(video_id="v1", discovered_at="2026-09-02T18:00:00+09:00")])
    record_new_video_events([_video(video_id="v2", discovered_at="2026-09-03T18:00:00+09:00")])

    assert {e["videoId"] for e in list_events_for_date("2026-09-02")} == {"v1"}
    assert {e["videoId"] for e in list_events_for_date("2026-09-03")} == {"v2"}


def test_list_events_for_date_returns_empty_list_when_none_recorded(notification_events_table):
    assert list_events_for_date("2026-01-01") == []


def test_record_new_video_events_is_a_no_op_for_an_empty_list(notification_events_table):
    record_new_video_events([])

    assert list_events_for_date("2026-09-03") == []


def test_video_without_discovered_at_is_rejected(notification_events_table):
    with pytest.raises(NotificationEventsStoreError):
        record_new_video_events([_video(discovered_at=None)])


def test_record_raises_store_error_when_table_is_missing(aws_credentials):
    with mock_aws():
        with pytest.raises(NotificationEventsStoreError):
            record_new_video_events([_video()])


def test_a_botocore_error_is_also_converted_to_the_store_error(notification_events_table, monkeypatch):
    """EndpointConnectionError (and other BotoCoreError subclasses) are a
    separate exception family from ClientError — catching only ClientError
    would let this escape record_new_video_events() as a raw exception,
    bypassing main.py's NotificationEventsStoreError-only best-effort catch
    and failing an otherwise-successful collection run."""
    from stores import notification_events_store

    class _FakeTable:
        def put_item(self, **_kwargs):
            raise EndpointConnectionError(endpoint_url="https://dynamodb.example.invalid")

    monkeypatch.setattr(notification_events_store, "_resource", lambda: type("R", (), {"Table": lambda self, name: _FakeTable()})())

    with pytest.raises(NotificationEventsStoreError):
        record_new_video_events([_video()])


def test_an_event_carries_the_durable_fields_the_scheduled_delivery_path_needs(notification_events_table):
    record_new_video_events([_video()], discovery_source=discovery_source("1300"))

    event = list_events_for_date("2026-09-03")[0]

    assert event["eventId"] == "new_video:v1" == new_video_event_id("v1")
    assert event["publishedAt"] == "2026-08-20T00:00:00Z"
    assert event["discoverySource"] == "discovery_window:1300"
    assert event["notificationEligible"] is True


def test_the_default_source_marks_an_event_not_written_by_a_discovery_window(notification_events_table):
    record_new_video_events([_video()])

    assert list_events_for_date("2026-09-03")[0]["discoverySource"] == LEGACY_SOURCE


def test_recording_the_same_discovery_again_keeps_the_first_write_and_reports_nothing_new(notification_events_table):
    first = record_new_video_events([_video(title="first title")], discovery_source=discovery_source("0900"))
    again = record_new_video_events([_video(title="second title")], discovery_source=discovery_source("1300"))

    events = list_events_for_date("2026-09-03")
    assert (first, again) == (1, 0)
    assert len(events) == 1
    assert events[0]["title"] == "first title"
    assert events[0]["discoverySource"] == "discovery_window:0900"


def test_a_mixed_batch_records_only_the_events_that_do_not_exist_yet(notification_events_table):
    record_new_video_events([_video(video_id="v1")])

    recorded = record_new_video_events([_video(video_id="v1"), _video(video_id="v2")])

    assert recorded == 1
    assert {event["videoId"] for event in list_events_for_date("2026-09-03")} == {"v1", "v2"}


def test_a_rediscovery_on_a_later_date_is_a_second_row_that_consumers_dedupe_by_video_id(notification_events_table):
    record_new_video_events([_video(discovered_at="2026-09-03T23:00:00+09:00")])
    record_new_video_events([_video(discovered_at="2026-09-04T00:00:00+09:00")])

    first = list_events_for_date("2026-09-03")
    second = list_events_for_date("2026-09-04")
    assert [e["videoId"] for e in first] == [e["videoId"] for e in second] == ["v1"]
    assert first[0]["eventId"] == second[0]["eventId"]  # the logical identity a consumer dedupes on
