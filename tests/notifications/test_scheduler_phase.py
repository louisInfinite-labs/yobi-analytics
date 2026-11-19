"""The ~65 s lateness of every reminder (production, since 2026-10-21 14:17 UTC, when the Scheduler began passing its `scheduledTime`).

Model of the evidence: the dispatcher is invoked at :04.7 of every minute. Before the Scheduler input existed the run served `now` and a start on the
minute (:00) went out at +4.7 s. With the input the run serves the Scheduler's NOMINAL time, which AWS documents as "the time you specified for the schedule
to invoke its target" -- i.e. a few seconds BEFORE the invocation. A nominal time before the minute boundary does not yet reach a start on the boundary,
so the reminder waits for the next run: +64.7 s, exactly the value recorded in the delivery log for 33 of 33 start reminders matched to a real start.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from notifications import live_reminder, notification_dispatcher
from tests.notifications.test_scheduled_start_notifications import AT_START, SNAPSHOT_AT, START, Harness, _frozen, _stream

UTC = timezone.utc
RUN_PHASE = 4.7  # the production invocation lands :04.7 into every minute (the delivery log's `deliveredAt` seconds)


@pytest.fixture
def production_like(monkeypatch):
    """Recovery ON like production, one subscriber who wants the start of the 21:15 JST stream (a start on the minute boundary)."""
    monkeypatch.setattr(notification_dispatcher, "_MAX_RECOVERY_LOOKBACK", timedelta(minutes=10))
    monkeypatch.setattr(notification_dispatcher, "_last_served_ms", None)
    world = Harness(monkeypatch)
    world.add_client("c1", creator_reminders={"aizawa_ema": AT_START})
    world.refresh_snapshot([_stream("v1")], SNAPSHOT_AT)
    return world


def _invoke(world, monkeypatch, wall: datetime, nominal: datetime | None) -> dict:
    """One invocation at wall-clock `wall` carrying the Scheduler's whole-second nominal time (None = no input, as before 2026-10-21)."""
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen(wall))
    event = {} if nominal is None else {"scheduledTime": nominal.strftime("%Y-%m-%dT%H:%M:%SZ")}
    return notification_dispatcher.lambda_handler(event, None)


def _lag_of_start_push(world, monkeypatch, nominal_offset_s: float | None) -> float | None:
    """Run the minutes around START at :04.7 with a nominal time `nominal_offset_s` into each minute; the delivery lag (s) of the push, else None."""
    for minute in range(-2, 4):
        wall = START + timedelta(minutes=minute, seconds=RUN_PHASE)
        nominal = None if nominal_offset_s is None else (START + timedelta(minutes=minute, seconds=nominal_offset_s))
        before = len(world.pushes)
        _invoke(world, monkeypatch, wall, nominal)
        if len(world.pushes) > before:
            return (wall - START).total_seconds()
    return None


def test_without_the_scheduler_time_a_start_on_the_minute_goes_out_in_the_first_run_as_it_did_before_2026_10_21(production_like, monkeypatch):
    """The pre-2026-10-21 behaviour (no input): +4.7 s."""
    assert _lag_of_start_push(production_like, monkeypatch, None) == pytest.approx(4.7)


# Nominal second of the minute at which the Scheduler considers the invocation due. The production run is :04.7, so latencies of 4.7 .. 15 s put the
# nominal time at :49.7 .. :59 of the PREVIOUS minute; a nominal time on or after the boundary (:00, :01 ...) is the control group.
@pytest.mark.parametrize("nominal_offset", [-10.3, -5.7, -2.0, -1.0, 0.0, 1.0, 4.0])  # -2.0 is the value Patch 1 observed in production (nominal :58)
def test_a_start_on_the_minute_goes_out_in_the_first_run_whatever_second_the_scheduler_says(production_like, monkeypatch, nominal_offset):
    """After the fix: always +4.7 s. Before it: +64.7 s whenever the nominal time precedes the boundary (the production number)."""
    assert _lag_of_start_push(production_like, monkeypatch, nominal_offset) == pytest.approx(4.7)


@pytest.mark.parametrize("advance, minutes_before", [("10min", 10), ("1min", 1)])
def test_an_advance_reminder_is_not_pushed_a_run_late_either(production_like, monkeypatch, advance, minutes_before):
    """The advance reminder's fire time is also on the boundary, so it had the same one-run delay (the delivery log shows 10-minute reminders at ~8 min 55 s)."""
    production_like.config[("c1", live_reminder.creator_reminder_key("aizawa_ema", "all"))] = {"notifyAtStart": False, "advanceReminder": advance}
    fire = START - timedelta(minutes=minutes_before)
    for minute in range(-2, 3):
        wall = fire + timedelta(minutes=minute, seconds=RUN_PHASE)
        _invoke(production_like, monkeypatch, wall, fire + timedelta(minutes=minute, seconds=-1.0))
        if production_like.pushes:
            assert (wall - fire).total_seconds() == pytest.approx(4.7)
            return
    pytest.fail("no advance reminder was sent")


def test_a_genuinely_late_invocation_still_serves_the_minute_it_was_scheduled_for(production_like, monkeypatch):
    """A Scheduler retry / delayed invocation (lag well over the normal few seconds) keeps using its scheduledTime, so the retry policy still works."""
    notification_dispatcher._last_served_ms = None
    wall = START + timedelta(minutes=3, seconds=RUN_PHASE)
    summary = _invoke(production_like, monkeypatch, wall, START)  # scheduled for the start minute, delivered 3 minutes late, in a brand-new container
    assert summary["delivered"] == 1  # recovered, inside the 5-minute start grace


@pytest.mark.parametrize("lag_seconds, trusted", [(0, False), (5.7, False), (15, False), (29, False), (30, True), (65, True), (300, True)])
def test_the_scheduler_time_is_used_only_when_the_invocation_is_clearly_late(lag_seconds, trusted, monkeypatch):
    """Normal invocation latency (a few seconds) must never shift the evaluation instant; a retry or a delayed start must."""
    monkeypatch.setattr(notification_dispatcher, "_MAX_RECOVERY_LOOKBACK", timedelta(minutes=10))
    now = START + timedelta(minutes=10, seconds=RUN_PHASE)
    scheduled = (now - timedelta(seconds=lag_seconds)).replace(microsecond=0)
    used = notification_dispatcher._scheduled_instant({"scheduledTime": scheduled.strftime("%Y-%m-%dT%H:%M:%SZ")}, now)
    assert (used is not None) is trusted
