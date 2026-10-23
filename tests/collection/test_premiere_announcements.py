"""The Collector's Premiere announcement step (collection/premiere_announcements.py), wired into run_discovery.

The scenarios use the three real upcoming Premieres Holodex already exposed before their start (2026-10-23/24/25 19:00 JST) with a controlled persisted
snapshot and an uploads playlist that does NOT list them -- the situation that used to leave them undiscovered until they started. Events go through the
real events store on moto's mocked DynamoDB; the slot dispatcher is driven through its own harness. No artificial production event is ever created.
"""

from __future__ import annotations

import dataclasses
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import boto3
import pytest
from moto import mock_aws

from api import provisional_discoveries
from collection import main as main_module
from collection import premiere_announcements
from collection.youtube_client import QuotaExhaustedError, YouTubeAPIError, get_upcoming_premiere_facts
from notifications import new_video_dispatcher
from stores import notification_delivery_log_store, notification_events_store, premiere_announcements_store, premiere_archive_times_store
from stores.notification_events_store import NOTIFICATION_EVENTS_TABLE, list_events_for_date, record_premiere_archived_event
from stores.remote_config_store import REMOTE_CONFIG_TABLE
from tests.collection.test_main import _creator, _frozen_datetime, _video
from tests.notifications.new_video_harness import default_creator, fake_delivery_log, install_world, preference_value
from tracking.video_master import Video

AWS_REGION = "ap-northeast-1"
JST = ZoneInfo("Asia/Tokyo")

KD0NT = "Kd0nT-tybTA"  # 2026-10-23 19:00 JST
XDYWW = "xdyWWbWCaFY"  # 2026-10-24 19:00 JST
GSQ = "22sFpGEgqAc"  # 2026-10-25 19:00 JST
STARTS = {
    KD0NT: datetime(2026, 10, 23, 19, 0, tzinfo=JST),
    XDYWW: datetime(2026, 10, 24, 19, 0, tzinfo=JST),
    GSQ: datetime(2026, 10, 25, 19, 0, tzinfo=JST),
}
DAY1_RUN = datetime(2026, 10, 22, 20, 0, tzinfo=JST)  # the 20:00 JST discovery window
DAY2_0900 = datetime(2026, 10, 23, 9, 0, tzinfo=JST)
CHANNEL = "UC_test"
CREATION_DATE = "2026-10-19T09:12:13+00:00"
WINDOW = "2000"


def _stream(video_id: str, start: datetime, *, status: str = "upcoming", creator_id: str = "aizawa_ema") -> dict:
    """One entry of the persisted shared snapshot (the shape api.read_api.fetch_live_streams_from_holodex stores)."""
    return {
        "videoId": video_id,
        "creatorId": creator_id,
        "channelName": "Ema",
        "title": f"Stream {video_id}",
        "status": status,
        "scheduledStart": start.isoformat(),
        "actualStart": None,
    }


def _premiere_facts(video_id: str, *, channel: str = CHANNEL) -> dict:
    """What get_upcoming_premiere_facts reports for a genuine upcoming Premiere."""
    start = STARTS[video_id].isoformat()
    return {
        "kind": "premiere",
        "title": f"Premiere {video_id}",
        "channelId": channel,
        "publishedAt": CREATION_DATE,  # what YouTube reports for an upcoming Premiere: the day it was created, long before it airs
        "scheduledStartTime": start,
        "thumbnailUrl": f"https://i.ytimg.com/vi/{video_id}/maxresdefault.jpg",
    }


class World:
    """The controlled environment of one scenario: the persisted snapshot, YouTube's answers, the uploads playlist, and what the run wrote."""

    def __init__(self) -> None:
        self.streams = [_stream(video_id, start) for video_id, start in STARTS.items()]
        self.facts = {video_id: _premiere_facts(video_id) for video_id in STARTS}
        self.playlist: list[Video] = []
        self.fetch_calls: list[list[str]] = []
        self.upserted: list[list[Video]] = []

    def run(self, at: datetime = DAY1_RUN, window: str = WINDOW, monkeypatch=None) -> int:
        """One run_discovery at the given JST instant."""
        monkeypatch.setattr(main_module, "datetime", _frozen_datetime(at))
        return main_module.run_discovery(window)


@pytest.fixture
def world(monkeypatch, aws_credentials):
    """A mocked AWS (events + remote-config tables) and a World wired into run_discovery. The feature flag is ON; tests of the flag turn it off."""
    with mock_aws():
        client = boto3.client("dynamodb", region_name=AWS_REGION)
        client.create_table(
            TableName=NOTIFICATION_EVENTS_TABLE,
            AttributeDefinitions=[{"AttributeName": "eventDate", "AttributeType": "S"}, {"AttributeName": "videoId", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "eventDate", "KeyType": "HASH"}, {"AttributeName": "videoId", "KeyType": "RANGE"}],
            BillingMode="PAY_PER_REQUEST",
        )
        client.create_table(
            TableName=REMOTE_CONFIG_TABLE,
            AttributeDefinitions=[{"AttributeName": "clientId", "AttributeType": "S"}, {"AttributeName": "configKey", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "clientId", "KeyType": "HASH"}, {"AttributeName": "configKey", "KeyType": "RANGE"}],
            GlobalSecondaryIndexes=[{"IndexName": "configKey-index", "KeySchema": [{"AttributeName": "configKey", "KeyType": "HASH"}], "Projection": {"ProjectionType": "ALL"}}],
            BillingMode="PAY_PER_REQUEST",
        )
        w = World()

        def fetch_facts(youtube, video_ids):
            """Records the ids asked about and answers from the scenario's YouTube facts."""
            w.fetch_calls.append(list(video_ids))
            return {video_id: w.facts[video_id] for video_id in video_ids if video_id in w.facts}

        monkeypatch.setenv(premiere_announcements.ENABLED_ENV, "1")
        monkeypatch.setattr(main_module, "get_api_key", lambda: "fake-key")
        monkeypatch.setattr(main_module, "build_youtube_client", lambda api_key: object())
        monkeypatch.setattr(main_module, "load_videos", lambda: [_video("already_known")])
        monkeypatch.setattr(main_module, "get_active_creators", lambda: [_creator(youtube_channel_id=CHANNEL)])

        def discover_creator(youtube, creator, known_ids, *, discovered_at):
            """What the real uploads-playlist discovery returns: the playlist's videos, stamped with this run's discoveredAt."""
            videos = [dataclasses.replace(video, discovered_at=discovered_at) for video in w.playlist]
            return [video.video_id for video in videos], videos

        monkeypatch.setattr(main_module, "_discover_creator", discover_creator)
        monkeypatch.setattr(main_module, "upsert_videos", w.upserted.append)
        monkeypatch.setattr(main_module, "record_new_video_events", notification_events_store.record_new_video_events)
        monkeypatch.setattr(premiere_announcements, "read_snapshot_streams", lambda: list(w.streams))
        monkeypatch.setattr(premiere_announcements, "get_upcoming_premiere_facts", fetch_facts)
        # The slot dispatcher scenarios need no real VAPID credentials or creator master file (the same stubs tests/notifications/conftest.py installs).
        monkeypatch.setattr(new_video_dispatcher, "get_vapid_credentials", lambda: ("pem", {"sub": "mailto:a@b.com"}))
        monkeypatch.setattr(new_video_dispatcher, "load_creators", lambda: [default_creator()])
        monkeypatch.setattr(
            notification_delivery_log_store,
            "delivered_video_ids",
            lambda client_id, video_ids, *, now=None: {v for v in video_ids if notification_delivery_log_store.already_delivered(client_id, v)},
        )
        # Holodex is never asked by this step: any call fails the scenario loudly.
        monkeypatch.setattr("api.read_api.holodex_get", _forbidden)
        monkeypatch.setattr("api.read_api.fetch_live_streams_from_holodex", _forbidden)
        yield w


def _forbidden(*_args, **_kwargs):
    """Stand-in for a Holodex call: fails the scenario if the step ever reaches for Holodex."""
    raise AssertionError("the Premiere announcement step must not call Holodex")


def _all_events(*dates: str) -> list[dict]:
    """Every event recorded on the given dates."""
    return [event for date in dates for event in list_events_for_date(date)]


def _run(world: World, monkeypatch, at: datetime = DAY1_RUN, window: str = WINDOW) -> int:
    """One run_discovery of the scenario at the given JST instant and discovery window."""
    return world.run(at, window, monkeypatch)


def test_snapshot_premieres_missing_from_the_uploads_playlist_are_announced_by_the_collector(world, monkeypatch):
    """A Premiere present in the snapshot but absent from the uploads playlist is announced by the Collector."""
    assert world.playlist == []

    assert _run(world, monkeypatch) == 0

    events = _all_events("2026-10-22")
    assert {event["videoId"] for event in events} == {KD0NT, XDYWW, GSQ}
    assert all(event["discoverySource"] == "discovery_window:2000" for event in events)
    assert all(event["discoveredAt"] == DAY1_RUN.isoformat() for event in events)


def test_each_premiere_gets_one_ordinary_new_video_event(world, monkeypatch):
    """Each Premiere gets exactly one standard new-video event (the ordinary shape, nothing exotic)."""
    _run(world, monkeypatch)

    by_id = {event["videoId"]: event for event in _all_events("2026-10-22")}
    event = by_id[KD0NT]
    assert event["eventId"] == f"new_video:{KD0NT}"
    assert event["creatorId"] == "aizawa_ema"
    assert event["title"] == f"Premiere {KD0NT}"
    assert event["publishedAt"] == CREATION_DATE  # YouTube's own value, stored untouched
    assert event["scheduledStartTime"] == STARTS[KD0NT].isoformat()  # the effective time travels beside it
    assert event["notificationEligible"] is True
    assert "eventPhase" not in event and "contentType" not in event
    assert event["thumbnailUrl"].endswith(f"{KD0NT}/maxresdefault.jpg")
    assert len(by_id) == 3


def test_an_ordinary_scheduled_livestream_creates_no_event_and_is_not_reclassified(world, monkeypatch):
    """An ordinary scheduled livestream is never announced, and is never asked about twice."""
    world.streams = [_stream("LIVE0000001", STARTS[KD0NT])]
    world.facts = {"LIVE0000001": {"kind": "livestream", "title": "Stream", "channelId": CHANNEL, "publishedAt": None, "scheduledStartTime": STARTS[KD0NT].isoformat(), "thumbnailUrl": None}}

    _run(world, monkeypatch)
    _run(world, monkeypatch, at=DAY1_RUN + timedelta(hours=2), window="2200")

    assert _all_events("2026-10-22") == []
    assert world.fetch_calls == [["LIVE0000001"]]  # decided once, never asked again
    assert premiere_announcements_store.read_decisions()["LIVE0000001"]["premiere"] is False


def test_an_ambiguous_video_is_skipped_and_asked_again_next_window(world, monkeypatch):
    """A video YouTube gives no definitive answer for is skipped, never guessed, and asked about again next window."""
    world.streams = [_stream("AMBIGUOUS01", STARTS[KD0NT])]
    world.facts = {}

    _run(world, monkeypatch)
    _run(world, monkeypatch, at=DAY1_RUN + timedelta(hours=2), window="2200")

    assert _all_events("2026-10-22") == []
    assert premiere_announcements_store.read_decisions() == {}
    assert world.fetch_calls == [["AMBIGUOUS01"], ["AMBIGUOUS01"]]


def test_announcing_needs_no_video_master_row_and_writes_none(world, monkeypatch):
    """No Video Master row is needed for the announcement, and none is written for it."""
    _run(world, monkeypatch)

    assert world.upserted == []
    assert len(_all_events("2026-10-22")) == 3


def test_repeated_runs_change_nothing(world, monkeypatch):
    """Repeated runs are idempotent: no new request, no new event, and the unchanged decision record is not rewritten."""
    _run(world, monkeypatch)
    first_events = _all_events("2026-10-22")
    record_before = premiere_announcements_store.read_decisions()
    calls_before = len(world.fetch_calls)

    _run(world, monkeypatch, at=DAY1_RUN + timedelta(hours=2), window="2200")
    _run(world, monkeypatch, at=DAY1_RUN + timedelta(hours=4), window="0000")

    assert len(world.fetch_calls) == calls_before == 1
    assert _all_events("2026-10-22") == first_events
    assert premiere_announcements_store.read_decisions() == record_before  # same entries, same first-decision timestamps


def test_later_playlist_discovery_of_an_announced_premiere_records_no_second_event(world, monkeypatch):
    """The Premiere later listed by the uploads playlist is persisted but produces no second event."""
    _run(world, monkeypatch)
    world.playlist = [Video(video_id=KD0NT, creator_id="aizawa_ema", title=f"Premiere {KD0NT}", published_at=STARTS[KD0NT].isoformat())]

    _run(world, monkeypatch, at=DAY2_0900, window="0900")

    assert [video.video_id for batch in world.upserted for video in batch] == [KD0NT]  # Video Master still gets its row
    assert len(_all_events("2026-10-22", "2026-10-23")) == 3  # ... but no fourth event
    assert _all_events("2026-10-23") == []


def test_the_next_days_run_does_not_announce_the_same_premieres_again(world, monkeypatch):
    """Cross-day dedupe: the next day's run neither re-announces nor re-classifies what the previous day decided."""
    _run(world, monkeypatch)

    _run(world, monkeypatch, at=DAY2_0900, window="0900")

    assert _all_events("2026-10-23") == []
    assert len(world.fetch_calls) == 1


def test_the_announcements_are_delivered_only_at_the_users_next_slot(world, monkeypatch):
    """Delivery stays on the dispatcher's four user-configured slots: nothing is pushed at announcement time."""
    _run(world, monkeypatch)
    events = _all_events("2026-10-22")
    rows = fake_delivery_log(monkeypatch)
    four_slots = preference_value(deliveryWindows=["08:00", "12:00", "18:00", "22:00"])
    sent = install_world(monkeypatch, events=events, preferences={"c1": four_slots})

    new_video_dispatcher.run({}, None, now=datetime(2026, 10, 22, 20, 5, tzinfo=JST))  # the run that announced them
    assert sent == []
    new_video_dispatcher.run({}, None, now=datetime(2026, 10, 22, 22, 5, tzinfo=JST))  # the user's next slot
    assert sorted(payload["videoId"] for payload in sent) == sorted([KD0NT, XDYWW, GSQ])
    new_video_dispatcher.run({}, None, now=datetime(2026, 10, 22, 22, 35, tzinfo=JST))  # never delivered twice
    assert len(sent) == 3
    assert {key for key in rows} == {("c1", KD0NT), ("c1", XDYWW), ("c1", GSQ)}


def test_the_archive_event_is_separate_and_delivered_independently_of_the_announcement(world, monkeypatch):
    """The archive notification stays a separate, independently deliverable event."""
    world.streams = [_stream(KD0NT, STARTS[KD0NT])]
    _run(world, monkeypatch)
    rows = fake_delivery_log(monkeypatch)
    four_slots = preference_value(deliveryWindows=["08:00", "12:00", "18:00", "22:00"])
    announced_events = _all_events("2026-10-22")
    sent = install_world(monkeypatch, events=announced_events, preferences={"c1": four_slots})
    new_video_dispatcher.run({}, None, now=datetime(2026, 10, 22, 22, 5, tzinfo=JST))
    assert rows == {("c1", KD0NT): "delivered"}

    assert record_premiere_archived_event(video_id=KD0NT, creator_id="aizawa_ema", title="Archive", thumbnail_url=None, confirmed_at=datetime(2026, 10, 23, 19, 40, tzinfo=JST).isoformat())
    all_events = _all_events("2026-10-22", "2026-10-23")
    archive_sent = install_world(monkeypatch, events=all_events, preferences={"c1": four_slots})
    new_video_dispatcher.run({}, None, now=datetime(2026, 10, 23, 22, 5, tzinfo=JST))

    assert rows == {("c1", KD0NT): "delivered", ("c1", f"{KD0NT}#premiere_archived"): "delivered"}
    assert len(sent) == 1 and len(archive_sent) == 1
    assert (archive_sent[0]["videoId"], archive_sent[0]["url"]) == (KD0NT, "/creator/aizawa-ema")  # the deep link keeps the original videoId


def test_a_still_pending_announcement_is_superseded_by_the_archive_in_the_same_slot(world, monkeypatch):
    """Same-slot obsolete-announcement suppression is unchanged: the announcement this step created is skipped when the archive is also due."""
    world.streams = [_stream(KD0NT, STARTS[KD0NT])]
    _run(world, monkeypatch)
    record_premiere_archived_event(video_id=KD0NT, creator_id="aizawa_ema", title="Archive", thumbnail_url=None, confirmed_at=datetime(2026, 10, 22, 21, 0, tzinfo=JST).isoformat())
    rows = fake_delivery_log(monkeypatch)
    four_slots = preference_value(deliveryWindows=["08:00", "12:00", "18:00", "22:00"])
    sent = install_world(monkeypatch, events=_all_events("2026-10-22"), preferences={"c1": four_slots})

    new_video_dispatcher.run({}, None, now=datetime(2026, 10, 22, 22, 5, tzinfo=JST))

    assert rows == {("c1", f"{KD0NT}#premiere_archived"): "delivered"}
    assert len(sent) == 1


def test_a_premiere_already_archived_is_never_announced_as_upcoming(world, monkeypatch):
    """A Premiere whose archive is already confirmed (late discovery) is never announced as upcoming."""
    premiere_archive_times_store.record_premiere_archive_times({KD0NT: "2026-10-22T09:00:00+00:00"}, now=DAY1_RUN)

    _run(world, monkeypatch)

    assert {event["videoId"] for event in _all_events("2026-10-22")} == {XDYWW, GSQ}
    assert all(KD0NT not in call for call in world.fetch_calls)


def test_a_stream_that_is_no_longer_upcoming_or_already_due_is_not_announced(world, monkeypatch):
    """Only a stream that is still upcoming and not yet due is a candidate; nothing is asked of YouTube for the rest."""
    world.streams = [_stream(KD0NT, STARTS[KD0NT], status="live"), _stream(XDYWW, DAY1_RUN - timedelta(minutes=5))]

    _run(world, monkeypatch)

    assert _all_events("2026-10-22") == []
    assert world.fetch_calls == []


def test_a_facts_scheduled_start_that_has_already_passed_is_not_announced(world, monkeypatch):
    """YouTube reporting a start that already passed means announcing it as upcoming would mislead: decided as not announced."""
    world.streams = [_stream(KD0NT, STARTS[KD0NT])]
    stale = dict(world.facts[KD0NT], scheduledStartTime=(DAY1_RUN - timedelta(minutes=1)).isoformat())
    world.facts = {KD0NT: stale}

    _run(world, monkeypatch)

    assert _all_events("2026-10-22") == []
    assert premiere_announcements_store.read_decisions()[KD0NT]["premiere"] is False


def test_a_premiere_of_another_channel_is_not_announced_for_the_creator(world, monkeypatch):
    """A Premiere whose channel is not the creator's channel is never announced for that creator."""
    world.streams = [_stream(KD0NT, STARTS[KD0NT])]
    world.facts = {KD0NT: _premiere_facts(KD0NT, channel="UC_someone_else")}

    _run(world, monkeypatch)

    assert _all_events("2026-10-22") == []


def test_only_its_own_record_is_written_and_livestream_state_is_untouched(world, monkeypatch):
    """Livestream reminders and the Simultaneous Livestream notice are untouched: this step writes one record of its own and nothing livestream-related."""
    _run(world, monkeypatch)

    items = boto3.client("dynamodb", region_name=AWS_REGION).scan(TableName=REMOTE_CONFIG_TABLE)["Items"]

    assert {item["configKey"]["S"] for item in items} == {premiere_announcements_store.PREMIERE_ANNOUNCEMENTS_KEY}


def test_the_announcement_shows_under_its_original_video_id_without_duplicates(world, monkeypatch):
    """One canonical identity: Video List / Oshi Status see the original videoId once, before and after Video Master has the row."""
    _run(world, monkeypatch)
    events = _all_events("2026-10-22")
    monkeypatch.setattr(provisional_discoveries, "_events_for_date", lambda event_date, moment: [e for e in events if e["eventDate"] == event_date])
    monkeypatch.setattr(provisional_discoveries, "_records_for", lambda video_ids, moment: {})
    provisional_discoveries.clear_cache()
    now = datetime(2026, 10, 22, 9, 30, tzinfo=timezone.utc)

    rows = provisional_discoveries.with_provisional_discoveries([], "aizawa_ema", DAY1_RUN.isoformat(), now=now)
    assert sorted(row["videoId"] for row in rows) == sorted([KD0NT, XDYWW, GSQ])
    assert all(row["discoveredAt"] == DAY1_RUN.isoformat() for row in rows)
    assert {row["videoId"]: row["publishedAt"] for row in rows} == {video_id: start.isoformat() for video_id, start in STARTS.items()}  # effective time = scheduled start, never the creation date
    assert all(event["publishedAt"] == CREATION_DATE for event in events)  # while the stored source timestamp is untouched

    ranked = [{"videoId": KD0NT, "creatorId": "aizawa_ema", "title": "ranked"}]  # the playlist later added the Video Master row
    rows = provisional_discoveries.with_provisional_discoveries(ranked, "aizawa_ema", DAY1_RUN.isoformat(), now=now)
    assert [row["videoId"] for row in rows].count(KD0NT) == 1


def test_the_announcement_carries_no_archive_state_and_leaves_the_archive_record_alone(world, monkeypatch):
    """Archive-time and NEW rules are untouched: the announcement carries no archive state and the durable archive record is not written."""
    _run(world, monkeypatch)

    assert all("archiveAvailableAt" not in event for event in _all_events("2026-10-22"))
    assert premiere_archive_times_store.read_premiere_archive_times() == {}


def test_classification_cost_is_one_batched_request_and_none_when_nothing_is_new(world, monkeypatch):
    """No additional external polling: one batched request at most, none when nothing is new, and nothing at all with the flag off."""
    _run(world, monkeypatch)
    _run(world, monkeypatch, at=DAY1_RUN + timedelta(hours=2), window="2200")

    assert len(world.fetch_calls) == 1
    assert sorted(world.fetch_calls[0]) == sorted([KD0NT, XDYWW, GSQ])  # all three ids in ONE videos.list call


def test_with_the_flag_off_the_collector_neither_reads_the_snapshot_nor_asks_youtube(world, monkeypatch):
    """Off by default: with the flag unset the step reads no snapshot, makes no YouTube request and records no event."""
    monkeypatch.delenv(premiere_announcements.ENABLED_ENV)
    monkeypatch.setattr(premiere_announcements, "read_snapshot_streams", _forbidden)

    assert _run(world, monkeypatch) == 0

    assert world.fetch_calls == []
    assert _all_events("2026-10-22") == []


def test_the_ordinary_playlist_discovery_is_unchanged_by_the_step(world, monkeypatch):
    """The uploads-playlist discovery keeps persisting and announcing ordinary videos exactly as before, alongside the Premiere events."""
    world.playlist = [_video("v_playlist")]

    assert _run(world, monkeypatch) == 0

    assert [video.video_id for batch in world.upserted for video in batch] == ["v_playlist"]
    assert {event["videoId"] for event in _all_events("2026-10-22")} == {"v_playlist", KD0NT, XDYWW, GSQ}


def test_a_failing_step_never_fails_the_ordinary_discovery(world, monkeypatch):
    """Failure behaviour: the step is best-effort and quota-aware."""
    world.playlist = [_video("v_playlist")]

    def _broken(youtube, video_ids):
        """A classification call that fails with an unexpected error."""
        raise RuntimeError("boom")

    monkeypatch.setattr(premiere_announcements, "get_upcoming_premiere_facts", _broken)

    assert _run(world, monkeypatch) == 0

    assert [video.video_id for batch in world.upserted for video in batch] == ["v_playlist"]
    assert {event["videoId"] for event in _all_events("2026-10-22")} == {"v_playlist"}  # nothing decided, so the next window retries
    assert premiere_announcements_store.read_decisions() == {}


def test_quota_exhaustion_in_the_step_never_fails_the_run(world, monkeypatch):
    """Quota running out inside the optional step is a warning: the run still succeeds (no retry, no dead letter) with the playlist work persisted."""
    world.playlist = [_video("v_playlist")]

    def _quota(youtube, video_ids):
        """A classification call that reports an exhausted YouTube quota."""
        raise QuotaExhaustedError("quota")

    monkeypatch.setattr(premiere_announcements, "get_upcoming_premiere_facts", _quota)

    assert _run(world, monkeypatch) == 0

    assert [video.video_id for batch in world.upserted for video in batch] == ["v_playlist"]
    assert {event["videoId"] for event in _all_events("2026-10-22")} == {"v_playlist"}
    assert premiere_announcements_store.read_decisions() == {}


def test_the_step_runs_only_after_the_ordinary_discovery_is_fully_persisted(world, monkeypatch):
    """Ordinary events and the Video Master write happen BEFORE the optional step touches YouTube, so a crash or timeout in it can lose none of that work."""
    world.playlist = [_video("v_playlist")]
    order: list[str] = []
    real_record = notification_events_store.record_new_video_events
    monkeypatch.setattr(main_module, "record_new_video_events", lambda videos, **kw: order.append(f"events:{len(videos)}") or real_record(videos, **kw))
    monkeypatch.setattr(main_module, "upsert_videos", lambda videos: order.append("video_master"))
    original_fetch = premiere_announcements.get_upcoming_premiere_facts

    def _tracking_fetch(youtube, video_ids):
        """Notes when YouTube is asked, then answers as usual."""
        order.append("classification")
        return original_fetch(youtube, video_ids)

    monkeypatch.setattr(premiere_announcements, "get_upcoming_premiere_facts", _tracking_fetch)

    assert _run(world, monkeypatch) == 0

    assert order[:3] == ["events:1", "video_master", "classification"]


def test_the_discoverys_own_quota_exhaustion_still_fails_the_run_and_skips_the_step(world, monkeypatch):
    """The ordinary discovery keeps its exit-code behaviour: its quota exhaustion fails the run, and the optional step is not attempted afterwards."""

    def _discover_quota(youtube, creator, known_ids, *, discovered_at):
        """The uploads-playlist discovery runs out of quota."""
        raise QuotaExhaustedError("quota")

    monkeypatch.setattr(main_module, "_discover_creator", _discover_quota)

    assert _run(world, monkeypatch) == 1

    assert world.fetch_calls == []


def test_a_failed_decision_write_never_fails_the_run_and_the_retry_creates_no_duplicate_event(world, monkeypatch):
    """Events are written first. If the decisions cannot be written the run still succeeds; the next window re-classifies and the conditional event write dedupes."""
    real_record = premiere_announcements_store.record_decisions
    monkeypatch.setattr(premiere_announcements_store, "record_decisions", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("down")))

    assert _run(world, monkeypatch) == 0
    assert premiere_announcements_store.read_decisions() == {}
    events_before = _all_events("2026-10-22")
    assert len(events_before) == 3

    monkeypatch.setattr(premiere_announcements_store, "record_decisions", real_record)
    _run(world, monkeypatch, at=DAY1_RUN + timedelta(hours=2), window="2200")

    assert _all_events("2026-10-22") == events_before  # same three events, first write kept
    assert len(world.fetch_calls) == 2  # the one extra classification request is the whole cost of the lost write


def test_a_failed_event_write_leaves_the_premieres_undecided_for_the_next_window(world, monkeypatch):
    """No decision is recorded when the events could not be written, so the next window announces them."""
    def _failing(videos, **kwargs):
        """An events store that is down."""
        raise notification_events_store.NotificationEventsStoreError("down")

    monkeypatch.setattr(main_module, "record_new_video_events", _failing)

    assert _run(world, monkeypatch) == 0

    assert premiere_announcements_store.read_decisions() == {}
    monkeypatch.setattr(main_module, "record_new_video_events", notification_events_store.record_new_video_events)
    _run(world, monkeypatch, at=DAY1_RUN + timedelta(hours=2), window="2200")
    assert {event["videoId"] for event in _all_events("2026-10-22")} == {KD0NT, XDYWW, GSQ}


def test_an_empty_snapshot_announces_nothing_and_asks_nothing(world):
    """An empty snapshot is a no-op: no candidates, no request, nothing recorded."""
    summary = premiere_announcements.announce_upcoming_premieres(
        object(), [_creator(youtube_channel_id=CHANNEL)], {}, run_time=DAY1_RUN, source="discovery_window:2000", record_events=lambda *a, **k: 0, read_streams=lambda: []
    )

    assert summary == {"candidates": 0, "requests": 0, "announced": 0, "ordinary": 0}


def test_creators_without_discovery_are_never_announced(world, monkeypatch):
    """A creator with discovery disabled is outside this step like it is outside playlist discovery."""
    monkeypatch.setattr(main_module, "get_active_creators", lambda: [_creator(youtube_channel_id=CHANNEL, discovery_enabled=False)])

    _run(world, monkeypatch)

    assert _all_events("2026-10-22") == []
    assert world.fetch_calls == []


def test_an_id_the_playlist_discovers_in_the_same_run_is_not_announced_twice(world, monkeypatch):
    """An id the playlist discovers in this very run counts as known and is not classified or announced a second time."""
    world.playlist = [Video(video_id=KD0NT, creator_id="aizawa_ema", title="t", published_at=STARTS[KD0NT].isoformat())]

    _run(world, monkeypatch)

    events = _all_events("2026-10-22")
    assert sorted(event["videoId"] for event in events) == sorted([KD0NT, XDYWW, GSQ])
    assert all(KD0NT not in call for call in world.fetch_calls)


# The YouTube facts call itself.
class _Request:
    def __init__(self, response):
        self._response = response

    def execute(self):
        """Return the canned response."""
        return self._response


class _FakeYouTube:
    """Answers each videos.list call from `items_by_id`, recording the requested part and ids."""

    def __init__(self, items_by_id: dict[str, dict]):
        self.items_by_id = items_by_id
        self.calls: list[tuple[str, list[str]]] = []

    def videos(self):
        """The videos() resource is the fake itself."""
        return self

    def list(self, *, part, id):
        """Record the requested part and ids and answer for those the fake knows."""
        ids = id.split(",")
        self.calls.append((part, ids))
        return _Request({"items": [self.items_by_id[video_id] for video_id in ids if video_id in self.items_by_id]})


def _item(video_id: str, *, broadcast="upcoming", content_details=None, live_details=None, channel=CHANNEL) -> dict:
    """One videos.list response item with the fields the facts call reads."""
    item = {
        "id": video_id,
        "snippet": {"title": "t", "channelId": channel, "publishedAt": "2026-10-23T10:00:00Z", "liveBroadcastContent": broadcast, "thumbnails": {"high": {"url": "https://i.ytimg.com/vi/x/hqdefault.jpg"}}},
        "liveStreamingDetails": live_details if live_details is not None else {"scheduledStartTime": "2026-10-23T10:00:00Z"},
    }
    if content_details is not None:
        item["contentDetails"] = content_details
    return item


def test_facts_tell_a_premiere_from_a_livestream_and_leave_the_unknown_out():
    """A Premiere and a livestream are told apart by contentDetails.duration; every other answer is left out, never guessed."""
    youtube = _FakeYouTube(
        {
            "PREMIERE001": _item("PREMIERE001", content_details={"dimension": "2d"}),
            "LIVESTREAM01": _item("LIVESTREAM01", content_details={"duration": "P0D"}),
            "NODETAILS001": _item("NODETAILS001"),
            "STARTED00001": _item("STARTED00001", broadcast="live", content_details={"dimension": "2d"}, live_details={"scheduledStartTime": "x", "actualStartTime": "y"}),
        }
    )

    facts = get_upcoming_premiere_facts(youtube, ["PREMIERE001", "LIVESTREAM01", "NODETAILS001", "STARTED00001", "MISSING00001"])

    assert {video_id: entry["kind"] for video_id, entry in facts.items()} == {"PREMIERE001": "premiere", "LIVESTREAM01": "livestream"}
    assert facts["PREMIERE001"]["channelId"] == CHANNEL
    assert facts["PREMIERE001"]["scheduledStartTime"] == "2026-10-23T10:00:00Z"
    assert facts["PREMIERE001"]["thumbnailUrl"] == "https://i.ytimg.com/vi/x/hqdefault.jpg"
    assert youtube.calls == [("snippet,liveStreamingDetails,contentDetails", ["PREMIERE001", "LIVESTREAM01", "NODETAILS001", "STARTED00001", "MISSING00001"])]


def test_facts_split_into_one_request_per_fifty_ids():
    """One videos.list request per 50 ids, nothing more."""
    youtube = _FakeYouTube({})

    assert get_upcoming_premiere_facts(youtube, [f"id{n:09d}" for n in range(101)]) == {}

    assert [len(ids) for _, ids in youtube.calls] == [50, 50, 1]


# The per-run classification cap: at most MAX_CLASSIFIED_PER_RUN ids (three videos.list requests) per run, however many candidates the snapshot holds.
def _cap_candidates(count: int) -> tuple[list[str], list[dict]]:
    """`count` distinct upcoming snapshot entries that all belong to the test creator."""
    ids = [f"CAND{n:07d}" for n in range(count)]
    return ids, [_stream(video_id, STARTS[KD0NT]) for video_id in ids]


def _premiere_item(video_id: str) -> dict:
    """A videos.list item that classifies as an upcoming Premiere of the test creator's channel."""
    return _item(video_id, content_details={"dimension": "2d"})


def _announce_with(youtube, streams: list[dict], at: datetime = DAY1_RUN) -> dict:
    """One announcement step with the REAL batched facts call against `youtube`, the real stores, and a canned snapshot."""
    return premiere_announcements.announce_upcoming_premieres(
        youtube,
        [_creator(youtube_channel_id=CHANNEL)],
        {},
        run_time=at,
        source="discovery_window:2000",
        record_events=notification_events_store.record_new_video_events,
        read_streams=lambda: streams,
        fetch_facts=get_upcoming_premiere_facts,
    )


@pytest.mark.parametrize(
    ("count", "expected_requests"),
    [(0, 0), (1, 1), (50, 1), (51, 2), (100, 2), (101, 3), (150, 3), (151, 3), (400, 3)],
)
def test_the_request_count_per_run_follows_the_candidate_count_and_never_exceeds_three(world, count, expected_requests):
    """0 candidates cost nothing, each started block of 50 costs one request, and the run never asks about more than 150 ids."""
    ids, streams = _cap_candidates(count)
    youtube = _FakeYouTube({video_id: _premiere_item(video_id) for video_id in ids})

    summary = _announce_with(youtube, streams)

    assert len(youtube.calls) == expected_requests == summary["requests"]
    asked = [video_id for _part, batch in youtube.calls for video_id in batch]
    assert len(asked) == len(set(asked)) == min(count, premiere_announcements.MAX_CLASSIFIED_PER_RUN)
    assert all(len(batch) <= 50 for _part, batch in youtube.calls)
    assert summary["announced"] == min(count, 150)


def test_candidates_beyond_the_cap_are_deferred_to_later_runs_and_decided_ids_are_never_asked_again(world):
    """400 candidates drain over three runs (150 + 150 + 100); no id is asked twice, and the run after that makes no request at all."""
    ids, streams = _cap_candidates(400)
    youtube = _FakeYouTube({video_id: _premiere_item(video_id) for video_id in ids})

    sizes = []
    for _run_number in range(4):
        before = len(youtube.calls)
        _announce_with(youtube, streams)
        sizes.append(sum(len(batch) for _part, batch in youtube.calls[before:]))

    assert sizes == [150, 150, 100, 0]
    asked = [video_id for _part, batch in youtube.calls for video_id in batch]
    assert len(asked) == len(set(asked)) == 400  # nothing re-queried
    assert len(premiere_announcements_store.read_decisions()) == 400
    assert len(_all_events("2026-10-22")) == 400


def test_ambiguous_ids_stay_eligible_and_only_they_are_asked_again(world):
    """YouTube returning nothing definitive for some ids leaves them undecided; the next run asks only those, and decides them once YouTube answers."""
    ids, streams = _cap_candidates(30)
    unanswered = set(ids[:5])
    youtube = _FakeYouTube({video_id: _premiere_item(video_id) for video_id in ids if video_id not in unanswered})

    first = _announce_with(youtube, streams)
    assert first["announced"] == 25
    assert set(premiere_announcements_store.read_decisions()) == set(ids) - unanswered

    second = _announce_with(youtube, streams)
    assert second["candidates"] == 5 and second["announced"] == 0
    assert sorted(youtube.calls[-1][1]) == sorted(unanswered)  # exactly the ambiguous ones

    youtube.items_by_id.update({video_id: _premiere_item(video_id) for video_id in unanswered})
    third = _announce_with(youtube, streams)
    assert third["announced"] == 5
    assert set(premiere_announcements_store.read_decisions()) == set(ids)
    assert _announce_with(youtube, streams)["candidates"] == 0


def test_a_failed_request_records_nothing_and_every_candidate_stays_eligible(world):
    """A YouTube failure part-way through the batches raises out of the step with no event and no decision, so a healthy later run classifies all of them."""
    ids, streams = _cap_candidates(120)

    class _FailsOnSecondRequest(_FakeYouTube):
        """Answers the first videos.list call and fails the second one."""

        def list(self, *, part, id):
            """Fail the second request with a YouTube API error."""
            if len(self.calls) == 1:
                self.calls.append((part, id.split(",")))
                raise YouTubeAPIError("simulated failure")
            return super().list(part=part, id=id)

    youtube = _FailsOnSecondRequest({video_id: _premiere_item(video_id) for video_id in ids})

    with pytest.raises(YouTubeAPIError):
        _announce_with(youtube, streams)

    assert premiere_announcements_store.read_decisions() == {}
    assert _all_events("2026-10-22") == []
    healthy = _FakeYouTube({video_id: _premiere_item(video_id) for video_id in ids})
    assert _announce_with(healthy, streams)["announced"] == 120


# The YouTube request budget: one HTTP attempt per batch, no in-run retry, so a run can never exceed three requests.
class _ScriptedYouTube:
    """A videos().list().execute() chain that follows a script: an exception instance is raised, anything else is returned. The last outcome repeats."""

    def __init__(self, outcomes: list) -> None:
        self.outcomes = outcomes
        self.attempts = 0

    def videos(self):
        """The videos() resource is the fake itself."""
        return self

    def list(self, *, part, id):
        """Accept the request parameters; the outcome is decided on execute()."""
        return self

    def execute(self, num_retries=0):
        """Count one HTTP attempt and play the next scripted outcome."""
        outcome = self.outcomes[min(self.attempts, len(self.outcomes) - 1)]
        self.attempts += 1
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


@pytest.mark.parametrize("failing_status", [429, 500, 503])
def test_a_retryable_http_error_costs_exactly_one_attempt_and_is_not_retried(failing_status, monkeypatch):
    """The ordinary client retries such errors twice; the Premiere facts call must not, because every attempt can be charged a quota unit."""
    from tests.collection.test_youtube_client import _http_error

    monkeypatch.setattr("collection.youtube_client.time.sleep", lambda seconds: (_ for _ in ()).throw(AssertionError("no backoff sleep: there is no retry")))
    youtube = _ScriptedYouTube([_http_error(failing_status)])

    with pytest.raises(YouTubeAPIError):
        get_upcoming_premiere_facts(youtube, ["a", "b", "c"])

    assert youtube.attempts == 1


def test_a_network_error_costs_exactly_one_attempt(monkeypatch):
    """A transport failure is not retried either."""
    monkeypatch.setattr("collection.youtube_client.time.sleep", lambda seconds: (_ for _ in ()).throw(AssertionError("no backoff sleep: there is no retry")))
    youtube = _ScriptedYouTube([OSError("connection reset")])

    with pytest.raises(YouTubeAPIError):
        get_upcoming_premiere_facts(youtube, ["a"])

    assert youtube.attempts == 1


def test_exhausted_quota_stops_after_the_single_attempt():
    """quotaExceeded is classified as stop-all and surfaces as QuotaExhaustedError after one attempt."""
    from tests.collection.test_youtube_client import _http_error

    youtube = _ScriptedYouTube([_http_error(403, "quotaExceeded")])

    with pytest.raises(QuotaExhaustedError):
        get_upcoming_premiere_facts(youtube, ["a"])

    assert youtube.attempts == 1


@pytest.mark.parametrize("fail_at_batch", [None, 1, 2, 3])
def test_a_full_run_of_150_ids_never_makes_more_than_three_http_attempts(fail_at_batch):
    """Healthy: 3 attempts for 150 ids. A failure at batch N ends the call with exactly N attempts. No outcome exceeds 3."""
    from tests.collection.test_youtube_client import _http_error

    ok = {"items": []}
    outcomes = [ok] * (3 if fail_at_batch is None else fail_at_batch - 1) + ([] if fail_at_batch is None else [_http_error(503)])
    youtube = _ScriptedYouTube(outcomes)
    ids = [f"CAND{n:07d}" for n in range(premiere_announcements.MAX_CLASSIFIED_PER_RUN)]

    if fail_at_batch is None:
        assert get_upcoming_premiere_facts(youtube, ids) == {}
        assert youtube.attempts == 3
    else:
        with pytest.raises(YouTubeAPIError):
            get_upcoming_premiere_facts(youtube, ids)
        assert youtube.attempts == fail_at_batch
    assert youtube.attempts <= 3


def test_call_youtube_api_keeps_its_default_retries_and_honours_a_smaller_budget(monkeypatch):
    """The shared helper is unchanged for every other caller (three attempts), and max_attempts=1 means one attempt and no sleep."""
    from tests.collection.test_youtube_client import _http_error
    from collection.youtube_client import MAX_RETRIES, call_youtube_api

    monkeypatch.setattr("collection.youtube_client.time.sleep", lambda seconds: None)
    default_calls: list[int] = []
    single_calls: list[int] = []

    def _always_503(calls):
        """An executor that records each attempt and fails with a retryable error."""
        calls.append(1)
        raise _http_error(503)

    with pytest.raises(YouTubeAPIError):
        call_youtube_api(lambda: _always_503(default_calls))
    with pytest.raises(YouTubeAPIError):
        call_youtube_api(lambda: _always_503(single_calls), max_attempts=1)

    assert len(default_calls) == MAX_RETRIES == 3
    assert len(single_calls) == 1


# Notification eligibility of the announcement events: the creator's NEW VIDEO switch decides, and delivery waits for each client's own slots.
FOUR_WINDOWS = ["08:00", "12:00", "18:00", "22:00"]


def test_a_live_only_subscription_never_receives_a_premiere_announcement_and_a_new_video_one_does(world, monkeypatch):
    """Live-only (the creator's new-video switch off) is suppressed for good; a client with the new-video switch on gets each announcement once at its slot."""
    _run(world, monkeypatch)
    rows = fake_delivery_log(monkeypatch)
    sent = install_world(
        monkeypatch,
        events=_all_events("2026-10-22"),
        preferences={
            "c_new": preference_value(deliveryWindows=FOUR_WINDOWS),
            "c_live_only": preference_value(deliveryWindows=FOUR_WINDOWS, newVideoCreatorOverride={}, newVideoActivatedAt={}),
            "c_live_creator_off": preference_value(deliveryWindows=FOUR_WINDOWS, creatorOverride={"aizawa_ema": False}),
        },
    )

    new_video_dispatcher.run({}, None, now=datetime(2026, 10, 22, 22, 5, tzinfo=JST))

    assert sorted(payload["videoId"] for payload in sent) == sorted([KD0NT, XDYWW, GSQ])  # exactly one client's three pushes
    assert {key for key, status in rows.items() if status == "delivered"} == {("c_new", KD0NT), ("c_new", XDYWW), ("c_new", GSQ)}
    assert {client for (client, _video), status in rows.items() if status == "suppressed"} == {"c_live_only"}
    assert not any(client == "c_live_creator_off" for (client, _video) in rows)  # a creator switched off for the client is simply not delivered


@pytest.mark.parametrize(
    ("windows", "tick", "expected_pushes"),
    [
        (FOUR_WINDOWS, datetime(2026, 10, 22, 18, 5, tzinfo=JST), 0),  # before the 20:00 discovery: nothing exists yet
        (FOUR_WINDOWS, datetime(2026, 10, 22, 22, 5, tzinfo=JST), 3),  # the first of the client's four slots after discovery
        (["18:00"], datetime(2026, 10, 22, 22, 5, tzinfo=JST), 0),  # not this client's slot
        (["18:00"], datetime(2026, 10, 23, 18, 5, tzinfo=JST), 3),  # its only slot, the next evening
        (["08:00"], datetime(2026, 10, 23, 8, 5, tzinfo=JST), 3),  # its only slot, the next morning
    ],
)
def test_the_announcement_is_delivered_at_the_clients_own_slot_and_never_by_the_discovery_run(world, monkeypatch, windows, tick, expected_pushes):
    """Delivery depends only on the client's configured slots and the discovery time, never on the Premiere's own start."""
    _run(world, monkeypatch)
    fake_delivery_log(monkeypatch)
    sent = install_world(monkeypatch, events=_all_events("2026-10-22"), preferences={"c1": preference_value(deliveryWindows=windows)})

    new_video_dispatcher.run({}, None, now=tick)

    assert len(sent) == expected_pushes


def test_a_client_with_four_slots_receives_each_announcement_exactly_once_across_all_of_them(world, monkeypatch):
    """The delivery log keys (client, videoId): later slots, later days and repeated runs never send the same announcement again."""
    _run(world, monkeypatch)
    fake_delivery_log(monkeypatch)
    sent = install_world(monkeypatch, events=_all_events("2026-10-22"), preferences={"c1": preference_value(deliveryWindows=FOUR_WINDOWS)})

    for tick in (
        datetime(2026, 10, 22, 22, 5, tzinfo=JST),
        datetime(2026, 10, 22, 22, 35, tzinfo=JST),
        datetime(2026, 10, 23, 8, 5, tzinfo=JST),
        datetime(2026, 10, 23, 12, 5, tzinfo=JST),
        datetime(2026, 10, 23, 18, 5, tzinfo=JST),
    ):
        new_video_dispatcher.run({}, None, now=tick)

    assert sorted(payload["videoId"] for payload in sent) == sorted([KD0NT, XDYWW, GSQ])


def test_switching_the_flag_off_stops_new_announcements_but_never_recalls_pending_ones(world, monkeypatch):
    """The flag only gates event CREATION in the Collector: pending announcement events stay deliverable at the clients' slots, and the dispatcher never reads the flag."""
    _run(world, monkeypatch)  # flag on: three events recorded, none delivered yet
    pending = _all_events("2026-10-22")
    assert len(pending) == 3

    monkeypatch.delenv(premiere_announcements.ENABLED_ENV)  # the rollback
    world.streams = world.streams + [_stream("NEWPREMIERE1", STARTS[GSQ])]
    world.facts["NEWPREMIERE1"] = _premiere_facts(GSQ)
    _run(world, monkeypatch, at=DAY1_RUN + timedelta(hours=2), window="2200")
    assert {event["videoId"] for event in _all_events("2026-10-22")} == {KD0NT, XDYWW, GSQ}  # nothing new is announced once the flag is off

    fake_delivery_log(monkeypatch)
    sent = install_world(monkeypatch, events=pending, preferences={"c1": preference_value(deliveryWindows=FOUR_WINDOWS)})
    new_video_dispatcher.run({}, None, now=datetime(2026, 10, 22, 22, 5, tzinfo=JST))
    assert len(sent) == 3  # the already-recorded announcements are still delivered

    import inspect

    from notifications import new_video_dispatcher as dispatcher_module, notification_dispatch

    for module in (dispatcher_module, notification_dispatch, notification_events_store):
        assert premiere_announcements.ENABLED_ENV not in inspect.getsource(module)  # no delivery-side code depends on the flag
