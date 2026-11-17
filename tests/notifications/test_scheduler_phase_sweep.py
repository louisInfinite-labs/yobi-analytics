"""Patch 2 across the cases that matter: normal, early and late invocations, Scheduler retries, minute boundaries and clock drift -- never premature, never skipped,
never duplicated, eligibility untouched.

The observed production inputs (Patch 1 logs, 2026-11-16): the Scheduler's nominal `scheduledTime` is at second :58 of every minute and the run starts about :04.7
(a lag of ~6.7 s). Every case below is a variation around that, judged by the one thing a user sees: when the push is attempted relative to the moment it was due.
"""

from __future__ import annotations

import statistics
from datetime import datetime, timedelta, timezone

import pytest

from notifications import live_reminder, notification_dispatcher
from tests.notifications.test_notification_dispatcher import _preference_value
from tests.notifications.test_scheduled_start_notifications import AT_START, SNAPSHOT_AT, START, Harness, _frozen, _stream

UTC = timezone.utc


def _world(monkeypatch, start_second: float = 0.0, *, clients=("c1",)):
    """A world with the stream due at START + start_second and the given subscribers (all want the start)."""
    monkeypatch.setattr(notification_dispatcher, "_MAX_RECOVERY_LOOKBACK", timedelta(minutes=10))
    monkeypatch.setattr(notification_dispatcher, "_last_served_ms", None)
    world = Harness(monkeypatch)
    for client in clients:
        world.add_client(client, creator_reminders={"aizawa_ema": AT_START})
    world.refresh_snapshot([_stream("v1", start=START + timedelta(seconds=start_second))], SNAPSHOT_AT)
    return world


def _run(world, monkeypatch, wall: datetime, lag_s: float | None) -> None:
    """One invocation at `wall`; the Scheduler's whole-second nominal time is `lag_s` seconds before it (negative = after it), None = no input."""
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen(wall))
    event = {}
    if lag_s is not None:
        nominal = (wall - timedelta(seconds=lag_s)).replace(microsecond=0)
        event = {"scheduledTime": nominal.strftime("%Y-%m-%dT%H:%M:%SZ")}
    notification_dispatcher.lambda_handler(event, None)


def _push_times(world) -> list[datetime]:
    """When each push was attempted, from the delivery claims the dispatcher wrote."""
    return sorted(datetime.fromisoformat(row["at"]) for row in world.delivery.values())


def _cadence(world, monkeypatch, phase: float, lag: float | None, *, first=-3, last=4) -> list[datetime]:
    """Runs at `phase` seconds into every minute from START+first to START+last minutes, nominal time `lag` s before each run; the push times."""
    for minute in range(first, last + 1):
        _run(world, monkeypatch, START + timedelta(minutes=minute, seconds=phase), lag)
    return _push_times(world)


# ============ the production case, measured ============


def test_the_observed_production_inputs_nominal_at_58_run_at_4_7_deliver_a_start_on_the_minute_at_plus_4_7_seconds(monkeypatch):
    """Exactly the logged production values (nominal :58, run :04.7, lag 6.7 s): +4.7 s after the fix (the deployed code gives +64.7 s)."""
    world = _world(monkeypatch)
    times = _cadence(world, monkeypatch, 4.7, 6.7)

    assert len(times) == 1 and (times[0] - START).total_seconds() == pytest.approx(4.7)


# ============ normal / early / late invocations ============


@pytest.mark.parametrize("lag", [-45.0, -10.0, -1.0, 0.0, 2.0, 6.7, 15.0, 29.0])
def test_a_normal_or_early_invocation_is_served_at_the_wall_clock_never_prematurely(monkeypatch, lag):
    """The Scheduler's time up to 29 s BEFORE the run (normal latency, clock drift) or AFTER it (an early invocation / skewed clock) never moves the instant: the push
    is attempted at the first run on or after the due moment, never before it, exactly once."""
    world = _world(monkeypatch)
    times = _cadence(world, monkeypatch, 4.7, lag)

    assert len(times) == 1
    assert times[0] >= START  # never premature
    assert (times[0] - START).total_seconds() == pytest.approx(4.7)


def test_a_scheduler_time_in_the_future_is_ignored_and_cannot_fire_a_reminder_early(monkeypatch):
    """A nominal time AFTER the wall clock (a nonsense or skewed value) is ignored: a run 2 s before the start does nothing, the next run delivers."""
    world = _world(monkeypatch)
    _run(world, monkeypatch, START - timedelta(seconds=2), -60.0)  # nominal 60 s ahead of the wall clock
    assert world.delivery == {}
    _run(world, monkeypatch, START + timedelta(seconds=4.7), 6.7)
    assert len(world.delivery) == 1


@pytest.mark.parametrize("lag", [30.0, 59.0, 65.0, 120.0, 240.0])
def test_a_late_scheduler_invocation_still_serves_its_own_minute(monkeypatch, lag):
    """The invocation that serves a start on the minute is the one nominal at :58 AFTER it (START+58 s). When the Scheduler delivers it `lag` seconds late (>= 30 s, a retry or
    a delayed start), it still serves THAT minute, in a brand-new container too, inside the start reminder's 5-minute grace: exactly one push."""
    world = _world(monkeypatch)
    wall = START + timedelta(seconds=58 + lag)
    _run(world, monkeypatch, wall, lag)

    assert len(world.delivery) == 1


@pytest.mark.parametrize("lag", [250.0, 299.0, 599.0])
def test_a_scheduler_retry_beyond_the_reminders_grace_delivers_nothing_late(monkeypatch, lag):
    """A start reminder is not delivered more than 5 minutes after its start: a retry that arrives later is dropped quietly, not sent as an obsolete notification."""
    world = _world(monkeypatch)
    _run(world, monkeypatch, START + timedelta(seconds=58 + lag), lag)

    assert world.delivery == {}


def test_a_scheduler_time_older_than_the_lookback_is_ignored(monkeypatch):
    """Beyond 10 minutes the Scheduler's time is not trusted: the run serves the clock and replays nothing."""
    world = _world(monkeypatch)
    _run(world, monkeypatch, START + timedelta(minutes=20, seconds=4.7), 20 * 60 + 6.7)

    assert world.delivery == {}  # the start is 20 minutes old: past the 5-minute grace, nothing is replayed


def test_a_failed_minute_retried_by_the_scheduler_within_the_new_policy_delivers_once(monkeypatch):
    """The reason the retry policy exists: the invocation for the start minute failed; the Scheduler's retry arrives 3 minutes later carrying that minute's time (twice,
    as a duplicate retry of the same event can)."""
    world = _world(monkeypatch)
    wall = START + timedelta(seconds=58 + 120)
    _run(world, monkeypatch, wall, 120.0)
    _run(world, monkeypatch, wall, 120.0)

    assert len(world.delivery) == 1


# ============ minute boundaries, drift, sweeps ============


@pytest.mark.parametrize("start_second", [0.0, 0.5, 1.0, 3.9, 4.69, 4.71, 30.0, 57.9, 58.0, 59.0, 59.9])
def test_every_second_of_the_minute_for_the_due_moment_fires_once_and_never_early(monkeypatch, start_second):
    """The due moment at any second of the minute (including the seconds around the run's :04.7 and the nominal :58): exactly one push, never before it, at most one
    minute late."""
    world = _world(monkeypatch, start_second)
    times = _cadence(world, monkeypatch, 4.7, 6.7)
    due = START + timedelta(seconds=start_second)

    assert len(times) == 1
    assert times[0] >= due
    assert (times[0] - due).total_seconds() <= 60.0


@pytest.mark.parametrize("phase", [0.2, 2.0, 4.7, 30.0, 58.0, 59.9])
@pytest.mark.parametrize("lag", [None, 0.0, 6.7, 25.0])
def test_run_phase_and_scheduler_lag_sweep_never_skips_or_duplicates(monkeypatch, phase, lag):
    """Whatever second the cadence lands on and however far the Scheduler's time trails the run (below the 30 s trust threshold), a minute-boundary due moment fires
    exactly once, never before it."""
    world = _world(monkeypatch)
    times = _cadence(world, monkeypatch, phase, lag)

    assert len(times) == 1 and times[0] >= START
    assert (times[0] - START).total_seconds() <= 60.0 + 0.001


def test_a_long_jittery_cadence_serves_every_due_moment_exactly_once(monkeypatch):
    """Thirty-four back-to-back minutes with jittered run phases (:03.5 .. :07.5) and a trailing Scheduler time; ten streams due at ten different minute boundaries."""
    monkeypatch.setattr(notification_dispatcher, "_MAX_RECOVERY_LOOKBACK", timedelta(minutes=10))
    monkeypatch.setattr(notification_dispatcher, "_last_served_ms", None)
    world = Harness(monkeypatch)
    world.add_client("c1", creator_reminders={"aizawa_ema": AT_START})
    world.refresh_snapshot([_stream(f"v{i}", start=START + timedelta(minutes=3 * i)) for i in range(10)], SNAPSHOT_AT)
    jitter = [3.5, 7.5, 4.2, 6.1, 5.0, 3.9, 7.1, 4.7, 6.6, 5.5]
    for minute in range(-2, 32):
        _run(world, monkeypatch, START + timedelta(minutes=minute, seconds=jitter[minute % len(jitter)]), 6.7)

    due_by_video = {f"v{i}": START + timedelta(minutes=3 * i) for i in range(10)}
    delivered = {key[1].split(":")[0]: datetime.fromisoformat(row["at"]) for key, row in world.delivery.items()}
    assert set(delivered) == set(due_by_video) and len(world.delivery) == 10
    for video, at in delivered.items():
        assert 0 <= (at - due_by_video[video]).total_seconds() <= 8.0  # delivered in the first run after it was due, every time


def test_measured_improvement_on_the_minute_starts(monkeypatch):
    """The delivery lag for starts on the minute at the production phase is +4.7 s for every one of them (the deployed code gives +64.7 s)."""
    lags = []
    for _ in range(12):
        world = _world(monkeypatch)
        lags.append((_cadence(world, monkeypatch, 4.7, 6.7)[0] - START).total_seconds())

    assert statistics.median(lags) == pytest.approx(4.7) and max(lags) == pytest.approx(4.7)


# ============ eligibility and everything else is untouched ============


def test_recipient_eligibility_is_unchanged_a_disabled_or_unsubscribed_client_still_gets_nothing(monkeypatch):
    """The fix only moves WHEN a run evaluates; who is eligible is decided by the same code: the master switch off, no setting, and no subscription all still mean no push."""
    world = _world(monkeypatch, clients=("c1",))
    world.add_client("off", preference=_preference_value(enabled=False), creator_reminders={"aizawa_ema": AT_START})
    world.add_client("nosetting")  # a preference and a subscription, but no reminder setting
    world.add_client("nosub", creator_reminders={"aizawa_ema": AT_START}, subscribed=False)
    _cadence(world, monkeypatch, 4.7, 6.7)

    assert {client for client, _ in world.delivery} == {"c1"}


def test_the_advance_reminder_and_the_start_reminder_both_arrive_in_the_first_run_after_their_own_moment(monkeypatch):
    """A client with both reminders: the 10-minute one at its fire time + 4.7 s, the start one at the start + 4.7 s (the deployed code has both at +64.7 s)."""
    world = _world(monkeypatch)
    world.config[("c1", live_reminder.creator_reminder_key("aizawa_ema", "all"))] = {"notifyAtStart": True, "advanceReminder": "10min"}
    times = _cadence(world, monkeypatch, 4.7, 6.7, first=-12, last=3)

    offsets = sorted((t - START).total_seconds() for t in times)
    assert offsets == [pytest.approx(-600 + 4.7), pytest.approx(4.7)]
