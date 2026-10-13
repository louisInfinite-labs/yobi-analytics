"""The 30-minute new-video slot dispatcher (notifications/new_video_dispatcher.py)."""

from __future__ import annotations

from datetime import datetime, timezone

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

TICK_1800_JST = datetime(2026, 9, 3, 9, 0, tzinfo=timezone.utc)  # slot 36: 18:00-18:30 JST


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

    assert sent == [{"videoId": "v1"}]
    assert rows == {("c1", "v1"): "delivered"}
    assert (summary["events"], summary["slot"], summary["recipients"], summary["delivered"]) == (1, 36, 1, 1)
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
    assert sent_later == [{"videoId": "v1"}]


def test_a_client_without_a_push_subscription_is_skipped_without_reading_its_delivery_log(monkeypatch):
    def _boom(*_a, **_kw):
        raise AssertionError("no delivery-log read is needed for a client that cannot receive anything")

    monkeypatch.setattr(notification_delivery_log_store, "delivered_video_ids", _boom)

    sent, summary = _run(monkeypatch, events=[due_event()], preferences={"c1": preference_value()}, with_subscription=False)

    assert sent == [] and (summary["recipients"], summary["delivered"]) == (1, 0)


def test_a_client_with_an_invalid_stored_preference_is_skipped(monkeypatch):
    install_world(monkeypatch, events=[due_event()], preferences={"c1": {"enabled": "not-a-bool"}}, index_override={36: ["c1"]})

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

    assert sent == [{"videoId": "v1"}] and summary["delivered"] == 1


# --- which clients a tick serves ------------------------------------------------


def test_a_tick_serves_only_the_clients_who_chose_the_jst_slot_it_starts(monkeypatch):
    rows = fake_delivery_log(monkeypatch)
    preferences = {
        "due": preference_value(deliveryWindows=["18:00"]),  # 09:00 UTC is 18:00 JST
        "not_due": preference_value(deliveryWindows=["08:00"]),
        "also_due": preference_value(deliveryWindows=["08:00", "18:00", "18:30"]),
    }

    _, summary = _run(monkeypatch, events=[due_event()], preferences=preferences)

    assert {client for (client, _video), status in rows.items() if status == "delivered"} == {"due", "also_due"}
    assert (summary["slot"], summary["recipients"]) == (36, 2)


def test_a_clients_own_stored_time_zone_does_not_move_its_delivery_slot(monkeypatch):
    rows = fake_delivery_log(monkeypatch)
    preferences = {
        # 09:00 UTC is 05:00 in New York and 14:45 in Kathmandu, but delivery slots are JST: only the 18:00 entries are due.
        "new_york_18": preference_value(notificationTimeZone="America/New_York", deliveryWindows=["18:00"]),
        "new_york_05": preference_value(notificationTimeZone="America/New_York", deliveryWindows=["05:00"]),
        "kathmandu_18": preference_value(notificationTimeZone="Asia/Kathmandu", deliveryWindows=["18:00"]),
        "kathmandu_14_30": preference_value(notificationTimeZone="Asia/Kathmandu", deliveryWindows=["14:30"]),
    }

    _, summary = _run(monkeypatch, events=[due_event()], preferences=preferences)

    assert {client for (client, _video), status in rows.items() if status == "delivered"} == {"new_york_18", "kathmandu_18"}
    assert summary["recipients"] == 2


def test_the_same_utc_tick_delivers_the_same_jst_slot_in_summer_and_winter(monkeypatch):
    rows = fake_delivery_log(monkeypatch)
    preference = preference_value(notificationTimeZone="America/New_York", deliveryWindows=["18:00"])  # New York changes UTC offset; JST does not

    summer = event_item(eventDate="2026-06-30", discoveredAt="2026-06-30T00:00:00+09:00")
    _run(monkeypatch, now=datetime(2026, 7, 1, 8, 30, tzinfo=timezone.utc), events=[summer], preferences={"c1": preference})
    assert rows == {}
    _run(monkeypatch, now=datetime(2026, 7, 1, 9, 0, tzinfo=timezone.utc), events=[summer], preferences={"c1": preference})
    assert rows == {("c1", "v1"): "delivered"}

    rows.clear()
    winter = event_item(eventDate="2026-01-14", discoveredAt="2026-01-14T00:00:00+09:00")
    _run(monkeypatch, now=datetime(2026, 1, 15, 8, 30, tzinfo=timezone.utc), events=[winter], preferences={"c1": preference})
    assert rows == {}
    _run(monkeypatch, now=datetime(2026, 1, 15, 9, 0, tzinfo=timezone.utc), events=[winter], preferences={"c1": preference})
    assert rows == {("c1", "v1"): "delivered"}


def test_quiet_hours_still_follow_the_clients_own_stored_time_zone_not_jst(monkeypatch):
    rows = fake_delivery_log(monkeypatch)
    # 09:00 UTC is 05:00 in New York (inside its 04:00-06:00 quiet hours) but 18:00 JST (outside them): the existing rule is kept.
    quiet = preference_value(notificationTimeZone="America/New_York", deliveryWindows=["18:00"], quietHours=["04:00", "06:00"])

    sent, _ = _run(monkeypatch, events=[due_event()], preferences={"c1": quiet})

    assert sent == [] and rows == {}


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
        monkeypatch, events=[due_event()], preferences={"c1": stored}, index_override={36: ["c1"]}
    )

    assert sent == [] and rows == {}
    assert (summary["staleIndexEntries"], summary["recipients"], summary["delivered"]) == (1, 0, 0)


def test_an_index_entry_whose_preference_was_deleted_is_a_stale_entry(monkeypatch):
    sent, summary = _run(monkeypatch, events=[due_event()], preferences={}, index_override={36: ["ghost"]})

    assert sent == [] and summary["staleIndexEntries"] == 1


# --- which events ---------------------------------------------------------------


def test_one_video_recorded_under_two_dates_is_sent_once(monkeypatch):
    rows = fake_delivery_log(monkeypatch)
    first = event_item(eventDate="2026-09-02", discoveredAt="2026-09-02T18:00:00+09:00")
    rediscovered = event_item(eventDate="2026-09-03", discoveredAt="2026-09-03T00:00:00+09:00")

    sent, summary = _run(monkeypatch, events=[first, rediscovered], preferences={"c1": preference_value()})

    assert summary["events"] == 1 and sent == [{"videoId": "v1"}]
    assert rows == {("c1", "v1"): "delivered"}


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

    monkeypatch.setattr(notification_dispatcher, "_refresh_and_load_stream_schedule", _boom)

    with pytest.raises(notification_dispatcher.UnsupportedModeError):
        notification_dispatcher.lambda_handler({"mode": "new_video"}, None)


def test_the_reminder_run_no_longer_delivers_new_videos_or_reads_new_video_events(monkeypatch):
    sent = []

    def _boom(*_a, **_kw):
        raise AssertionError("the reminder run must not read the new-video events or the slot index")

    monkeypatch.setattr(notification_events_store, "list_events_for_date", _boom)
    monkeypatch.setattr(notification_slot_store, "list_recipients", _boom)
    monkeypatch.setattr(notification_dispatcher, "_refresh_and_load_stream_schedule", lambda *, now: {})
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
