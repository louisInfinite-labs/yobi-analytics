"""The dispatcher under load and under failure: large recipient batches, the Lambda's time limit, missed / delayed / failed runs, retries, and expiry.

Policy under test (see the recovery notes at the top of notifications/notification_dispatcher.py): a reminder is still never delayed on purpose and never
replayed after the user changed something -- but a minute that nobody served because a run was missed, delayed, failed or cut short is served by the
next run, and only while the reminder is still true.
"""

from __future__ import annotations

import threading
import time
from datetime import datetime, timedelta, timezone

import pytest

from notifications import live_reminder, notification_dispatcher, parallel, push_sender
from notifications.push_sender import PushResult
from tests.notifications.op_counting_harness import CountingHarness
from tests.notifications.test_notification_dispatcher import _creator, _preference_value
from tests.notifications.test_scheduled_start_notifications import AT_START, SNAPSHOT_AT, START, _frozen, _stream

UTC = timezone.utc
START_MS = int(START.timestamp() * 1000)
CREATOR_KEY = live_reminder.creator_reminder_key("aizawa_ema", "all")


@pytest.fixture
def recovery(monkeypatch):
    """Recovery of unserved minutes ON (the autouse default for the other suites is off), in a cold container."""
    monkeypatch.setattr(notification_dispatcher, "_MAX_RECOVERY_LOOKBACK", timedelta(minutes=10))
    monkeypatch.setattr(notification_dispatcher, "_last_served_ms", None)


@pytest.fixture
def world(monkeypatch):
    """One subscriber (c1) who wants the start of aizawa_ema; the 21:15 JST stream is in the shared snapshot."""
    harness = CountingHarness(monkeypatch)
    harness.add_client("c1", creator_reminders={"aizawa_ema": AT_START})
    harness.refresh_snapshot([_stream("v1")], SNAPSHOT_AT)
    return harness


def _titles(world) -> list[str]:
    """Titles of every push that actually went out."""
    return [push["title"] for push in world.pushes if push["sent"]]


# ============ evaluation instants (pure) ============


def _instants(monkeypatch, *, last: datetime | None, anchor: datetime, event=None, lookback=timedelta(minutes=10)):
    """The instants a run at `anchor` serves, given the warm container's last finished instant."""
    monkeypatch.setattr(notification_dispatcher, "_MAX_RECOVERY_LOOKBACK", lookback)
    monkeypatch.setattr(notification_dispatcher, "_last_served_ms", int(last.timestamp() * 1000) if last else None)
    return notification_dispatcher._evaluation_instants(event, anchor)


def test_a_normal_minute_serves_exactly_its_own_instant(monkeypatch):
    """Back-to-back runs leave no gap, so no recovery work and no extra reads."""
    now = START
    assert _instants(monkeypatch, last=now - timedelta(minutes=1), anchor=now) == [now]
    assert _instants(monkeypatch, last=now - timedelta(seconds=63), anchor=now) == [now]  # ordinary scheduling jitter is not a missed run
    assert _instants(monkeypatch, last=now - timedelta(seconds=89), anchor=now) == [now]
    assert len(_instants(monkeypatch, last=now - timedelta(seconds=95), anchor=now)) == 2  # beyond the jitter allowance it is a gap


def test_a_gap_is_tiled_with_no_hole_and_the_run_still_ends_on_its_own_instant(monkeypatch):
    """Every fire time between the last finished instant and the new one falls in exactly one served window: (instant - 1 min, instant]."""
    last, now = START, START + timedelta(minutes=4, seconds=20)

    instants = _instants(monkeypatch, last=last, anchor=now)

    assert instants[-1] == now
    window = timedelta(minutes=1)
    for offset_ms in range(1, int((now - last - window).total_seconds() * 1000) + 1, 997):
        fire = last + timedelta(milliseconds=offset_ms)
        assert any(instant - window < fire <= instant for instant in instants), fire
    assert all(a < b for a, b in zip(instants, instants[1:]))


def test_a_cold_container_serves_the_minute_before_its_own_because_a_cold_start_follows_a_timeout_or_a_deploy(monkeypatch):
    """It knows nothing about earlier runs, so it re-serves exactly the previous minute (the delivery claim makes that harmless)."""
    assert _instants(monkeypatch, last=None, anchor=START) == [START - timedelta(minutes=1), START]


def test_recovery_never_reaches_back_further_than_the_lookback(monkeypatch):
    """A long outage is not replayed: at most the lookback's worth of minutes."""
    instants = _instants(monkeypatch, last=START - timedelta(hours=3), anchor=START)

    assert instants[0] >= START - timedelta(minutes=10) and len(instants) <= 11


def test_with_the_lookback_off_a_run_serves_only_itself(monkeypatch):
    """The switch that restores the pre-recovery behaviour."""
    assert _instants(monkeypatch, last=START - timedelta(hours=1), anchor=START, lookback=timedelta(0)) == [START]


def test_the_schedulers_own_scheduled_time_is_the_runs_instant_when_it_is_sane(monkeypatch):
    """A delayed or retried invocation serves the minute it was scheduled for; a garbage, naive, future or ancient value is ignored."""
    monkeypatch.setattr(notification_dispatcher, "_MAX_RECOVERY_LOOKBACK", timedelta(minutes=10))
    now = START + timedelta(minutes=3)

    assert notification_dispatcher._scheduled_instant({"scheduledTime": START.isoformat().replace("+00:00", "Z")}, now) == START
    assert notification_dispatcher._scheduled_instant({"scheduledTime": "not a time"}, now) is None
    assert notification_dispatcher._scheduled_instant({"scheduledTime": "2026-10-17T12:15:00"}, now) is None  # no UTC offset
    assert notification_dispatcher._scheduled_instant({"scheduledTime": (now + timedelta(minutes=1)).isoformat()}, now) is None
    assert notification_dispatcher._scheduled_instant({"scheduledTime": (now - timedelta(minutes=11)).isoformat()}, now) is None
    assert notification_dispatcher._scheduled_instant({}, now) is None and notification_dispatcher._scheduled_instant(None, now) is None


# ============ missed, delayed and failed runs ============


def test_a_missed_run_is_recovered_by_the_next_run_for_the_start_reminder(world, recovery):
    """Nobody ran in the minute of the scheduled start; the run two minutes later still delivers it -- once, with the ordinary start wording."""
    world.run(START - timedelta(minutes=5))

    summary = world.run(START + timedelta(minutes=2))

    assert summary["delivered"] == 1 and summary["recoveredInstants"] >= 1
    assert _titles(world)[0].endswith("is scheduled to go live now")
    assert world.run(START + timedelta(minutes=3))["delivered"] == 0  # and never again


def test_a_start_reminder_is_not_recovered_after_the_grace_period(world, recovery):
    """Five minutes after the scheduled start a 'scheduled to go live now' notice is stale: it is dropped, not sent."""
    world.run(START - timedelta(minutes=5))

    assert world.run(START + timedelta(minutes=6))["delivered"] == 0
    assert world.pushes == []


def test_a_missed_advance_reminder_is_recovered_with_the_real_time_left(world, recovery):
    """The 30-minute reminder missed at 21:45: delivered at 21:49 saying 'in about 26 minutes', never the false 'in 30 minutes'."""
    world.config[("c1", CREATOR_KEY)] = {"notifyAtStart": False, "advanceReminder": "30min"}
    world.run(START - timedelta(minutes=45))

    summary = world.run(START - timedelta(minutes=26))

    assert summary["delivered"] == 1
    assert _titles(world)[0].endswith("goes live in about 26 minutes")


def test_a_missed_advance_reminder_is_not_recovered_once_less_than_two_minutes_remain(world, recovery):
    """The 1-minute reminder missed: at the start there is nothing true left to say."""
    world.config[("c1", CREATOR_KEY)] = {"notifyAtStart": False, "advanceReminder": "1min"}
    world.run(START - timedelta(minutes=3))

    assert world.run(START + timedelta(seconds=20))["delivered"] == 0


def test_recovery_never_resends_what_was_delivered_on_time(world, recovery):
    """A reminder served on time is not sent again when a later run re-serves its minute (cold container, gap, retried event)."""
    world.run(START - timedelta(minutes=2))
    assert world.run(START + timedelta(seconds=10))["delivered"] == 1

    notification_dispatcher._last_served_ms = None  # a cold container re-serves the minute before its own
    assert world.run(START + timedelta(seconds=70))["delivered"] == 0
    notification_dispatcher._last_served_ms = int((START - timedelta(minutes=5)).timestamp() * 1000)  # and a stale memory re-serves a lot
    assert world.run(START + timedelta(minutes=2))["delivered"] == 0
    assert len(world.pushes) == 1


@pytest.mark.parametrize("what", ["setting", "subscription", "preference"])
def test_recovery_never_replays_a_setting_or_subscription_or_preference_saved_after_the_reminder_came_due(world, recovery, monkeypatch, what):
    """Turning a reminder on (or re-subscribing, or editing the preference) after its fire time must not make it fire retroactively."""
    late = (START + timedelta(minutes=1)).isoformat()
    original = world._get_config
    if what == "setting":
        monkeypatch.setattr(
            "stores.remote_config_store.list_by_key",
            lambda key: [{"clientId": "c1", "key": key, "value": AT_START, "updatedAt": late}] if key == CREATOR_KEY else [],
        )
    else:
        record_key = "pushSubscription" if what == "subscription" else "notificationPreference"

        def saved_late(client_id, key):
            """Everything is old except the one record under test."""
            record = original(client_id, key)
            return {**record, "updatedAt": late} if record is not None and key == record_key else record

        monkeypatch.setattr("stores.remote_config_store.get_remote_config", saved_late)
    world.run(START - timedelta(minutes=5))

    assert world.run(START + timedelta(minutes=2))["delivered"] == 0


def test_the_same_reminder_is_recovered_when_everything_was_saved_before_it_came_due(world, recovery):
    """The control for the three cases above: nothing saved late means the reminder IS recovered."""
    world.run(START - timedelta(minutes=5))

    assert world.run(START + timedelta(minutes=2))["delivered"] == 1


def test_recovery_judges_mute_at_the_fire_time_and_now_like_an_on_time_reminder(world, recovery):
    """A client muted when the reminder came due is not told afterwards that it expired; a client muted now is not either."""
    world.add_client("muted_then", preference=_preference_value(temporaryMute=(START + timedelta(minutes=1)).isoformat()), creator_reminders={"aizawa_ema": AT_START})
    world.add_client("muted_now", preference=_preference_value(temporaryMute=(START + timedelta(minutes=10)).isoformat()), creator_reminders={"aizawa_ema": AT_START})
    world.run(START - timedelta(minutes=5))

    world.run(START + timedelta(minutes=2))

    assert sorted(push["endpoint"].rsplit("/", 1)[1] for push in world.pushes) == ["c1"]


def test_a_retried_invocation_serves_the_minute_it_was_scheduled_for(world, recovery, monkeypatch):
    """The Scheduler retries a failed invocation later; its scheduledTime makes it serve its own minute even in a brand-new container."""
    world.run(START - timedelta(minutes=10))
    notification_dispatcher._last_served_ms = None  # nothing remembered: only the event can say which minute this is
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen(START + timedelta(minutes=3)))

    summary = notification_dispatcher.lambda_handler({"scheduledTime": START.isoformat()}, None)

    assert summary["delivered"] == 1 and _titles(world)[0].endswith("is scheduled to go live now")


def test_without_the_scheduled_time_the_same_late_run_in_a_cold_container_cannot_know_and_serves_only_the_previous_minute(world, recovery):
    """What the Scheduler input adds: a cold run three minutes late has no way to reach the start minute on its own."""
    world.run(START - timedelta(minutes=10))
    notification_dispatcher._last_served_ms = None

    assert world.run(START + timedelta(minutes=3))["delivered"] == 0


def test_a_run_that_failed_for_everyone_does_not_advance_the_memory_so_the_next_run_recovers_its_minute(world, recovery, monkeypatch):
    """A systemic failure raises (so the Lambda error metric and the Scheduler retry see it) and leaves the gap open for the next run."""
    world.run(START - timedelta(minutes=5))
    remembered = notification_dispatcher._last_served_ms
    original = world._get_config

    def broken(client_id, key):
        """Every per-client read fails; only the system records answer."""
        if client_id != "__system__":
            raise RuntimeError("DynamoDB down")
        return original(client_id, key)

    monkeypatch.setattr("stores.remote_config_store.get_remote_config", broken)
    with pytest.raises(RuntimeError, match="DynamoDB down"):
        world.run(START + timedelta(seconds=10))
    assert notification_dispatcher._last_served_ms == remembered

    monkeypatch.setattr("stores.remote_config_store.get_remote_config", original)
    assert world.run(START + timedelta(minutes=2))["delivered"] == 1


def test_a_recovery_with_nothing_due_costs_no_storage_operation(world, recovery):
    """A gap in an idle stretch re-serves minutes in which nothing is due: that is memory arithmetic, not reads."""
    world.run(START - timedelta(hours=5))
    world.take_ops()

    world.run(START - timedelta(hours=5) + timedelta(minutes=8))

    assert not [op for op in world.take_ops() if op[0] in ("list_by_key", "list_prefix", "delivery_read", "delivery_write")]


# ============ the Lambda's time limit ============


class _Context:
    """A Lambda context whose remaining time collapses once `budget` pushes have gone out."""

    def __init__(self, world, budget: int):
        """Count pushes from now on."""
        self.world, self.start, self.budget = world, len(world.pushes), budget

    def get_remaining_time_in_millis(self) -> int:
        """Plenty until the budget is used, then less than the safety margin."""
        return 1_000_000 if len(self.world.pushes) - self.start < self.budget else 1_000


def _fans(world, count: int) -> None:
    """`count` more subscribers of aizawa_ema's start."""
    for index in range(count):
        world.add_client(f"fan{index:04d}", creator_reminders={"aizawa_ema": AT_START})


def test_a_run_that_reaches_its_deadline_reports_what_it_did_not_start_and_does_not_pretend_the_minute_was_served(world, recovery):
    """No silent loss: the unstarted recipients are counted, logged, and the container's memory stays behind them."""
    _fans(world, 5)
    world.run(START - timedelta(minutes=2))
    remembered = notification_dispatcher._last_served_ms

    summary = world.run(START + timedelta(seconds=10), _Context(world, 3))

    assert summary["delivered"] == 3 and summary["unserved"] == 3
    assert notification_dispatcher._last_served_ms == remembered


def test_the_recipients_a_cut_short_run_did_not_start_are_served_by_the_next_run_exactly_once(world, recovery):
    """The unstarted tail is recovered one minute later as a (still true) start reminder; the first three are not repeated."""
    _fans(world, 5)
    world.run(START - timedelta(minutes=2))
    world.run(START + timedelta(seconds=10), _Context(world, 3))

    second = world.run(START + timedelta(seconds=70))

    assert second["delivered"] == 3 and "unserved" not in second
    endpoints = [push["endpoint"] for push in world.pushes if push["sent"]]
    assert len(endpoints) == 6 and len(set(endpoints)) == 6


def test_a_tail_that_cannot_be_started_in_time_is_dropped_only_after_the_grace_not_silently_at_the_deadline(world, recovery):
    """If even the next runs cannot reach a recipient, it is served for as long as the start reminder is still true and then gives up."""
    _fans(world, 2)
    world.run(START - timedelta(minutes=2))
    world.run(START + timedelta(seconds=10), _Context(world, 1))

    world.run(START + timedelta(minutes=2), _Context(world, 0))  # still no time at all
    served_later = world.run(START + timedelta(minutes=4))  # time again, inside the 5-minute grace

    assert served_later["delivered"] == 2
    assert world.run(START + timedelta(minutes=7))["delivered"] == 0


# ============ large recipient batches ============


class _SlowPush:
    """A thread-safe fake push service that takes a moment per request and records how many were in flight at once."""

    def __init__(self):
        """Empty counters."""
        self.lock = threading.Lock()
        self.in_flight = 0
        self.max_in_flight = 0
        self.endpoints: list[str] = []
        self.threads: set[int] = set()

    def __call__(self, subscription, *, title, body, data, vapid_private_key, vapid_claims):
        """One push: ~2 ms of 'network'."""
        with self.lock:
            self.in_flight += 1
            self.max_in_flight = max(self.max_in_flight, self.in_flight)
            self.threads.add(threading.get_ident())
        time.sleep(0.002)
        with self.lock:
            self.in_flight -= 1
            self.endpoints.append(subscription["endpoint"])
        return PushResult(sent=True, subscription_expired=False)


def test_a_large_batch_is_served_concurrently_and_every_recipient_is_delivered_exactly_once(world, monkeypatch):
    """600 due recipients with 8 workers: genuinely concurrent (never more than 8 at once), all delivered once, same result as one at a time."""
    monkeypatch.setattr(notification_dispatcher, "_SEND_WORKERS", 8)
    push = _SlowPush()
    monkeypatch.setattr(push_sender, "send_push_notification", push)
    _fans(world, 600)
    world.run(START - timedelta(minutes=2))

    summary = world.run(START + timedelta(seconds=10))

    assert summary["delivered"] == 601
    assert len(push.endpoints) == 601 and len(set(push.endpoints)) == 601
    assert 1 < push.max_in_flight <= 8 and len(push.threads) > 1


def test_a_large_batch_that_hits_the_deadline_mid_flight_loses_nobody(world, monkeypatch, recovery):
    """With 8 workers and the deadline arriving after ~200 pushes, the rest is reported as unserved and delivered by the next run, each client once."""
    monkeypatch.setattr(notification_dispatcher, "_SEND_WORKERS", 8)
    push = _SlowPush()
    monkeypatch.setattr(push_sender, "send_push_notification", push)
    _fans(world, 500)
    world.run(START - timedelta(minutes=2))

    class _Deadline:
        """Time runs out once 200 pushes have gone out (counted from the fake push service itself)."""

        def get_remaining_time_in_millis(self):
            """Plenty until 200 pushes went out, then less than the margin."""
            return 1_000_000 if len(push.endpoints) < 200 else 1_000

    first = world.run(START + timedelta(seconds=10), _Deadline())
    assert first["unserved"] > 0 and first["delivered"] + first["unserved"] == 501

    second = world.run(START + timedelta(seconds=70))

    assert first["delivered"] + second["delivered"] == 501
    assert len(push.endpoints) == 501 and len(set(push.endpoints)) == 501


def test_overlapping_workers_cannot_double_send_a_recipient(world, monkeypatch):
    """Two runs serving the same minute at once (a retry, a second container) race on the delivery log's atomic claim: one send per client."""
    monkeypatch.setattr(notification_dispatcher, "_SEND_WORKERS", 8)
    push = _SlowPush()
    monkeypatch.setattr(push_sender, "send_push_notification", push)
    _fans(world, 120)
    world.run(START - timedelta(minutes=2))
    claim_lock = threading.Lock()
    original = world._mark_delivered

    def atomic_claim(client_id, video_id, claimed_at, *, now=None):
        """The real store's conditional put is atomic; the in-memory fake must be too once threads call it."""
        with claim_lock:
            return original(client_id, video_id, claimed_at, now=now)

    monkeypatch.setattr("stores.notification_delivery_log_store.mark_delivered", atomic_claim)
    runs = [threading.Thread(target=world.run, args=(START + timedelta(seconds=10),)) for _ in range(2)]
    for thread in runs:
        thread.start()
    for thread in runs:
        thread.join()

    assert len(push.endpoints) == 121 and len(set(push.endpoints)) == 121


def test_one_clients_failure_in_a_parallel_batch_does_not_stop_the_others(world, monkeypatch):
    """Per-client isolation holds with threads: the failing client is logged and skipped, everyone else is delivered."""
    monkeypatch.setattr(notification_dispatcher, "_SEND_WORKERS", 8)
    _fans(world, 40)
    world.run(START - timedelta(minutes=2))
    original = world._get_config

    def flaky(client_id, key):
        """One recipient's read fails."""
        if client_id == "fan0007":
            raise RuntimeError("throttled")
        return original(client_id, key)

    monkeypatch.setattr("stores.remote_config_store.get_remote_config", flaky)

    assert world.run(START + timedelta(seconds=10))["delivered"] == 40


# ============ the pool itself ============


def test_run_ordered_returns_results_in_item_order_and_captures_exceptions_in_their_slot():
    """Completion order never leaks, one item's exception is its own result, and every item is attempted."""
    def work(item):
        """Fast for later items, slow for early ones, one failure."""
        time.sleep(0.01 if item < 3 else 0)
        if item == 4:
            raise ValueError("four")
        return item * 10

    results = parallel.run_ordered(work, list(range(8)), workers=4)

    assert results[:4] == [0, 10, 20, 30] and isinstance(results[4], ValueError) and results[5:] == [50, 60, 70]


def test_run_ordered_with_one_worker_runs_inline_on_the_calling_thread():
    """No thread start-up cost and deterministic order for the single-recipient case and the test suite."""
    seen = []

    parallel.run_ordered(lambda item: seen.append(threading.get_ident()), [1, 2, 3], workers=1)

    assert set(seen) == {threading.get_ident()}


def test_the_stores_build_each_threads_resource_from_that_threads_own_boto3_session(monkeypatch):
    """boto3 Resource AND the shared default Session are not thread-safe to build from concurrently: every thread gets its own Session, once."""
    from stores import notification_delivery_log_store, remote_config_store

    for module in (remote_config_store, notification_delivery_log_store):
        sessions: list[object] = []

        class _Session:
            """A stand-in boto3 Session that records that it was created and hands out its own resource."""

            def __init__(self):
                """Record this Session."""
                sessions.append(self)

            def resource(self, name):
                """This Session's own resource."""
                return object()

        monkeypatch.setattr(module.boto3.session, "Session", _Session)
        monkeypatch.setattr(module, "_local", threading.local())
        seen: list[object] = []

        def fetch(module=module, seen=seen):
            """Two calls on this thread: one Session, one resource."""
            first, second = module._resource(), module._resource()
            assert first is second
            seen.append(first)

        threads = [threading.Thread(target=fetch) for _ in range(3)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        assert len({id(resource) for resource in seen}) == 3 and len(sessions) == 3


def test_the_pool_keeps_its_threads_between_calls_so_their_resources_and_connections_stay_warm():
    """Every due minute is a new call: it must reuse the same worker threads instead of starting up to 16 new ones (and rebuilding their boto3 resources)."""
    def work(item):
        """Hold the thread briefly so the whole pool is used."""
        time.sleep(0.01)
        return threading.get_ident()

    first = set(parallel.run_ordered(work, list(range(24)), workers=6))
    second = set(parallel.run_ordered(work, list(range(24)), workers=6))

    assert 1 < len(first) <= 6 and second <= first
