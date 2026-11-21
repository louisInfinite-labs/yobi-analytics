"""When does a subscriber get NEITHER the 10-minutes-before notification NOR the at-start one? Each reminder is traced independently through the real dispatcher
(scheduling -> eligibility -> dedupe claim -> push attempt -> push-service answer) at the production cadence (a run at :04.7 of every minute).

"Delivered" here means the push service ACCEPTED the push (what the dispatcher can observe). Whether the device displayed it is not observable from the backend:
the service worker (frontend/dashboard/public/sw.js) shows every push that carries a payload, sets no notification `tag` (a duplicate would show twice), and a
push the push service holds (TTL) is shown when the device next connects.

Every scenario prints one `MATRIX|scenario|advance=...|start=...|pushes=N` line (run with -s) so the before/after table can be produced from the same test.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from notifications import notification_dispatcher, push_sender
from notifications.push_sender import PushResult
from stores import remote_config_store
from tests.notifications.test_late_discovery_catch_up import (
    ADV10,
    FLAG,
    ON,
    START,
    SYSTEM,
    CatchUpHarness,
    _stream,
)

UTC = timezone.utc
RUN = timedelta(seconds=4.7)
OK = PushResult(sent=True, subscription_expired=False)
TRANSIENT = PushResult(sent=False, subscription_expired=False, error="HTTP 503", retryable=True, status_code=503)
GONE = PushResult(sent=False, subscription_expired=True, error="HTTP 410", status_code=410)
CREATOR_KEY_ARGS = ("aizawa_ema", "all")


@pytest.fixture
def world(monkeypatch):
    """Production-like dispatcher: recovery ON, cold container; one subscriber with BOTH reminders (10 minutes before + at start)."""
    monkeypatch.setattr(notification_dispatcher, "_MAX_RECOVERY_LOOKBACK", timedelta(minutes=10))
    monkeypatch.setattr(notification_dispatcher, "_last_served_ms", None)
    if hasattr(notification_dispatcher, "_unsaved_retry_items"):
        monkeypatch.setattr(notification_dispatcher, "_unsaved_retry_items", {})
    monkeypatch.setattr(push_sender, "_RETRY_PAUSE_SECONDS", 0)
    harness = CatchUpHarness(monkeypatch)
    harness.add_client("c1", creator_reminders={"aizawa_ema": ADV10})
    harness.config[(SYSTEM, FLAG)] = ON  # the late-discovery catch-up is ON in production
    return harness


def _snapshot(world, streams, at: datetime) -> None:
    """The 10-minute display job ran at `at` and now lists `streams`."""
    world.refresh_snapshot(streams, at)


def _cadence(world, first_minute: int, last_minute: int, between=None) -> None:
    """A dispatcher run at :04.7 of every minute from START+first_minute to START+last_minute (`between(minute)` runs before each, to change the world)."""
    for minute in range(first_minute, last_minute + 1):
        if between is not None:
            between(minute)
        world.run(START + timedelta(minutes=minute) + RUN)


def _outcome(world, scenario: str) -> dict[str, str]:
    """Per reminder kind: "delivered" (accepted by the push service), "failed" (attempted, never accepted) or "not attempted"."""
    result = {}
    for kind in ("advance", "start"):
        pushes = [p for p in world.pushes if (p["data"] or {}).get("reminderKind") == kind and p["endpoint"].endswith("/c1")]  # the subscriber under test only
        result[kind] = "delivered" if any(p["sent"] for p in pushes) else "failed" if pushes else "not attempted"
    print(f"MATRIX|{scenario}|advance={result['advance']}|start={result['start']}|pushes={sum(1 for p in world.pushes if p['endpoint'].endswith('/c1'))}")
    return result


def _delivered_times(world, kind: str) -> list[float]:
    """Seconds after the scheduled START at which pushes of `kind` were accepted (from the dedupe rows the dispatcher wrote)."""
    return sorted(
        (datetime.fromisoformat(row["at"]) - START).total_seconds()
        for (client, key), row in world.delivery.items()
        if f":reminder:{kind}@" in key and row["status"] == "delivered"
    )


def _healthy_from(world, minutes_before: int = 60) -> None:
    """The stream is in the shared snapshot long before the reminders."""
    _snapshot(world, [_stream(start=START)], START - timedelta(minutes=minutes_before, seconds=-7))


# ============ the control and the by-design cases ============


def test_healthy_both_reminders_are_delivered_on_time(world):
    """The baseline: advance at its fire time, start at the scheduled start (deployed code: +64.7 s late each; fixed: +4.7 s)."""
    _healthy_from(world)

    _cadence(world, -12, 3)

    assert _outcome(world, "healthy") == {"advance": "delivered", "start": "delivered"}
    assert _delivered_times(world, "start") == [pytest.approx(4.7)]
    assert _delivered_times(world, "advance") == [pytest.approx(-600 + 4.7)]


def test_dead_subscription_gives_neither_and_is_attempted_once_then_marked(world, monkeypatch):
    """A confirmed 410: BOTH reminders are lost (nothing can reach a dead subscription) -- the fix is that it is marked inactive after ONE attempt instead of
    being tried again at every later moment, so the user's state is visible and it recovers by subscribing again."""
    marked = []
    inactive: set[str] = set()
    if hasattr(remote_config_store, "mark_push_subscription_inactive"):
        monkeypatch.setattr(remote_config_store, "mark_push_subscription_inactive", lambda client_id, endpoint, *, at, reason: marked.append(reason) or inactive.add(client_id) or True)
        real_get = remote_config_store.get_remote_config
        monkeypatch.setattr(
            remote_config_store,
            "get_remote_config",
            lambda client_id, key: ({**real_get(client_id, key), "inactiveAt": "t"} if key == "pushSubscription" and client_id in inactive and real_get(client_id, key) else real_get(client_id, key)),
        )
    world.push_results = [GONE] * 10
    _healthy_from(world)

    _cadence(world, -12, 3)

    assert _outcome(world, "dead-subscription-410") == {"advance": "failed", "start": "not attempted"}  # 2 pushes before the fix, 1 after
    assert sum(1 for p in world.pushes if p["endpoint"].endswith("/c1")) == 1 and marked == ["push_service_http_410"]


# ============ the gaps the fixes close ============


def test_a_transient_failure_at_the_advance_moment_no_longer_loses_the_advance_reminder(world):
    """Another recipient is healthy in the real incident class; here the retry queue alone carries c1's advance reminder."""
    world.push_results = [TRANSIENT, TRANSIENT]  # the advance moment's push and its immediate re-send fail; everything after succeeds
    _healthy_from(world)

    _cadence(world, -12, 3)

    assert _outcome(world, "transient-at-advance") == {"advance": "delivered", "start": "delivered"}


def test_a_transient_failure_at_the_start_moment_no_longer_loses_the_start_reminder(world):
    """Same for the start moment (the advance one went out normally)."""
    world.push_results = [OK, TRANSIENT, TRANSIENT]
    _healthy_from(world)

    _cadence(world, -12, 3)

    assert _outcome(world, "transient-at-start") == {"advance": "delivered", "start": "delivered"}


def test_a_push_service_outage_across_both_moments_loses_only_what_expired(world, monkeypatch):
    """Outage from before the advance moment until 40 s after the start: the advance reminder is gone (its floor is 2 minutes before the start), but the start
    reminder is no longer lost -- before the fix BOTH were."""
    state = {"now": START}
    original = world._send_push

    def send(subscription, **kwargs):
        """Fail until START + 40 s."""
        if notification_dispatcher.datetime.now(UTC) < START + timedelta(seconds=40):
            world.pushes.append({"title": kwargs["title"], "body": kwargs["body"], "data": kwargs["data"], "sent": False, "endpoint": subscription["endpoint"], "ttl": kwargs.get("ttl_seconds")})
            return TRANSIENT
        return original(subscription, **kwargs)

    monkeypatch.setattr(push_sender, "send_push_notification", send)
    del state
    _healthy_from(world)

    _cadence(world, -12, 6)

    assert _outcome(world, "outage-across-both-moments") == {"advance": "failed", "start": "delivered"}


def test_a_store_error_at_the_start_minute_no_longer_loses_the_start_reminder(world, monkeypatch):
    """The recipient's own record read fails in the one minute that mattered (a throttled DynamoDB): the retry queue brings the reminder back."""
    real_get = remote_config_store.get_remote_config

    def get(client_id, key):
        """c1's reads fail only during the start minute."""
        if client_id == "c1" and START <= notification_dispatcher.datetime.now(UTC) < START + timedelta(seconds=30):
            raise remote_config_store.RemoteConfigStoreError("throttled")
        return real_get(client_id, key)

    monkeypatch.setattr(remote_config_store, "get_remote_config", get)
    other = world  # a second, healthy subscriber keeps the run from "failing for everyone", exactly like production
    other.add_client("c2", creator_reminders={"aizawa_ema": ADV10})
    _healthy_from(world)

    _cadence(world, -12, 3)

    assert _outcome(world, "store-error-at-start") == {"advance": "delivered", "start": "delivered"}


# ============ discovery gaps (not delivery failures) ============


def test_a_stream_discovered_six_minutes_before_the_start_gets_a_catch_up_and_the_start_reminder(world):
    """The advance moment passed before the stream was known: the late-discovery catch-up (ON in production) says 'in about N minutes'; the start reminder is normal."""
    _snapshot(world, [], START - timedelta(minutes=16, seconds=-7))
    world.run(START - timedelta(minutes=16) + RUN)
    _snapshot(world, [_stream(start=START)], START - timedelta(minutes=6, seconds=-7))

    _cadence(world, -6, 3)

    assert _outcome(world, "discovered-6-min-before") == {"advance": "delivered", "start": "delivered"}
    assert any("about" in title for title in world.titles())


def test_a_stream_discovered_after_its_scheduled_start_gets_neither_reminder(world):
    """DESIGN GAP (not a delivery failure): Holodex lists the stream 3 minutes after its scheduled start. Its advance moment and its start moment are both in the
    past when it first enters the schedule, and neither the catch-up (advance only, needs 2 minutes left) nor the recovery (replays only instants a run missed)
    covers a start that was never known. Production example: 2 of 33 current schedule entries were first seen after their scheduled start."""
    _snapshot(world, [], START - timedelta(minutes=16, seconds=-7))

    def between(minute):
        """Holodex lists the stream for the first time in the snapshot 3 minutes after its scheduled start."""
        if minute == 3:
            _snapshot(world, [_stream(start=START)], START + timedelta(minutes=3, seconds=-7))

    _cadence(world, -12, 6, between)

    assert _outcome(world, "discovered-after-start") == {"advance": "not attempted", "start": "not attempted"}


def test_a_holodex_dropout_in_the_start_minute_loses_the_start_reminder(world):
    """DESIGN GAP: the stream is listed until 30 s before its start, then one snapshot omits it (a Holodex dropout / a stream briefly made private) and it
    returns after the start. The stored schedule no longer contains it at its start minute, so the start reminder never fires; the advance one already did."""
    _healthy_from(world)

    def between(minute):
        """The 10-minute snapshot at START-30 s omits the stream; the one after it has it back."""
        if minute == 0:
            _snapshot(world, [], START - timedelta(seconds=23))
        if minute == 2:
            _snapshot(world, [_stream(start=START)], START + timedelta(minutes=2, seconds=-23))

    _cadence(world, -12, 3, between)

    assert _outcome(world, "holodex-dropout-at-start") == {"advance": "delivered", "start": "not attempted"}
