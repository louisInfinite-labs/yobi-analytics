import boto3
import pytest
from botocore.exceptions import EndpointConnectionError
from moto import mock_aws

from stores.notification_events_store import (
    NOTIFICATION_EVENTS_TABLE,
    PREMIERE_ARCHIVED_PHASE,
    NotificationEventsStoreError,
    list_events_for_date,
    new_video_event_id,
    premiere_archived_event_id,
    record_new_video_events,
    record_premiere_archived_event,
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


MAXRES_URL = "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg"
SD_URL = "https://i.ytimg.com/vi/dQw4w9WgXcQ/sddefault.jpg"


def test_the_event_carries_the_discovery_time_thumbnail_url_only_when_the_video_has_one(notification_events_table):
    """thumbnailUrl is the Video's own (already obtained) value; a video without one gets no field, exactly like an event written before the field."""
    record_new_video_events(
        [_video(video_id="dQw4w9WgXcQ", thumbnail_url=MAXRES_URL), _video(video_id="nothumb"), _video(video_id="emptythumb", thumbnail_url="")]
    )

    events = {event["videoId"]: event for event in list_events_for_date("2026-09-03")}

    assert events["dQw4w9WgXcQ"]["thumbnailUrl"] == MAXRES_URL
    assert "thumbnailUrl" not in events["nothumb"]
    assert "thumbnailUrl" not in events["emptythumb"]
    # every pre-existing field is unchanged
    assert {key: value for key, value in events["dQw4w9WgXcQ"].items() if key != "thumbnailUrl"} == {key: value for key, value in events["nothumb"].items()} | {
        "videoId": "dQw4w9WgXcQ",
        "eventId": new_video_event_id("dQw4w9WgXcQ"),
    }


class _CountingTable:
    """Delegates to the real moto table and records every method the store calls on it."""

    def __init__(self, table, calls):
        """Wrap `table`, appending each called method name to `calls`."""
        self._table = table
        self._calls = calls

    def __getattr__(self, name):
        """Return the real attribute, recording method calls."""
        attribute = getattr(self._table, name)
        if callable(attribute):

            def recorded(*args, **kwargs):
                self._calls.append(name)
                return attribute(*args, **kwargs)

            return recorded
        return attribute


def test_adding_the_thumbnail_field_does_not_add_any_dynamodb_operation(notification_events_table, monkeypatch):
    """One conditional put_item per newly discovered video -- with or without a thumbnail -- and nothing else (no update, no extra write or read)."""
    from stores import notification_events_store

    real_resource = notification_events_store._resource()
    calls: list[str] = []

    class _Resource:
        def Table(self, name):
            """The counting wrapper around the real table."""
            return _CountingTable(real_resource.Table(name), calls)

    monkeypatch.setattr(notification_events_store, "_resource", lambda: _Resource())

    recorded = record_new_video_events([_video(video_id="a", thumbnail_url=MAXRES_URL), _video(video_id="b")])

    assert recorded == 2
    assert calls == ["put_item", "put_item"]


def test_a_recorded_events_thumbnail_reaches_the_push_payload_and_only_a_confirmed_maxres_is_used(notification_events_table):
    """Event -> store -> payload: Maxres when the stored URL confirms it; HQ for a smaller stored size, a legacy event without the field, or a foreign video's URL."""
    from notifications.notification_payload import notification_data

    record_new_video_events(
        [
            _video(video_id="dQw4w9WgXcQ", thumbnail_url=MAXRES_URL),
            _video(video_id="aaaaaaaaaaa", thumbnail_url="https://i.ytimg.com/vi/aaaaaaaaaaa/sddefault.jpg"),
            _video(video_id="bbbbbbbbbbb"),
            _video(video_id="ccccccccccc", thumbnail_url=MAXRES_URL),  # another video's Maxres URL stored by mistake
        ]
    )
    events = {event["videoId"]: event for event in list_events_for_date("2026-09-03")}

    def image(video_id: str) -> str:
        return notification_data({"videoId": video_id}, video_id=video_id, creator_id="x", creators_by_id={}, known_thumbnail_url=events[video_id].get("thumbnailUrl"))["image"]

    assert image("dQw4w9WgXcQ") == MAXRES_URL
    assert image("aaaaaaaaaaa") == "https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg"
    assert image("bbbbbbbbbbb") == "https://i.ytimg.com/vi/bbbbbbbbbbb/hqdefault.jpg"
    assert image("ccccccccccc") == "https://i.ytimg.com/vi/ccccccccccc/hqdefault.jpg"


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


# ============ the Premiere archive-confirmation phase (record_premiere_archived_event) ============


def test_the_archived_event_never_collides_with_the_videos_own_announcement_row_even_on_the_same_day(notification_events_table):
    """Both phases recorded for the same video on the same calendar day: two distinct rows, not a conditional-write collision."""
    record_new_video_events([_video(video_id="v1", discovered_at="2026-09-03T10:00:00+09:00")])

    recorded = record_premiere_archived_event(
        video_id="v1", creator_id="aizawa_ema", title="Premiere Archive", thumbnail_url=None, confirmed_at="2026-09-03T20:00:00+09:00"
    )

    assert recorded is True
    [announced, archived] = sorted(list_events_for_date("2026-09-03"), key=lambda e: e["videoId"])
    assert announced["videoId"] == "v1" and "eventPhase" not in announced
    assert archived["videoId"] == "v1#premiere_archived" and archived["eventPhase"] == PREMIERE_ARCHIVED_PHASE
    assert archived["eventId"] == premiere_archived_event_id("v1") != new_video_event_id("v1")


def test_the_archived_event_is_recorded_once_a_repeat_call_changes_nothing(notification_events_table):
    first = record_premiere_archived_event(
        video_id="v1", creator_id="aizawa_ema", title="Premiere Archive", thumbnail_url=None, confirmed_at="2026-09-03T20:00:00+09:00"
    )
    second = record_premiere_archived_event(
        video_id="v1", creator_id="aizawa_ema", title="A different title", thumbnail_url=None, confirmed_at="2026-09-03T20:05:00+09:00"
    )

    assert first is True and second is False
    [event] = list_events_for_date("2026-09-03")
    assert event["title"] == "Premiere Archive"  # the second call never overwrote the first


def test_the_archived_event_omits_contentType_so_it_is_treated_as_an_ordinary_video_not_a_short(notification_events_table):
    record_premiere_archived_event(
        video_id="v1", creator_id="aizawa_ema", title="Premiere Archive", thumbnail_url=None, confirmed_at="2026-09-03T20:00:00+09:00"
    )

    [event] = list_events_for_date("2026-09-03")
    assert "contentType" not in event
