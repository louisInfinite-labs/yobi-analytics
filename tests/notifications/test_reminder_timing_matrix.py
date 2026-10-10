"""Deterministic matrix for ALL five live-reminder timings through the REAL dispatcher and the REAL push payload builder.

Every other dispatcher test stubs `push_sender.send_push_notification`, which hid a real defect: reminders were sent with
`body=""` and `push_sender.build_payload` rejects an empty body, so no start/advance reminder was ever delivered. Here only the
final network call (`push_sender.webpush`) is stubbed, so the payload is built and validated for real.

Timings (a setting has ONE advance offset plus an independent "at start" flag):
    1hour = start - 60 min, 30min = start - 30 min, 10min = start - 10 min, 1min = start - 1 min, at start = start.
A reminder's fire window is [fire_at, fire_at + 1 min); OFF / suppressed at that moment = discarded, never replayed.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from api import read_api
from notifications import live_reminder, notification_dispatcher, push_sender
from notifications.notification_dispatcher import lambda_handler
from stores import notification_delivery_log_store, notification_events_store, remote_config_store

from .test_notification_dispatcher import (  # noqa: F401  (autouse fixtures must be visible in this module)
    _START_MS,
    _creator_reminder_value,
    _frozen_datetime,
    _holodex_stream,
    _override_value,
    _preference_value,
    _remote_config_stub,
    _sf6_stream,
    _subscription_value,
    stub_creators,
    stub_live_streams,
    stub_reminder_items,
    stub_vapid,
)

START = datetime.fromtimestamp(_START_MS / 1000, tz=timezone.utc)
TIMINGS = {"1hour": 60, "30min": 30, "10min": 10, "1min": 1}
ALL_TIMINGS = [*TIMINGS, "start"]
BODY_LABEL = {"1min": "1 minute", "10min": "10 minutes", "30min": "30 minutes", "1hour": "1 hour"}


def fire_at(timing: str) -> datetime:
    return START if timing == "start" else START - timedelta(minutes=TIMINGS[timing])


def setting(timing: str) -> dict:
    """The stored value of a reminder setting for ONE timing."""
    return _creator_reminder_value(notifyAtStart=timing == "start", advanceReminder=None if timing == "start" else timing)


def run(monkeypatch, *, now: datetime, streams: list[dict], preference: dict | None = None, delivered: set | None = None, **reminders) -> list[dict]:
    """One dispatcher pass at `now`; returns every push payload that reached `webpush` (the real build_payload ran)."""
    monkeypatch.setattr(read_api, "get_live_streams", lambda *_a, **_kw: {"streams": streams})
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen_datetime(now))
    monkeypatch.setattr(notification_events_store, "list_events_for_date", lambda event_date: [])
    monkeypatch.setattr(remote_config_store, "list_by_key", lambda key: [{"clientId": "c1", "value": preference or _preference_value()}])
    monkeypatch.setattr(remote_config_store, "get_remote_config", _remote_config_stub(subscription=_subscription_value(), **reminders))
    log = delivered if delivered is not None else set()
    monkeypatch.setattr(notification_delivery_log_store, "already_delivered", lambda client_id, video_id: (client_id, video_id) in log)
    monkeypatch.setattr(notification_delivery_log_store, "mark_delivered", lambda client_id, video_id, at: log.add((client_id, video_id)) or True)
    monkeypatch.setattr(notification_delivery_log_store, "confirm_delivered", lambda *a, **kw: None)
    monkeypatch.setattr(notification_delivery_log_store, "release_claim", lambda client_id, video_id: log.discard((client_id, video_id)))
    sent: list[dict] = []

    def fake_webpush(*, subscription_info, data, **kwargs):
        sent.append(json.loads(data))

    monkeypatch.setattr(push_sender, "webpush", fake_webpush)
    lambda_handler({}, None)
    return sent


def kinds(sent: list[dict]) -> list[str]:
    return [payload["data"]["reminderKind"] for payload in sent]


STREAM = _sf6_stream()  # a SF6 stream by aizawa_ema -> topic "sf6"
SOURCES = ["override", "creator_all", "creator_topic"]


def reminders_for(source: str, timing: str) -> dict:
    if source == "override":
        return {"overrides": {STREAM["videoId"]: _override_value(notifyAtStart=timing == "start", advanceReminder=None if timing == "start" else timing)}}
    if source == "creator_all":
        return {"creator_reminders": {"aizawa_ema": setting(timing)}}
    return {"topic_reminders": {("aizawa_ema", "sf6"): setting(timing)}}


@pytest.mark.parametrize("source", SOURCES)
@pytest.mark.parametrize("timing", ALL_TIMINGS)
def test_each_of_the_five_timings_fires_in_its_own_window_with_a_valid_payload(monkeypatch, timing, source):
    due = fire_at(timing)
    reminders = reminders_for(source, timing)
    kind = "start" if timing == "start" else "advance"

    assert run(monkeypatch, now=due - timedelta(seconds=1), streams=[STREAM], **reminders) == []  # one second early: not due
    on_time = run(monkeypatch, now=due, streams=[STREAM], **reminders)
    assert kinds(on_time) == [kind]
    last_second = run(monkeypatch, now=due + timedelta(seconds=59), streams=[STREAM], **reminders)
    assert kinds(last_second) == [kind]
    assert run(monkeypatch, now=due + timedelta(seconds=60), streams=[STREAM], **reminders) == []  # window closed: never late

    payload = on_time[0]
    assert payload["data"]["videoId"] == STREAM["videoId"]
    assert payload["title"].strip() and payload["body"].strip(), "push_sender.build_payload requires a non-empty body"
    expected_body = "The stream has started" if timing == "start" else f"Starts in {BODY_LABEL[timing]}"
    assert payload["body"] == expected_body


def test_a_reminder_pushed_with_an_empty_body_would_be_rejected_by_the_real_sender():
    """The defect this file exists for: the old dispatcher passed body="" and the real sender refuses it."""
    result = push_sender.send_push_notification(
        _subscription_value(), title="t", body="", data={}, vapid_private_key="k", vapid_claims={"sub": "mailto:a@b.c"}
    )
    assert result.sent is False and "body" in (result.error or "")


@pytest.mark.parametrize("timing", ALL_TIMINGS)
def test_one_dispatcher_run_per_minute_sends_the_reminder_exactly_once_at_its_own_minute(monkeypatch, timing):
    """Minute-by-minute scan (1h before .. 3 min after, run at :02 s like the 1-minute schedule) with a real dedupe log."""
    log: set = set()
    sent_at: list[tuple[int, str]] = []
    for minute in range(-65, 4):
        now = START + timedelta(minutes=minute, seconds=2)
        for kind in kinds(run(monkeypatch, now=now, streams=[STREAM], delivered=log, **reminders_for("override", timing))):
            sent_at.append((minute, kind))
    expected_minute = 0 if timing == "start" else -TIMINGS[timing]
    assert sent_at == [(expected_minute, "start" if timing == "start" else "advance")]


# --- per-stream override beats creator-wide and creator+topic, for every timing ---------------------------------------------------
@pytest.mark.parametrize("timing", ALL_TIMINGS)
def test_a_per_stream_override_beats_creator_all_and_creator_topic_for_every_timing(monkeypatch, timing):
    other = "30min" if timing != "30min" else "10min"
    reminders = {
        **reminders_for("override", timing),
        "creator_reminders": {"aizawa_ema": setting(other)},
        "topic_reminders": {("aizawa_ema", "sf6"): setting("1hour" if timing != "1hour" else "1min")},
    }
    other_fire = fire_at(other)
    kind = "start" if timing == "start" else "advance"

    assert run(monkeypatch, now=other_fire, streams=[STREAM], **reminders) == []  # the shadowed creator-wide moment never fires
    assert kinds(run(monkeypatch, now=fire_at(timing), streams=[STREAM], **reminders)) == [kind]


@pytest.mark.parametrize("creator_timing", ALL_TIMINGS)
def test_an_explicit_per_stream_OFF_stops_that_stream_even_though_creator_all_would_notify(monkeypatch, creator_timing):
    """Example A: creator-wide reminder ON, per-stream override OFF -> this stream must NOT notify (any moment)."""
    off = {"overrides": {STREAM["videoId"]: _override_value(notifyAtStart=False, advanceReminder=None)}}
    reminders = {**off, "creator_reminders": {"aizawa_ema": setting(creator_timing)}}
    for minute in range(-65, 4):
        assert run(monkeypatch, now=START + timedelta(minutes=minute, seconds=2), streams=[STREAM], **reminders) == []


@pytest.mark.parametrize("timing", ALL_TIMINGS)
def test_a_per_stream_ON_notifies_when_the_creator_has_no_reminder_of_its_own(monkeypatch, timing):
    """Example B: no creator-wide setting; the explicit per-stream override ON is followed."""
    kind = "start" if timing == "start" else "advance"
    assert kinds(run(monkeypatch, now=fire_at(timing), streams=[STREAM], **reminders_for("override", timing))) == [kind]


@pytest.mark.parametrize("timing", ALL_TIMINGS)
def test_another_stream_of_the_same_creator_is_unaffected_by_a_per_stream_override(monkeypatch, timing):
    other_stream = _holodex_stream(videoId="other_stream", title="Ranked grind")
    reminders = {"overrides": {STREAM["videoId"]: _override_value(notifyAtStart=False, advanceReminder=None)}, "creator_reminders": {"aizawa_ema": setting(timing)}}
    sent = run(monkeypatch, now=fire_at(timing), streams=[STREAM, other_stream], **reminders)
    assert [payload["data"]["videoId"] for payload in sent] == ["other_stream"]


# --- suppression at the fire time: global OFF / mute / quiet hours / creator disabled -> discarded, for every timing ---------------
def _suppression(timing: str, kind: str) -> dict:
    due = fire_at(timing)
    if kind == "global_off":
        return _preference_value(enabled=False)
    if kind == "mute":
        return _preference_value(temporaryMute=(due + timedelta(hours=2)).isoformat())
    if kind == "quiet_hours":
        jst = due.astimezone(timezone(timedelta(hours=9)))
        begin = (jst - timedelta(minutes=5)).strftime("%H:%M")
        end = (jst + timedelta(minutes=5)).strftime("%H:%M")
        return _preference_value(quietHours=[begin, end])
    return _preference_value(creatorOverride={"aizawa_ema": False})


@pytest.mark.parametrize("kind", ["global_off", "mute", "quiet_hours", "creator_disabled"])
@pytest.mark.parametrize("source", SOURCES)
@pytest.mark.parametrize("timing", ALL_TIMINGS)
def test_a_reminder_that_is_suppressed_at_its_fire_time_is_discarded(monkeypatch, timing, source, kind):
    preference = _suppression(timing, kind)
    assert run(monkeypatch, now=fire_at(timing), streams=[STREAM], preference=preference, **reminders_for(source, timing)) == []


# --- no replay: turning notifications ON after the due moment never sends it, but later stages still can -------------------------
@pytest.mark.parametrize("advance", list(TIMINGS))
def test_off_at_the_advance_moment_discards_it_and_turning_on_afterwards_never_replays_it_but_the_start_still_fires(monkeypatch, advance):
    """Setting = <advance> + at start. Notifications are OFF when the advance fires (the :02 s run inside its window) and ON again at
    every later minute: the advance is never replayed, the start reminder (its own, later fire time) still sends exactly once."""
    reminders = {"overrides": {STREAM["videoId"]: _override_value(notifyAtStart=True, advanceReminder=advance)}}
    advance_at = fire_at(advance)
    log: set = set()
    sent_at: list[tuple[int, str]] = []
    for minute in range(-65, 4):
        now = START + timedelta(minutes=minute, seconds=2)
        off = advance_at <= now < advance_at + timedelta(minutes=1)  # OFF only while the advance window is open
        for kind in kinds(run(monkeypatch, now=now, streams=[STREAM], preference=_preference_value(enabled=not off), delivered=log, **reminders)):
            sent_at.append((minute, kind))
    assert sent_at == [(0, "start")]


@pytest.mark.parametrize("advance", list(TIMINGS))
def test_turning_on_after_the_whole_advance_window_closed_never_replays_it(monkeypatch, advance):
    reminders = {"overrides": {STREAM["videoId"]: _override_value(notifyAtStart=False, advanceReminder=advance)}}
    advance_at = fire_at(advance)
    log: set = set()
    off_during = run(monkeypatch, now=advance_at + timedelta(seconds=2), streams=[STREAM], preference=_preference_value(enabled=False), delivered=log, **reminders)
    on_after = run(monkeypatch, now=advance_at + timedelta(minutes=1, seconds=2), streams=[STREAM], preference=_preference_value(), delivered=log, **reminders)
    on_much_later = run(monkeypatch, now=advance_at + timedelta(minutes=5), streams=[STREAM], preference=_preference_value(), delivered=log, **reminders)
    assert off_during == [] and on_after == [] and on_much_later == []


def test_the_user_example_1h_30m_10m_1m_start_with_notifications_off_until_09_20(monkeypatch):
    """Stream at 10:00. OFF at 09:00 -> the 1-hour reminder is discarded; ON at 09:20 -> no 1-hour replay; each LATER stage that has
    its own fire time still sends. (One setting carries one advance offset, so each later stage is its own setting.)"""
    start = START
    for later, expect_kind in [("30min", "advance"), ("10min", "advance"), ("1min", "advance"), ("start", "start")]:
        reminders = {"overrides": {STREAM["videoId"]: _override_value(notifyAtStart=later == "start", advanceReminder=None if later == "start" else later)}}
        assert run(monkeypatch, now=start - timedelta(minutes=60, seconds=-2), streams=[STREAM], preference=_preference_value(enabled=False), **reminders) == []
        assert run(monkeypatch, now=start - timedelta(minutes=40), streams=[STREAM], preference=_preference_value(), **reminders) == []  # ON at 09:20
        assert kinds(run(monkeypatch, now=fire_at(later), streams=[STREAM], preference=_preference_value(), **reminders)) == [expect_kind]
    # the 1-hour setting itself: discarded while OFF at 09:00, not replayed at 09:20, nothing at 09:30
    one_hour = {"overrides": {STREAM["videoId"]: _override_value(notifyAtStart=False, advanceReminder="1hour")}}
    assert run(monkeypatch, now=start - timedelta(minutes=60), streams=[STREAM], preference=_preference_value(enabled=False), **one_hour) == []
    assert run(monkeypatch, now=start - timedelta(minutes=40), streams=[STREAM], preference=_preference_value(), **one_hour) == []
    assert run(monkeypatch, now=start - timedelta(minutes=30), streams=[STREAM], preference=_preference_value(), **one_hour) == []


# --- the fire time always comes from the CURRENT schedule (reschedule moves every timing) -----------------------------------------
@pytest.mark.parametrize("timing", ALL_TIMINGS)
def test_a_reschedule_moves_the_fire_time_of_every_timing(monkeypatch, timing):
    moved = _sf6_stream(scheduledStart=(START + timedelta(hours=1)).isoformat())
    reminders = reminders_for("override", timing)
    assert run(monkeypatch, now=fire_at(timing), streams=[moved], **reminders) == []  # the old time no longer fires
    new_due = fire_at(timing) + timedelta(hours=1)
    assert kinds(run(monkeypatch, now=new_due, streams=[moved], **reminders)) == ["start" if timing == "start" else "advance"]


def test_the_offsets_table_is_exactly_the_four_advance_timings_this_matrix_covers():
    assert live_reminder.ADVANCE_REMINDER_OFFSET_MINUTES == TIMINGS
