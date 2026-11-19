"""The durable per-recipient retry of livestream reminders (notifications/reminder_retry.py).

The gap it closes: a failed send released its claim, but the 1-minute on-time window had passed and the Lambda raised only when EVERY candidate failed, so a
recipient whose push failed for a passing reason (429 / 5xx / transport error / a store hiccup) never received the reminder while the others did.
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from notifications import live_reminder, notification_dispatcher, reminder_retry
from notifications.push_sender import PushResult
from stores import remote_config_store
from tests.notifications.op_counting_harness import CountingHarness
from tests.notifications.test_scheduled_start_notifications import AT_START, SNAPSHOT_AT, START, _stream

RUN = timedelta(seconds=4.7)  # the production invocation phase
OK = PushResult(sent=True, subscription_expired=False)
TRANSIENT = PushResult(sent=False, subscription_expired=False, error="HTTP 503", retryable=True)
REJECTED = PushResult(sent=False, subscription_expired=False, error="HTTP 400", retryable=False)
GONE = PushResult(sent=False, subscription_expired=True, error="HTTP 410")
CREATOR_KEY = live_reminder.creator_reminder_key("aizawa_ema", "all")


@pytest.fixture
def world(monkeypatch):
    """Production-like: recovery ON, a cold container that has never read the retry record, two subscribers (c1, c2) who want the start of the stream."""
    monkeypatch.setattr(notification_dispatcher, "_MAX_RECOVERY_LOOKBACK", timedelta(minutes=10))
    monkeypatch.setattr(notification_dispatcher, "_last_served_ms", None)
    monkeypatch.setattr(notification_dispatcher, "_retry_pending", None)
    harness = CountingHarness(monkeypatch)
    harness.add_client("c1", creator_reminders={"aizawa_ema": AT_START})
    harness.add_client("c2", creator_reminders={"aizawa_ema": AT_START})
    harness.refresh_snapshot([_stream("v1")], SNAPSHOT_AT)
    return harness


def _endpoints(world) -> list[str]:
    """Endpoints that actually received a push, in order."""
    return [push["endpoint"].rsplit("/", 1)[1] for push in world.pushes if push["sent"]]


def _attempts_to(world, client: str) -> int:
    """How many pushes were attempted to `client` (sent or not)."""
    return sum(1 for push in world.pushes if push["endpoint"].endswith("/" + client))


def _queue(world) -> dict:
    """The open retry items as stored."""
    record = world.config.get((live_reminder.SYSTEM_CLIENT_ID, reminder_retry.RETRY_KEY)) or {}
    return record.get("items", {})


def _run_minutes(world, first_minute: int, last_minute: int) -> list[dict]:
    """The production cadence: a run at :04.7 of every minute from START+first_minute to START+last_minute."""
    return [world.run(START + timedelta(minutes=m) + RUN) for m in range(first_minute, last_minute + 1)]


# ============ the gap: one recipient fails while another succeeds ============


def test_a_recipient_whose_push_failed_is_retried_and_delivered_while_the_other_recipient_is_not_notified_twice(world):
    """The production gap: c1 succeeds so the run does not raise; c2 hits a 503 (twice, the immediate bounded retry) and used to lose the reminder for good."""
    world.push_results = [OK, TRANSIENT, TRANSIENT]

    first = world.run(START + RUN)

    assert first["delivered"] == 1 and _endpoints(world) == ["c1"]
    assert first["retries"] == {"queued": 1}
    assert len(_queue(world)) == 1

    later = _run_minutes(world, 1, 2)

    assert _endpoints(world) == ["c1", "c2"]  # c2 got it on the first retry that was due; c1 exactly once
    assert later[0]["retries"]["sent"] == 1
    assert _queue(world) == {}


def test_the_retry_is_scheduled_30_seconds_after_the_failure_and_taken_by_the_first_run_after_that(world):
    """Delay 30 s: stored for START+34.7 s; the :04.7 run one minute later is the first to take it."""
    world.config.pop(("c2", CREATOR_KEY))
    world.push_results = [TRANSIENT, TRANSIENT]

    world.run(START + RUN)
    (item,) = _queue(world).values()

    assert item["n"] == int((START + RUN + timedelta(seconds=30)).timestamp() * 1000) and _attempts_to(world, "c1") == 2

    world.run(START + timedelta(seconds=64.7))
    assert _endpoints(world) == ["c1"] and _queue(world) == {}


# ============ backoff, limits and expiry ============


def test_a_persistent_transient_failure_is_retried_on_a_backoff_and_then_given_up(world):
    """30 s, 1 min, 2 min, 4 min; the start reminder is also dead after 5 minutes, so it stops there, and the queue ends empty."""
    world.config.pop(("c2", CREATOR_KEY))
    world.push_results = [TRANSIENT] * 40

    world.run(START + RUN)
    attempts_after_each_run = []
    for minute in range(1, 8):
        world.run(START + timedelta(minutes=minute) + RUN)
        attempts_after_each_run.append(_attempts_to(world, "c1"))

    # run 0: 2 immediate attempts; retries at +64.7 s, +124.7 s, +244.7 s (each 2 attempts), then the next delay would pass the 5-minute grace
    assert attempts_after_each_run == [4, 6, 6, 8, 8, 8, 8]
    assert _queue(world) == {}
    assert _endpoints(world) == []  # nothing was ever delivered, nothing was sent after the grace


def test_a_retry_that_becomes_due_after_the_reminder_expired_is_not_delivered_late(world):
    """No run between START+1 min and START+6 min: the start reminder (grace 5 min) is gone, so the open item is settled without a push."""
    world.config.pop(("c2", CREATOR_KEY))
    world.push_results = [TRANSIENT, TRANSIENT]
    world.run(START + RUN)
    pushes_before = len(world.pushes)

    summary = world.run(START + timedelta(minutes=6) + RUN)

    assert len(world.pushes) == pushes_before
    assert summary["retries"]["expired"] == 1 and _queue(world) == {}


def test_an_advance_reminder_is_retried_with_the_real_time_left_and_not_after_its_floor(world):
    """10-minute reminder: retried 65 s late saying 'in about N minutes', never the false 'in 10 minutes'; a 1-minute reminder has nothing true left to retry."""
    world.config.pop(("c2", CREATOR_KEY))
    world.config[("c1", CREATOR_KEY)] = {"notifyAtStart": False, "advanceReminder": "10min"}
    fire = START - timedelta(minutes=10)
    world.push_results = [TRANSIENT, TRANSIENT]
    world.run(fire + RUN)

    world.run(fire + timedelta(minutes=1) + RUN)

    assert len([p for p in world.pushes if p["sent"]]) == 1
    assert "about" in [p for p in world.pushes if p["sent"]][0]["title"]

    world.pushes.clear()
    world.delivery.clear()
    world.config[("c1", CREATOR_KEY)] = {"notifyAtStart": False, "advanceReminder": "1min"}
    world.push_results = [TRANSIENT, TRANSIENT]
    world.run(START - timedelta(minutes=1) + RUN)  # on time for the 1-minute reminder, fails
    assert _queue(world) == {}  # less than two minutes left: no retry item could still be true


# ============ what must never be retried ============


@pytest.mark.parametrize("result", [REJECTED, GONE], ids=["rejected-4xx", "expired-subscription-404-410"])
def test_a_permanent_failure_is_never_retried(world, result):
    """A 4xx rejection or a dead subscription cannot succeed later: one attempt, no item, no further push in any later minute."""
    world.config.pop(("c2", CREATOR_KEY))
    world.push_results = [result] * 10

    world.run(START + RUN)
    _run_minutes(world, 1, 5)

    assert _attempts_to(world, "c1") == 1 and _queue(world) == {}


def test_a_read_timeout_is_not_retried_because_the_push_may_already_have_been_accepted(world):
    """The only ambiguous failure: a resend could show twice (the service worker sets no tag), so it is not retried."""
    world.config.pop(("c2", CREATOR_KEY))
    world.push_results = [PushResult(sent=False, subscription_expired=False, error="read timeout", retryable=False)]

    world.run(START + RUN)
    _run_minutes(world, 1, 3)

    assert _attempts_to(world, "c1") == 1 and _queue(world) == {}


# ============ no duplicates ============


def test_retries_never_notify_a_recipient_who_already_received_it(world):
    """c1 delivered, c2 retried: over many later minutes each of them has exactly one delivered push."""
    world.push_results = [OK, TRANSIENT, TRANSIENT]

    world.run(START + RUN)
    _run_minutes(world, 1, 8)

    assert sorted(_endpoints(world)) == ["c1", "c2"]


def test_a_delivery_made_by_someone_else_settles_the_retry_without_a_second_push(world):
    """An overlapping run (or the Scheduler's retry of the failed minute) delivered it first: the claim says so and the item is simply settled."""
    world.config.pop(("c2", CREATOR_KEY))
    world.push_results = [TRANSIENT, TRANSIENT]
    world.run(START + RUN)
    dedupe_id = f"v1:reminder:start@{int(START.timestamp() * 1000) // 60_000}"
    world.delivery[("c1", dedupe_id)] = {"status": "delivered", "at": (START + RUN).isoformat()}

    summary = world.run(START + timedelta(minutes=1) + RUN)

    assert _attempts_to(world, "c1") == 2 and summary["retries"]["settled"] == 1 and _queue(world) == {}


def test_a_claim_still_held_by_another_worker_is_waited_for_without_spending_an_attempt(world):
    """A live claim may yet be released (that worker failed): the item stays, with its attempt count untouched, and delivers once the claim is gone."""
    world.config.pop(("c2", CREATOR_KEY))
    world.push_results = [TRANSIENT, TRANSIENT]
    world.run(START + RUN)
    dedupe_id = f"v1:reminder:start@{int(START.timestamp() * 1000) // 60_000}"
    world.delivery[("c1", dedupe_id)] = {"status": "claimed", "at": (START + timedelta(seconds=50)).isoformat()}

    summary = world.run(START + timedelta(minutes=1) + RUN)
    (item,) = _queue(world).values()

    assert summary["retries"]["held"] == 1 and item["a"] == 0 and _endpoints(world) == []

    world.delivery.pop(("c1", dedupe_id))
    world.run(START + timedelta(minutes=2) + RUN)

    assert _endpoints(world) == ["c1"] and _queue(world) == {}


# ============ the retry judges the world as it is NOW ============


def test_a_rescheduled_stream_drops_the_retry_for_the_old_start(world):
    """The creator moved the stream: the old start's reminder is no longer true; the new start is its own target."""
    world.config.pop(("c2", CREATOR_KEY))
    world.push_results = [TRANSIENT, TRANSIENT]
    world.run(START + RUN)

    world.refresh_snapshot([_stream("v1", start=START + timedelta(minutes=30))], START + timedelta(seconds=30))
    summary = world.run(START + timedelta(minutes=1) + RUN)

    assert summary["retries"]["stream_gone_or_rescheduled"] == 1 and _endpoints(world) == [] and _queue(world) == {}


def test_a_cancelled_stream_drops_the_retry(world):
    """The stream left the schedule (cancelled / private / deleted): nothing is sent for it."""
    world.config.pop(("c2", CREATOR_KEY))
    world.push_results = [TRANSIENT, TRANSIENT]
    world.run(START + RUN)

    world.refresh_snapshot([], START + timedelta(seconds=30))
    world.run(START + timedelta(minutes=1) + RUN)

    assert _endpoints(world) == [] and _queue(world) == {}


def test_a_client_who_removed_the_setting_or_muted_in_the_meantime_gets_nothing(world):
    """Mute / quiet hours / a removed setting are judged again at retry time, exactly like a recovered reminder."""
    world.config.pop(("c2", CREATOR_KEY))
    world.push_results = [TRANSIENT, TRANSIENT]
    world.run(START + RUN)

    world.config.pop(("c1", CREATOR_KEY))
    summary = world.run(START + timedelta(minutes=1) + RUN)

    assert summary["retries"]["setting_removed"] == 1 and _endpoints(world) == [] and _queue(world) == {}


def test_a_subscription_saved_after_the_reminder_came_due_is_not_replayed(world):
    """The recovery rule carries over: turning notifications on after the moment never replays it."""
    world.config.pop(("c2", CREATOR_KEY))
    world.push_results = [TRANSIENT, TRANSIENT]
    world.run(START + RUN)
    real_get = remote_config_store.get_remote_config

    def get(client_id, key):
        """The subscription record now claims to have been saved at START + 10 s (after the fire time)."""
        record = real_get(client_id, key)
        if record is not None and key == notification_dispatcher._PUSH_SUBSCRIPTION_KEY:
            record = {**record, "updatedAt": (START + timedelta(seconds=10)).isoformat()}
        return record

    world._monkeypatch.setattr(remote_config_store, "get_remote_config", get)
    world.run(START + timedelta(minutes=1) + RUN)

    assert _endpoints(world) == []


# ============ failures that are not a push failure ============


def test_a_store_error_while_serving_one_recipient_is_retried_for_that_recipient_only(world, monkeypatch):
    """The per-client exception used to be logged and forgotten when anyone else succeeded; now it is queued and the recipient is served on the retry."""
    real_get = remote_config_store.get_remote_config
    broken = {"on": True}

    def get(client_id, key):
        """c2's reads fail while the hiccup lasts."""
        if broken["on"] and client_id == "c2":
            raise remote_config_store.RemoteConfigStoreError("throttled")
        return real_get(client_id, key)

    monkeypatch.setattr(remote_config_store, "get_remote_config", get)
    first = world.run(START + RUN)

    assert first["delivered"] == 1 and _endpoints(world) == ["c1"] and len(_queue(world)) == 1

    broken["on"] = False
    world.run(START + timedelta(minutes=1) + RUN)

    assert _endpoints(world) == ["c1", "c2"] and _queue(world) == {}


# ============ cost and safety of the queue itself ============


def test_an_idle_warm_container_never_reads_the_retry_record_and_a_cold_one_reads_it_once(world):
    """Zero extra reads in the steady state: a cold container looks once, learns the queue is empty and stops looking."""
    world.take_ops()
    world.run(START - timedelta(minutes=30))
    cold_ops = [op for op in world.take_ops() if op[:3] == ("get", live_reminder.SYSTEM_CLIENT_ID, reminder_retry.RETRY_KEY)]
    world.run(START - timedelta(minutes=29))
    warm_ops = [op for op in world.take_ops() if op[:3] == ("get", live_reminder.SYSTEM_CLIENT_ID, reminder_retry.RETRY_KEY)]

    assert len(cold_ops) == 1 and warm_ops == []


def test_a_lost_compare_and_set_is_re_read_and_re_applied(world, monkeypatch):
    """Another writer got in between: the commit re-reads the record and applies the same change on top of it."""
    world.config.pop(("c2", CREATOR_KEY))
    real = remote_config_store.put_remote_config_versioned
    lost = {"n": 0}

    def versioned(record, *, expected_version):
        """Lose the first write like a concurrent writer would."""
        if record["key"] == reminder_retry.RETRY_KEY and lost["n"] == 0:
            lost["n"] += 1
            return False
        return real(record, expected_version=expected_version)

    monkeypatch.setattr(remote_config_store, "put_remote_config_versioned", versioned)
    world.push_results = [TRANSIENT, TRANSIENT]

    world.run(START + RUN)

    assert lost["n"] == 1 and len(_queue(world)) == 1


def test_a_failing_retry_queue_never_fails_the_reminder_minute(world, monkeypatch):
    """The queue is a safety net: if it cannot be written the run still returns normally and the first send was already made."""
    def broken(record, *, expected_version):
        """The record cannot be written."""
        raise remote_config_store.RemoteConfigStoreError("down")

    monkeypatch.setattr(remote_config_store, "put_remote_config_versioned", broken)
    world.push_results = [OK, TRANSIENT, TRANSIENT]

    summary = world.run(START + RUN)

    assert summary["statusCode"] == 200 and _endpoints(world) == ["c1"]


def test_the_queue_is_bounded_and_drops_the_items_that_expire_first(world):
    """MAX_ITEMS items at most, so the one record can never approach DynamoDB's item limit."""
    now = START + RUN
    changes = {}
    for i in range(reminder_retry.MAX_ITEMS + 25):
        item = reminder_retry.RetryItem(f"c{i}", "v1", int(START.timestamp() * 1000), int(START.timestamp() * 1000), 0, int(now.timestamp() * 1000) + 30_000, int(now.timestamp() * 1000) + 60_000 + i, "x")
        changes[item.key] = item

    open_items = reminder_retry.commit(changes, now)

    assert len(open_items) == reminder_retry.MAX_ITEMS
    assert min(item.expires_at_ms for item in open_items.values()) > int(now.timestamp() * 1000) + 60_000 + 24


def test_backoff_and_expiry_arithmetic():
    """The pure rules: delays, the cap, the per-kind expiry, and the refusal to queue what could no longer be on time."""
    start = int(START.timestamp() * 1000)
    assert [reminder_retry.delay_after(n) for n in range(6)] == [30_000, 60_000, 120_000, 240_000, None, None]
    assert reminder_retry.expiry_ms(start, {"start"}) == start + 5 * 60_000
    assert reminder_retry.expiry_ms(start, {"advance"}) == start - 2 * 60_000
    assert reminder_retry.expiry_ms(start, {"advance", "start"}) == start + 5 * 60_000
    assert reminder_retry.first_item("c", "v", start, start, {"advance"}, start - 2 * 60_000 - 1000, "x") is None
    assert reminder_retry.first_item("c", "v", start, start, {"start"}, start + 4 * 60_000 + 40_000, "x") is None
    assert reminder_retry.first_item("c", "v", start, start, {"start"}, start + 5_000, "x") is not None


def test_a_run_that_has_nothing_to_do_never_strands_the_pending_reminders(world):
    """The regression the backoff test first exposed: a minute in which no item is due yet (and nothing changes) must leave the container knowing the queue is NOT empty,
    otherwise the next due retry would never be read and the reminder would be silently lost. With the real cadence the no-op minute is the one between the 2nd retry
    (due at +124.7 s) and the 3rd (due at +244.7 s): the run at +184.7 s has nothing due."""
    world.config.pop(("c2", CREATOR_KEY))
    world.push_results = [TRANSIENT] * 40

    world.run(START + RUN)  # fails, queued
    world.run(START + timedelta(minutes=1) + RUN)  # retry 1 fails
    world.run(START + timedelta(minutes=2) + RUN)  # retry 2 fails; the next retry is due at +244.7 s
    attempts_before = _attempts_to(world, "c1")

    noop = world.run(START + timedelta(minutes=3) + RUN)  # +184.7 s: nothing is due

    assert "retries" not in noop and _attempts_to(world, "c1") == attempts_before  # truly a no-op for the queue
    assert notification_dispatcher._retry_pending is True and len(_queue(world)) == 1  # ... and it still knows the item is waiting

    world.run(START + timedelta(minutes=4) + RUN)  # +244.7 s: the 3rd retry IS read and attempted
    assert _attempts_to(world, "c1") > attempts_before
