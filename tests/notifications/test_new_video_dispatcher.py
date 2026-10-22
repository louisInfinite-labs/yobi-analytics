"""The 30-minute new-video slot dispatcher (notifications/new_video_dispatcher.py)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from notifications import new_video_dispatcher, notification_dispatcher
from notifications.push_sender import PushResult
from stores import notification_delivery_log_store, notification_events_store, notification_slot_store, remote_config_store
from tests.notifications.new_video_harness import (
    DAY1_EVENING,
    DAY2_EVENING,
    due_event,
    event_item,
    fake_delivery_log,
    install_world,
    preference_value,
    subscription_value,
)

TICK_1800_JST = datetime(2026, 9, 3, 9, 0, tzinfo=timezone.utc)  # 18:00 JST: the local slot 36 of Asia/Tokyo


def _run(monkeypatch, *, now=DAY1_EVENING, **world):
    """Install a world, run the dispatcher once at `now`, return (pushes, summary)."""
    sent = install_world(monkeypatch, **world)
    return sent, new_video_dispatcher.run({}, None, now=now)


# --- delivery -----------------------------------------------------------------


def test_a_run_with_no_pending_events_stops_before_the_index_is_touched(monkeypatch):
    monkeypatch.setattr(notification_events_store, "list_events_for_date", lambda day: [])

    def _boom(*_a, **_kw):
        raise AssertionError("nothing is pending, so the slot index must not be read")

    monkeypatch.setattr(notification_slot_store, "list_recipients", _boom)

    summary = new_video_dispatcher.run({}, None, now=DAY1_EVENING)

    assert summary["events"] == 0 and summary["delivered"] == 0 and summary["recipients"] == 0


def test_delivers_a_due_event_to_the_client_whose_slot_it_is_and_confirms_it(monkeypatch):
    rows = fake_delivery_log(monkeypatch)

    sent, summary = _run(monkeypatch, events=[due_event()], preferences={"c1": preference_value()})

    assert sent == [{"videoId": "v1", "url": "/creator/aizawa-ema"}]
    assert rows == {("c1", "v1"): "delivered"}
    assert (summary["events"], summary["zones"], summary["slotsServed"], summary["recipients"], summary["delivered"]) == (1, 1, 1, 1, 1)
    assert summary["tick"] == "2026-09-03T09:00:00+00:00"


def test_a_video_already_delivered_to_the_client_is_not_sent_again(monkeypatch):
    rows = fake_delivery_log(monkeypatch)
    rows[("c1", "v1")] = "delivered"

    sent, summary = _run(monkeypatch, events=[due_event()], preferences={"c1": preference_value()})

    assert sent == []
    assert summary["delivered"] == 0


def test_a_lost_claim_race_does_not_send(monkeypatch):
    fake_delivery_log(monkeypatch)
    monkeypatch.setattr(notification_delivery_log_store, "mark_delivered", lambda client_id, video_id, at: False)

    sent, summary = _run(monkeypatch, events=[due_event()], preferences={"c1": preference_value()})

    assert sent == [] and summary["delivered"] == 0


def test_an_expired_subscription_releases_the_claim(monkeypatch):
    fake_delivery_log(monkeypatch)
    released = []
    monkeypatch.setattr(notification_delivery_log_store, "release_claim", lambda client_id, video_id: released.append((client_id, video_id)))
    install_world(monkeypatch, events=[due_event()], preferences={"c1": preference_value()})
    monkeypatch.setattr(
        new_video_dispatcher.push_sender, "send_push_notification", lambda *a, **kw: PushResult(sent=False, subscription_expired=True)
    )

    summary = new_video_dispatcher.run({}, None, now=DAY1_EVENING)

    assert summary["delivered"] == 0 and released == [("c1", "v1")]


def test_a_failed_send_releases_the_claim_so_the_next_slot_retries(monkeypatch):
    rows = fake_delivery_log(monkeypatch)
    released = []
    monkeypatch.setattr(notification_delivery_log_store, "release_claim", lambda client_id, video_id: rows.pop((client_id, video_id)) and released.append(video_id))
    install_world(monkeypatch, events=[due_event()], preferences={"c1": preference_value()})
    monkeypatch.setattr(
        new_video_dispatcher.push_sender, "send_push_notification", lambda *a, **kw: PushResult(sent=False, subscription_expired=False, error="network")
    )

    summary = new_video_dispatcher.run({}, None, now=DAY1_EVENING)

    assert summary["delivered"] == 0 and released == ["v1"] and rows == {}


def test_a_creator_switched_off_is_recorded_as_suppressed_and_never_replayed(monkeypatch):
    rows = fake_delivery_log(monkeypatch)
    preference = preference_value(newVideoCreatorOverride={"aizawa_ema": False})

    sent, _ = _run(monkeypatch, events=[due_event()], preferences={"c1": preference})
    assert sent == [] and rows == {("c1", "v1"): "suppressed"}

    sent_later, _ = _run(
        monkeypatch, now=DAY2_EVENING, events=[due_event()], preferences={"c1": preference_value(newVideoCreatorOverride={"aizawa_ema": True})}
    )
    assert sent_later == []


def test_mute_and_quiet_hours_at_the_slot_record_nothing_so_a_later_slot_delivers(monkeypatch):
    rows = fake_delivery_log(monkeypatch)
    muted = preference_value(temporaryMute="2026-09-03T10:00:00+00:00")

    sent, _ = _run(monkeypatch, events=[due_event()], preferences={"c1": muted})
    assert sent == [] and rows == {}

    sent_later, _ = _run(monkeypatch, now=DAY2_EVENING, events=[due_event()], preferences={"c1": preference_value()})
    assert sent_later == [{"videoId": "v1", "url": "/creator/aizawa-ema"}]


def test_a_client_without_a_push_subscription_is_skipped_without_reading_its_delivery_log(monkeypatch):
    def _boom(*_a, **_kw):
        raise AssertionError("no delivery-log read is needed for a client that cannot receive anything")

    monkeypatch.setattr(notification_delivery_log_store, "delivered_video_ids", _boom)

    sent, summary = _run(monkeypatch, events=[due_event()], preferences={"c1": preference_value()}, with_subscription=False)

    assert sent == [] and (summary["recipients"], summary["delivered"]) == (1, 0)


def test_a_client_with_an_invalid_stored_preference_is_skipped(monkeypatch):
    install_world(monkeypatch, events=[due_event()], preferences={"c1": {"enabled": "not-a-bool"}}, index_override={("Asia/Tokyo", 36): ["c1"]})

    def _boom(client_id, key):
        if key == "pushSubscription":
            raise AssertionError("no subscription lookup for a client with an invalid preference")
        return {"value": {"enabled": "not-a-bool"}}

    monkeypatch.setattr(remote_config_store, "get_remote_config", _boom)

    summary = new_video_dispatcher.run({}, None, now=DAY1_EVENING)

    assert summary["delivered"] == 0


def test_the_delivery_log_is_read_once_per_client_for_the_whole_candidate_window(monkeypatch):
    fake_delivery_log(monkeypatch)
    calls = []
    monkeypatch.setattr(
        notification_delivery_log_store,
        "delivered_video_ids",
        lambda client_id, video_ids, *, now=None: calls.append((client_id, sorted(video_ids))) or set(),
    )
    events = [due_event(videoId=f"v{n}") for n in range(3)]

    sent, summary = _run(monkeypatch, events=events, preferences={c: preference_value() for c in ("c1", "c2")})

    assert summary["delivered"] == 6 and len(sent) == 6
    assert calls == [("c1", ["v0", "v1", "v2"]), ("c2", ["v0", "v1", "v2"])]  # 2 reads, not 2 x 3


def test_events_the_bulk_read_reports_as_handled_are_skipped(monkeypatch):
    fake_delivery_log(monkeypatch)
    monkeypatch.setattr(notification_delivery_log_store, "delivered_video_ids", lambda client_id, video_ids, *, now=None: {"v0", "v2"})
    events = [due_event(videoId=f"v{n}") for n in range(3)]

    sent, summary = _run(monkeypatch, events=events, preferences={"c1": preference_value()})

    assert sent == [{"videoId": "v1", "url": "/creator/aizawa-ema"}] and summary["delivered"] == 1


# --- which clients a tick serves ------------------------------------------------


def test_a_tick_serves_only_the_clients_who_chose_the_local_slot_it_starts(monkeypatch):
    rows = fake_delivery_log(monkeypatch)
    preferences = {
        "due": preference_value(deliveryWindows=["18:00"]),  # 09:00 UTC is 18:00 in Tokyo
        "not_due": preference_value(deliveryWindows=["08:00"]),
        "also_due": preference_value(deliveryWindows=["08:00", "18:00", "18:30"]),
    }

    _, summary = _run(monkeypatch, events=[due_event()], preferences=preferences)

    assert {client for (client, _video), status in rows.items() if status == "delivered"} == {"due", "also_due"}
    assert (summary["slotsServed"], summary["recipients"]) == (1, 2)


def test_each_clients_own_stored_time_zone_decides_which_tick_serves_its_local_times(monkeypatch):
    rows = fake_delivery_log(monkeypatch)
    preferences = {
        # 09:00 UTC is 05:00 in New York (EDT), 17:00 in Hong Kong and 18:00 in Tokyo.
        "new_york_05": preference_value(notificationTimeZone="America/New_York", deliveryWindows=["05:00"]),
        "new_york_18": preference_value(notificationTimeZone="America/New_York", deliveryWindows=["18:00"]),
        "hong_kong_17": preference_value(notificationTimeZone="Asia/Hong_Kong", deliveryWindows=["17:00"]),
        "kathmandu_18": preference_value(notificationTimeZone="Asia/Kathmandu", deliveryWindows=["18:00"]),  # 09:00 UTC is 14:45 there
        "tokyo_18": preference_value(deliveryWindows=["18:00"]),
    }

    _, summary = _run(monkeypatch, events=[due_event()], preferences=preferences)

    delivered = {client for (client, _video), status in rows.items() if status == "delivered"}
    assert delivered == {"new_york_05", "hong_kong_17", "tokyo_18"}
    assert summary["zones"] == 4 and summary["recipients"] == 3


@pytest.mark.parametrize(
    ("zone", "tick"),
    [
        # 08:00 LOCAL, delivered at exactly 08:00 local -- including the quarter-hour-offset zone, which used to wait for 08:15.
        ("Asia/Hong_Kong", datetime(2026, 9, 3, 0, 0, tzinfo=timezone.utc)),
        ("Asia/Tokyo", datetime(2026, 9, 2, 23, 0, tzinfo=timezone.utc)),
        ("Asia/Kathmandu", datetime(2026, 9, 3, 2, 15, tzinfo=timezone.utc)),
        ("Pacific/Chatham", datetime(2026, 9, 2, 19, 15, tzinfo=timezone.utc)),
    ],
)
def test_a_local_08_00_is_delivered_at_exactly_08_00_local_and_not_a_tick_earlier(monkeypatch, zone, tick):
    rows = fake_delivery_log(monkeypatch)
    preference = preference_value(notificationTimeZone=zone, deliveryWindows=["08:00"])
    event = due_event()  # discovered 09-02 18:00 JST (09:00 UTC): its next 08:00 local is the one under test, in every zone above
    assert tick.astimezone(ZoneInfo(zone)).strftime("%H:%M") == "08:00"

    _run(monkeypatch, now=tick - timedelta(minutes=15) + timedelta(seconds=30), events=[event], preferences={"c1": preference})
    assert rows == {}  # the previous quarter hour: 07:45 local, nothing yet

    sent, summary = _run(monkeypatch, now=tick + timedelta(seconds=30), events=[event], preferences={"c1": preference})
    assert sent == [{"videoId": "v1", "url": "/creator/aizawa-ema"}] and rows == {("c1", "v1"): "delivered"}
    assert summary["tick"] == tick.isoformat()  # served on the exact tick, not a later one


def test_the_same_local_time_is_delivered_at_a_different_utc_tick_in_summer_and_winter(monkeypatch):
    rows = fake_delivery_log(monkeypatch)
    preference = preference_value(notificationTimeZone="America/New_York", deliveryWindows=["18:00"])  # New York changes UTC offset

    summer = event_item(eventDate="2026-06-30", discoveredAt="2026-06-30T00:00:00+09:00")  # 15:00 UTC on 06-29
    _run(monkeypatch, now=datetime(2026, 6, 29, 21, 30, tzinfo=timezone.utc), events=[summer], preferences={"c1": preference})
    assert rows == {}  # 17:30 EDT
    _run(monkeypatch, now=datetime(2026, 6, 29, 22, 0, tzinfo=timezone.utc), events=[summer], preferences={"c1": preference})
    assert rows == {("c1", "v1"): "delivered"}  # 18:00 EDT = 22:00 UTC

    rows.clear()
    winter = event_item(eventDate="2026-01-14", discoveredAt="2026-01-14T00:00:00+09:00")  # 15:00 UTC on 01-13
    _run(monkeypatch, now=datetime(2026, 1, 13, 22, 0, tzinfo=timezone.utc), events=[winter], preferences={"c1": preference})
    assert rows == {}  # 17:00 EST: the summer tick no longer means 18:00
    _run(monkeypatch, now=datetime(2026, 1, 13, 23, 0, tzinfo=timezone.utc), events=[winter], preferences={"c1": preference})
    assert rows == {("c1", "v1"): "delivered"}  # 18:00 EST = 23:00 UTC


def test_a_local_time_inside_a_spring_forward_gap_is_delivered_when_it_resolves_not_lost(monkeypatch):
    rows = fake_delivery_log(monkeypatch)
    # New York, 2026-03-08: 02:00 EST -> 03:00 EDT, so a 02:30 local delivery time does not exist that day; it resolves to 03:30 EDT.
    preference = preference_value(notificationTimeZone="America/New_York", deliveryWindows=["02:30"])
    event = event_item(eventDate="2026-03-08", discoveredAt="2026-03-08T00:00:00+09:00")  # 15:00 UTC on 03-07

    _run(monkeypatch, now=datetime(2026, 3, 8, 7, 0, tzinfo=timezone.utc), events=[event], preferences={"c1": preference})
    assert rows == {}  # 03:00 EDT: not yet
    _run(monkeypatch, now=datetime(2026, 3, 8, 7, 30, tzinfo=timezone.utc), events=[event], preferences={"c1": preference})
    assert rows == {("c1", "v1"): "delivered"}  # 03:30 EDT: where the skipped 02:30 resolves


def test_a_repeated_fall_back_slot_never_delivers_the_same_video_twice(monkeypatch):
    rows = fake_delivery_log(monkeypatch)
    preference = preference_value(notificationTimeZone="America/New_York", deliveryWindows=["01:30"])
    event = event_item(eventDate="2026-11-01", discoveredAt="2026-11-01T00:00:00+09:00")  # 15:00 UTC on 10-31

    sent_first, _ = _run(monkeypatch, now=datetime(2026, 11, 1, 5, 30, tzinfo=timezone.utc), events=[event], preferences={"c1": preference})
    sent_second, summary = _run(monkeypatch, now=datetime(2026, 11, 1, 6, 30, tzinfo=timezone.utc), events=[event], preferences={"c1": preference})

    assert sent_first == [{"videoId": "v1", "url": "/creator/aizawa-ema"}] and sent_second == []  # 01:30 EDT delivered; the repeated 01:30 EST is not even a due slot
    assert summary["slotsServed"] == 0 and rows == {("c1", "v1"): "delivered"}


def test_a_client_that_moved_to_another_zone_is_skipped_at_its_old_zones_slot(monkeypatch):
    rows = fake_delivery_log(monkeypatch)
    # The index still lists c1 under Hong Kong 17:00 (its preference write moved it to London but the old row is not cleaned yet).
    moved = preference_value(notificationTimeZone="Europe/London", deliveryWindows=["17:00"])

    sent, summary = _run(
        monkeypatch, events=[due_event()], preferences={"c1": moved}, index_override={("Asia/Hong_Kong", 34): ["c1"]}
    )

    assert sent == [] and rows == {}
    assert (summary["staleIndexEntries"], summary["recipients"]) == (1, 0)


def test_a_zone_the_runtime_does_not_know_is_ignored_without_failing_the_run(monkeypatch, capsys):
    fake_delivery_log(monkeypatch)
    sent, summary = _run(
        monkeypatch,
        events=[due_event()],
        preferences={"c1": preference_value()},
        index_override={("Not/AZone", 36): ["x"], ("Asia/Tokyo", 36): ["c1"]},
    )

    assert sent == [{"videoId": "v1", "url": "/creator/aizawa-ema"}] and summary["delivered"] == 1
    assert "unknown time zone 'Not/AZone'" in capsys.readouterr().out


def test_a_tick_reads_the_zone_registry_once_and_only_the_slots_that_are_due_never_all_clients(monkeypatch):
    fake_delivery_log(monkeypatch)
    install_world(
        monkeypatch,
        events=[due_event()],
        preferences={
            "tokyo": preference_value(deliveryWindows=["18:00"]),
            "new_york": preference_value(notificationTimeZone="America/New_York", deliveryWindows=["05:00"]),
        },
    )
    zone_reads, slot_reads = [], []
    real_zones, real_recipients = notification_slot_store.list_zones, notification_slot_store.list_recipients
    monkeypatch.setattr(notification_slot_store, "list_zones", lambda: zone_reads.append(1) or real_zones())
    monkeypatch.setattr(notification_slot_store, "list_recipients", lambda zone, slot: slot_reads.append((zone, slot)) or real_recipients(zone, slot))

    def _no_scan(*_args, **_kwargs):
        raise AssertionError("the dispatcher must never list every stored preference")

    monkeypatch.setattr(remote_config_store, "list_by_key", _no_scan)

    new_video_dispatcher.run({}, None, now=DAY1_EVENING)

    assert len(zone_reads) == 1
    assert sorted(slot_reads) == [("America/New_York", 10), ("Asia/Tokyo", 36)]  # exactly one due slot per registered zone


def test_quiet_hours_and_delivery_times_both_follow_the_clients_own_stored_time_zone(monkeypatch):
    rows = fake_delivery_log(monkeypatch)
    # 22:00 UTC on 09-03 is 18:00 in New York (EDT): inside its 17:00-19:00 quiet hours, so nothing is sent or recorded -- the same rule
    # that has always applied to reminders.
    quiet = preference_value(notificationTimeZone="America/New_York", deliveryWindows=["18:00"], quietHours=["17:00", "19:00"])

    sent, summary = _run(monkeypatch, now=datetime(2026, 9, 3, 22, 0, tzinfo=timezone.utc), events=[due_event()], preferences={"c1": quiet})

    assert sent == [] and rows == {}
    assert summary["recipients"] == 1  # it was due; quiet hours held it back


def test_a_client_that_never_stored_a_preference_receives_nothing(monkeypatch):
    rows = fake_delivery_log(monkeypatch)

    sent, summary = _run(monkeypatch, events=[due_event()], preferences={})

    assert sent == [] and rows == {}
    assert (summary["recipients"], summary["staleIndexEntries"], summary["delivered"]) == (0, 0, 0)


def test_a_preference_stored_before_the_half_hour_rule_is_served_at_its_floored_slot(monkeypatch):
    rows = fake_delivery_log(monkeypatch)
    legacy = preference_value(deliveryWindows=["08:10", "18:20", "18:25"])  # 18:20 and 18:25 both floor to the 18:00 slot

    _run(monkeypatch, events=[due_event()], preferences={"c1": legacy})

    assert rows == {("c1", "v1"): "delivered"}


# --- the index is only a hint ---------------------------------------------------


@pytest.mark.parametrize(
    "stored",
    [
        preference_value(enabled=False),  # turned OFF after it was indexed
        preference_value(deliveryWindows=["08:00"]),  # dropped this slot
    ],
    ids=["disabled", "slot-dropped"],
)
def test_an_index_entry_the_stored_preference_no_longer_backs_is_skipped_and_counted(monkeypatch, stored):
    rows = fake_delivery_log(monkeypatch)

    sent, summary = _run(
        monkeypatch, events=[due_event()], preferences={"c1": stored}, index_override={("Asia/Tokyo", 36): ["c1"]}
    )

    assert sent == [] and rows == {}
    assert (summary["staleIndexEntries"], summary["recipients"], summary["delivered"]) == (1, 0, 0)


def test_an_index_entry_whose_preference_was_deleted_is_a_stale_entry(monkeypatch):
    sent, summary = _run(monkeypatch, events=[due_event()], preferences={}, index_override={("Asia/Tokyo", 36): ["ghost"]})

    assert sent == [] and summary["staleIndexEntries"] == 1


# --- which events ---------------------------------------------------------------


def test_one_video_recorded_under_two_dates_is_sent_once(monkeypatch):
    rows = fake_delivery_log(monkeypatch)
    first = event_item(eventDate="2026-09-02", discoveredAt="2026-09-02T18:00:00+09:00")
    rediscovered = event_item(eventDate="2026-09-03", discoveredAt="2026-09-03T00:00:00+09:00")

    sent, summary = _run(monkeypatch, events=[first, rediscovered], preferences={"c1": preference_value()})

    assert summary["events"] == 1 and sent == [{"videoId": "v1", "url": "/creator/aizawa-ema"}]
    assert rows == {("c1", "v1"): "delivered"}


# --- Premiere two-phase notifications (announced + archived) -----------------


def archived_event(video_id="v1", **overrides) -> dict:
    """The second, independent notification event tracking.livestream_lifecycle records once a Premiere's archive is confirmed
    available (notification_events_store.record_premiere_archived_event) -- same shape a real one would have."""
    fields = {
        "eventDate": "2026-09-03",
        "videoId": f"{video_id}#premiere_archived",
        "eventPhase": "premiere_archived",
        "creatorId": "aizawa_ema",
        "title": "Premiere Archive",
        "discoveredAt": "2026-09-02T18:00:00+09:00",
    }
    fields.update(overrides)
    return fields


def test_canonical_video_id_strips_the_premiere_archived_qualifier_only(monkeypatch):
    assert new_video_dispatcher.canonical_video_id("v1#premiere_archived") == "v1"
    assert new_video_dispatcher.canonical_video_id("v1") == "v1"


def test_pending_events_treats_the_two_phases_of_the_same_video_as_independent(monkeypatch):
    """pending_events' earliest-by-videoId collapse must not merge an announcement and its archive-confirmation: they have
    different `videoId` field values by construction (the phase qualifier), so both survive."""
    announced = due_event(videoId="v1")
    archived = archived_event("v1", eventDate="2026-09-02")
    monkeypatch.setattr(notification_events_store, "list_events_for_date", lambda day: [announced, archived] if day == "2026-09-02" else [])

    kept = new_video_dispatcher.pending_events(TICK_1800_JST)

    assert {event["videoId"] for event in kept} == {"v1", "v1#premiere_archived"}


def test_a_genuinely_legacy_event_with_no_eventPhase_key_at_all_coexists_with_a_new_phase_qualified_one(monkeypatch):
    """A row written before eventPhase existed has no such key at all (not even None) -- unlike the test helpers above, which always
    construct a complete dict. Mixed old/new data in the same date partition must not confuse pending_events or delivery: the
    legacy row is served exactly as before, and the new phase-qualified row delivers independently alongside it."""
    rows = fake_delivery_log(monkeypatch)
    legacy_row = {
        "eventDate": "2026-09-02",
        "videoId": "v1",
        "eventId": "new_video:v1",
        "creatorId": "aizawa_ema",
        "title": "New Video",
        "discoveredAt": "2026-09-02T18:00:00+09:00",
        "notificationEligible": True,
        # no "eventPhase" key whatsoever -- a genuine pre-existing production row, not a helper default.
    }
    new_phase_row = archived_event("v1", eventDate="2026-09-02")

    sent, summary = _run(monkeypatch, events=[legacy_row, new_phase_row], preferences={"c1": preference_value()})

    assert sorted(sent, key=lambda item: item["videoId"]) == [{"videoId": "v1", "url": "/creator/aizawa-ema"}]
    assert rows == {("c1", "v1#premiere_archived"): "delivered"}  # the legacy announcement was superseded by the pending archive
    assert summary["delivered"] == 1


def test_an_already_delivered_announcement_never_blocks_the_later_archive_notification(monkeypatch):
    rows = fake_delivery_log(monkeypatch)
    rows[("c1", "v1")] = "delivered"  # the plain "new video" push for v1 already went out in an earlier run

    sent, summary = _run(monkeypatch, events=[archived_event("v1")], preferences={"c1": preference_value()})

    assert sent == [{"videoId": "v1", "url": "/creator/aizawa-ema"}]  # the deep link uses the REAL id, never the qualified one
    assert rows[("c1", "v1#premiere_archived")] == "delivered"
    assert summary["delivered"] == 1


def test_the_archived_phase_delivery_log_row_never_collides_with_the_announcements(monkeypatch):
    rows = fake_delivery_log(monkeypatch)

    sent, summary = _run(monkeypatch, events=[due_event(videoId="v1"), archived_event("v1")], preferences={"c1": preference_value()})

    # Both are due and neither was delivered yet, so the prioritize rule (below) suppresses the stale announcement --
    # but the two are still tracked under two distinct delivery-log rows, never one shared (clientId, videoId) pair.
    assert rows == {("c1", "v1#premiere_archived"): "delivered"}
    assert sent == [{"videoId": "v1", "url": "/creator/aizawa-ema"}]
    assert summary["delivered"] == 1


def test_a_pending_announcement_is_superseded_by_a_pending_archive_notification_in_the_same_run(monkeypatch):
    """Both still pending in the same run: only the archive-available push is sent -- the announcement is already stale by the
    time the archive exists."""
    rows = fake_delivery_log(monkeypatch)

    sent, _ = _run(monkeypatch, events=[due_event(videoId="v1"), archived_event("v1")], preferences={"c1": preference_value()})

    assert len(sent) == 1
    assert ("c1", "v1") not in rows  # the announcement itself was never claimed/sent


def test_a_pending_announcement_is_not_superseded_once_its_own_archive_notification_already_went_out(monkeypatch):
    """The reverse of the previous case: the archive push already happened, so a separately still-pending announcement (an
    unusual ordering, e.g. it was muted until just now) is delivered normally rather than silently dropped."""
    rows = fake_delivery_log(monkeypatch)
    rows[("c1", "v1#premiere_archived")] = "delivered"

    sent, summary = _run(monkeypatch, events=[due_event(videoId="v1")], preferences={"c1": preference_value()})

    assert sent == [{"videoId": "v1", "url": "/creator/aizawa-ema"}]
    assert summary["delivered"] == 1


def test_the_earliest_recording_of_a_video_wins_even_when_the_offsets_differ(monkeypatch):
    """Compared as instants, not strings: 18:00+09:00 is 09:00 UTC, EARLIER than 12:00+00:00, although "T12" sorts before "T18"."""
    earliest = event_item(eventDate="2026-09-02", discoveredAt="2026-09-02T18:00:00+09:00", title="earliest")
    later = event_item(eventDate="2026-09-02", discoveredAt="2026-09-02T12:00:00+00:00", title="later")
    monkeypatch.setattr(notification_events_store, "list_events_for_date", lambda day: [earliest, later] if day == "2026-09-02" else [])

    kept = new_video_dispatcher.pending_events(TICK_1800_JST)

    assert [event["title"] for event in kept] == ["earliest"]


def test_an_event_discovered_after_the_tick_waits_for_a_later_slot(monkeypatch):
    rows = fake_delivery_log(monkeypatch)
    just_after = event_item(eventDate="2026-09-03", discoveredAt="2026-09-03T18:00:05+09:00")

    _, summary = _run(monkeypatch, events=[just_after], preferences={"c1": preference_value()})
    assert summary["events"] == 0 and rows == {}

    # The next slot of this client (08:00 JST next day = 23:00 UTC) picks it up.
    _run(monkeypatch, now=datetime(2026, 9, 3, 23, 5, tzinfo=timezone.utc), events=[just_after], preferences={"c1": preference_value()})
    assert rows == {("c1", "v1"): "delivered"}


def test_an_event_marked_not_eligible_is_never_delivered(monkeypatch):
    fake_delivery_log(monkeypatch)

    sent, summary = _run(monkeypatch, events=[due_event(notificationEligible=False)], preferences={"c1": preference_value()})

    assert sent == [] and summary["events"] == 0


def test_pending_videos_are_sent_oldest_first(monkeypatch):
    fake_delivery_log(monkeypatch)
    events = [
        due_event(videoId="newer", discoveredAt="2026-09-02T20:00:00+09:00"),
        due_event(videoId="oldest", discoveredAt="2026-09-02T10:00:00+09:00"),
    ]

    sent, _ = _run(monkeypatch, events=events, preferences={"c1": preference_value()})

    assert [payload["videoId"] for payload in sent] == ["oldest", "newer"]


# --- activeSince: no replay of what came due while the client was OFF ------------


def test_an_event_that_came_due_before_the_clients_current_enabled_stretch_is_never_delivered(monkeypatch):
    rows = fake_delivery_log(monkeypatch)
    # due_event's next window (09-03 08:00 JST = 09-02 23:00 UTC) was before the client (re)enabled at 09-03 00:00 UTC.
    sent, _ = _run(monkeypatch, events=[due_event()], preferences={"c1": preference_value()}, active_since="2026-09-03T00:00:00+00:00")

    assert sent == [] and rows == {}


def test_an_event_still_waiting_for_its_window_when_the_client_comes_back_is_delivered_normally(monkeypatch):
    rows = fake_delivery_log(monkeypatch)
    waiting = event_item(eventDate="2026-09-03", discoveredAt="2026-09-03T18:00:05+09:00")  # next window 09-04 08:00 JST

    _run(
        monkeypatch,
        now=datetime(2026, 9, 3, 23, 5, tzinfo=timezone.utc),
        events=[waiting],
        preferences={"c1": preference_value()},
        active_since="2026-09-03T11:00:00+00:00",  # re-enabled at 20:00 JST, before that window
    )

    assert rows == {("c1", "v1"): "delivered"}


# --- run mechanics ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("scheduled", "expected"),
    [
        ("2026-09-03T09:00:00Z", "2026-09-03T09:00:00+00:00"),  # exactly on the tick
        ("2026-09-03T09:00:00+00:00", "2026-09-03T09:00:00+00:00"),
        ("2026-09-03T18:00:00+09:00", "2026-09-03T09:00:00+00:00"),  # any offset is normalized to UTC
        ("2026-09-03T08:40:30Z", "2026-09-03T08:30:00+00:00"),  # floored to the half hour
    ],
)
def test_the_scheduled_time_decides_the_tick_so_a_late_start_stays_in_its_slot(scheduled, expected):
    now = datetime(2026, 9, 3, 9, 0, 40, tzinfo=timezone.utc)

    assert new_video_dispatcher.resolve_tick({"scheduledTime": scheduled}, now).isoformat() == expected


@pytest.mark.parametrize(
    "event",
    [
        {},
        None,
        {"scheduledTime": "not a time"},
        {"scheduledTime": "2026-09-03T09:00:00"},  # no offset
        {"scheduledTime": 5},
        {"scheduledTime": "2026-09-03T05:00:00Z"},  # 4 hours old: a stale retry
        {"scheduledTime": "2026-09-03T12:00:00Z"},  # in the future
    ],
)
def test_a_missing_or_unusable_scheduled_time_falls_back_to_the_current_half_hour(event):
    now = datetime(2026, 9, 3, 9, 7, 40, tzinfo=timezone.utc)

    assert new_video_dispatcher.resolve_tick(event, now).isoformat() == "2026-09-03T09:00:00+00:00"


def test_a_run_close_to_the_lambda_deadline_stops_starting_clients(monkeypatch):
    rows = fake_delivery_log(monkeypatch)

    class _ContextNearDeadline:
        @staticmethod
        def get_remaining_time_in_millis() -> int:
            return 1_000

    install_world(monkeypatch, events=[due_event()], preferences={"c1": preference_value()})

    summary = new_video_dispatcher.run({}, _ContextNearDeadline(), now=DAY1_EVENING)

    assert summary["stoppedEarly"] is True and summary["delivered"] == 0 and rows == {}


def test_a_run_with_plenty_of_time_left_completes(monkeypatch):
    fake_delivery_log(monkeypatch)

    class _Context:
        @staticmethod
        def get_remaining_time_in_millis() -> int:
            return 250_000

    install_world(monkeypatch, events=[due_event()], preferences={"c1": preference_value()})

    assert new_video_dispatcher.run({}, _Context(), now=DAY1_EVENING)["stoppedEarly"] is False


# --- routing in the shared Lambda ---------------------------------------------------


def test_the_shared_lambda_routes_the_slot_mode_to_the_slot_dispatcher(monkeypatch):
    calls = []
    monkeypatch.setattr(new_video_dispatcher, "run", lambda event, context: calls.append(event) or {"statusCode": 200, "mode": "routed"})

    response = notification_dispatcher.lambda_handler({"mode": "new_video_slots", "scheduledTime": "2026-09-03T09:00:00Z"}, None)

    assert response == {"statusCode": 200, "mode": "routed"}
    assert calls == [{"mode": "new_video_slots", "scheduledTime": "2026-09-03T09:00:00Z"}]


def test_an_unknown_mode_fails_loudly_instead_of_running_the_reminder_job(monkeypatch):
    def _boom(*_a, **_kw):
        raise AssertionError("an unsupported mode must not run any job")

    monkeypatch.setattr(notification_dispatcher, "_load_schedule", _boom)

    with pytest.raises(notification_dispatcher.UnsupportedModeError):
        notification_dispatcher.lambda_handler({"mode": "new_video"}, None)


def test_the_reminder_run_no_longer_delivers_new_videos_or_reads_new_video_events(monkeypatch):
    sent = []

    def _boom(*_a, **_kw):
        raise AssertionError("the reminder run must not read the new-video events or the slot index")

    monkeypatch.setattr(notification_events_store, "list_events_for_date", _boom)
    monkeypatch.setattr(notification_slot_store, "list_recipients", _boom)
    monkeypatch.setattr(notification_dispatcher, "_load_schedule", lambda *, now: ({}, []))
    monkeypatch.setattr(remote_config_store, "list_remote_config_by_prefix", lambda client_id, key_prefix: [])
    monkeypatch.setattr(notification_dispatcher, "load_creators", lambda: [])
    monkeypatch.setattr(notification_dispatcher, "get_vapid_credentials", lambda: ("pem", {"sub": "mailto:a@b.com"}))
    monkeypatch.setattr(remote_config_store, "list_by_key", lambda key: [{"clientId": "c1", "value": preference_value()}])
    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: {"value": subscription_value()})
    monkeypatch.setattr(
        notification_dispatcher.push_sender, "send_push_notification", lambda *a, **kw: sent.append(kw["data"]) or PushResult(sent=True, subscription_expired=False)
    )

    assert notification_dispatcher.lambda_handler({}, None) == {"statusCode": 200, "checked": 0, "delivered": 0}
    assert sent == []
