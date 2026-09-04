import boto3
import pytest
from botocore.exceptions import EndpointConnectionError
from moto import mock_aws

from notification_events_store import (
    NOTIFICATION_EVENTS_TABLE,
    NotificationEventsStoreError,
    list_events_for_date,
    record_new_video_events,
)
from video_master import Video

AWS_REGION = "ap-northeast-1"


@pytest.fixture(autouse=True)
def aws_credentials(monkeypatch):
    """moto still requires boto3 to resolve *some* credentials; these never reach real AWS."""
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_SECURITY_TOKEN", "testing")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", AWS_REGION)


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
    import notification_events_store

    class _FakeTable:
        def batch_writer(self):
            raise EndpointConnectionError(endpoint_url="https://dynamodb.example.invalid")

    monkeypatch.setattr(notification_events_store, "_resource", lambda: type("R", (), {"Table": lambda self, name: _FakeTable()})())

    with pytest.raises(NotificationEventsStoreError):
        record_new_video_events([_video()])
