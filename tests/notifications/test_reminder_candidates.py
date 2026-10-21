"""The dispatcher no longer reads every registered client each minute: only the followers of streams whose reminder minute it is.

Pure selection (which streams / which settings can be due) and the end-to-end cost shape through the real dispatcher on an operation-counting
in-memory world. The behaviour of the reminders themselves (windows, mute, quiet hours, dedupe, catch-up) stays covered by the existing suites.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from notifications import live_reminder, reminder_candidates
from notifications.live_reminder import FirstSeen, LiveReminderSetting, StreamScheduleEntry
from tests.notifications.op_counting_harness import CountingHarness
from tests.notifications.test_notification_dispatcher import _creator
from tests.notifications.test_scheduled_start_notifications import AT_START, SNAPSHOT_AT, START, _stream

UTC = timezone.utc
WINDOW_MS = 60_000
START_MS = int(START.timestamp() * 1000)


def _entry(start_ms: int = START_MS, **overrides) -> StreamScheduleEntry:
    """A schedule entry (upcoming by default)."""
    fields = {"creator_id": "aizawa_ema", "scheduled_start_ms": start_ms, "status": "upcoming"}
    fields.update(overrides)
    return StreamScheduleEntry(**fields)


@pytest.fixture
def world(monkeypatch):
    """An operation-counting world whose shared snapshot lists one upcoming stream of aizawa_ema at START."""
    harness = CountingHarness(monkeypatch)
    harness.refresh_snapshot([_stream("v1")], SNAPSHOT_AT)
    return harness


# ============ due streams: pure, no I/O ============


@pytest.mark.parametrize("offset_minutes", [0, 1, 10, 30, 60])
def test_a_stream_is_due_in_the_on_time_minute_of_its_start_and_of_each_advance_offset(offset_minutes):
    """The five moments a reminder can fire: the start and 1 / 10 / 30 / 60 minutes before it."""
    entry = _entry()
    moment = START_MS - offset_minutes * 60_000

    due, _ = reminder_candidates.due_streams({"v1": entry}, now_ms=moment + 5_000, window_ms=WINDOW_MS, catch_up_enabled=lambda: False)

    assert list(due) == ["v1"]


@pytest.mark.parametrize("minutes_before", [2, 5, 20, 45, 90, 600])
def test_a_stream_is_not_due_in_any_other_minute(minutes_before):
    """An ordinary minute (no fire time) selects nothing, so such a run reads no client at all."""
    due, _ = reminder_candidates.due_streams(
        {"v1": _entry()}, now_ms=START_MS - minutes_before * 60_000, window_ms=WINDOW_MS, catch_up_enabled=lambda: False
    )

    assert due == {}


def test_a_stream_that_started_long_ago_is_never_due():
    """The window closes a minute after the fire time: no replay of anything older."""
    due, _ = reminder_candidates.due_streams({"v1": _entry()}, now_ms=START_MS + 2 * 60_000, window_ms=WINDOW_MS, catch_up_enabled=lambda: False)

    assert due == {}


def test_the_catch_up_switch_is_only_asked_for_a_stream_that_could_owe_a_catch_up():
    """A run with nothing late-discovered never reads the kill switch; a late-discovered stream asks once per stream and is selected only if ON."""
    asked: list[int] = []
    discovered_late = _entry(first_seen=FirstSeen(START_MS // 60_000, START - timedelta(minutes=20), ()))
    now_ms = START_MS - 15 * 60_000

    for switch, selected in ((False, False), (True, True)):
        asked.clear()
        due, catch_up_ids = reminder_candidates.due_streams(
            {"v1": discovered_late}, now_ms=now_ms, window_ms=WINDOW_MS, catch_up_enabled=lambda value=switch: (asked.append(1), value)[1]
        )
        assert (list(due) == ["v1"]) is selected and (catch_up_ids == {"v1"}) is selected
        assert asked == [1]

    asked.clear()
    reminder_candidates.due_streams({"v1": _entry()}, now_ms=now_ms, window_ms=WINDOW_MS, catch_up_enabled=lambda: (asked.append(1), True)[1])
    assert asked == []  # a stream known before its fire times never owes a catch-up: the switch is not consulted


# ============ the cost shape through the real dispatcher ============


def _register_fans(world: CountingHarness, creator_id: str, count: int, *, prefix: str, setting: dict = AT_START) -> None:
    """`count` subscribed clients with a creator 全部 reminder for `creator_id`."""
    for index in range(count):
        world.add_client(f"{prefix}{index}", creator_reminders={creator_id: setting})


def test_an_idle_minute_reads_no_client_at_all_however_many_are_registered(world):
    """The old dispatcher read every registered client's preference, subscription and reminders every minute."""
    _register_fans(world, "aizawa_ema", 400, prefix="a")
    world.run(START - timedelta(minutes=5))  # settles the schedule derivation; nothing is due at -5 minutes
    world.take_ops()

    summary = world.run(START - timedelta(minutes=4))

    ops = world.take_ops()
    assert summary == {"statusCode": 200, "checked": 0, "delivered": 0}
    assert not any(op[0] == "list_by_key" for op in ops)
    assert world.clients_touched(ops) == set()
    assert len(ops) <= 2  # the schedule record itself (a heartbeat-sized read happens outside the config table)


def test_a_due_minute_reads_only_the_followers_of_the_due_stream(world):
    """A start minute touches the due creator's own followers -- never the 400 fans of a creator whose stream is not due."""
    world.creators = [_creator(), _creator(creator_id="usada_pekora", display_name="兎田ぺこら", youtube_channel_id="UC_other")]
    _register_fans(world, "aizawa_ema", 30, prefix="ema")
    _register_fans(world, "usada_pekora", 400, prefix="pekora")
    world.run(START - timedelta(minutes=5))
    world.take_ops()

    summary = world.run(START + timedelta(seconds=10))

    ops = world.take_ops()
    touched = world.clients_touched(ops)
    assert summary["delivered"] == 30
    assert touched == {f"ema{index}" for index in range(30)}
    assert [op[1] for op in ops if op[0] == "list_by_key"] == [
        live_reminder.creator_reminder_key("aizawa_ema", "all"),
        live_reminder.stream_override_key("v1"),
    ]
    assert not any(op[0] == "list_prefix" for op in ops)  # the per-client reminder Queries are gone: the index items carry the settings


def test_only_a_client_whose_resolved_setting_is_due_in_this_minute_is_read(world):
    """At the start minute, a fan who only asked for the 30-minute advance reminder is not a candidate: her setting cannot be due now."""
    _register_fans(world, "aizawa_ema", 5, prefix="start")
    _register_fans(world, "aizawa_ema", 25, prefix="advance", setting={"notifyAtStart": False, "advanceReminder": "30min"})
    world.run(START - timedelta(minutes=5))
    world.take_ops()

    summary = world.run(START + timedelta(seconds=10))

    assert summary["delivered"] == 5
    assert world.clients_touched(world.take_ops()) == {f"start{index}" for index in range(5)}


def test_a_stream_override_that_switches_the_reminder_off_keeps_that_client_out(world):
    """Precedence is the existing one (override > creator 全部): the shadowed 全部 setting never makes this client a candidate."""
    _register_fans(world, "aizawa_ema", 3, prefix="fan")
    world.config[("fan0", live_reminder.stream_override_key("v1"))] = {"creatorId": "aizawa_ema", "notifyAtStart": False, "advanceReminder": None}
    world.run(START - timedelta(minutes=5))
    world.take_ops()

    summary = world.run(START + timedelta(seconds=10))

    assert summary["delivered"] == 2
    assert "fan0" not in world.clients_touched(world.take_ops())


def test_a_client_with_only_an_override_for_the_stream_is_found_through_the_override_key(world):
    """A one-off reminder on one stream (no creator-level setting) is discovered by the stream's own override key."""
    world.add_client("one_off", overrides={"v1": {"creatorId": "aizawa_ema", "notifyAtStart": True, "advanceReminder": None}})
    world.run(START - timedelta(minutes=5))

    assert world.run(START + timedelta(seconds=10))["delivered"] == 1


def test_a_reminder_added_edited_or_removed_takes_effect_with_no_derived_record_to_keep_in_sync(world):
    """Because candidates come straight from the reminder items, adding / editing / disabling / removing one is just that one item write."""
    world.add_client("c1")
    world.run(START - timedelta(minutes=5))
    world.config[("c1", live_reminder.creator_reminder_key("aizawa_ema", "all"))] = AT_START  # added
    world.config[("c1", live_reminder.creator_reminder_key("aizawa_ema", "all"))] = {"notifyAtStart": False, "advanceReminder": None}  # disabled
    assert world.run(START + timedelta(seconds=10))["delivered"] == 0

    world.pushes.clear()
    world.config[("c1", live_reminder.creator_reminder_key("aizawa_ema", "all"))] = AT_START  # edited back on
    assert world.run(START + timedelta(seconds=20))["delivered"] == 1
    del world.config[("c1", live_reminder.creator_reminder_key("aizawa_ema", "all"))]  # removed
    world.pushes.clear()
    world.delivery.clear()
    assert world.run(START + timedelta(seconds=30))["delivered"] == 0


def test_one_failing_client_does_not_stop_the_others_but_a_total_failure_still_raises(world, monkeypatch):
    """Per-client isolation, without hiding a systemic fault from the Lambda's error metric."""
    _register_fans(world, "aizawa_ema", 3, prefix="fan")
    world.run(START - timedelta(minutes=5))
    original = world._get_config

    def flaky(client_id, key):
        """One client's read fails."""
        if client_id == "fan1":
            raise RuntimeError("DynamoDB throttled")
        return original(client_id, key)

    monkeypatch.setattr("stores.remote_config_store.get_remote_config", flaky)
    assert world.run(START + timedelta(seconds=10))["delivered"] == 2

    def broken(client_id, key):
        """Every client read fails."""
        if client_id != "__system__":
            raise RuntimeError("DynamoDB down")
        return original(client_id, key)

    monkeypatch.setattr("stores.remote_config_store.get_remote_config", broken)
    world.delivery.clear()
    with pytest.raises(RuntimeError, match="DynamoDB down"):
        world.run(START + timedelta(seconds=20))


def test_an_older_overlapping_run_cannot_overwrite_a_newer_stored_schedule(world):
    """The schedule write is revision-guarded: a run that derived from an OLDER source loses and adopts what is stored."""
    newer_source = SNAPSHOT_AT + timedelta(minutes=10)
    world.config[("__system__", live_reminder.STREAM_SCHEDULE_KEY)] = {
        "entries": {"v_new": {"creatorId": "aizawa_ema", "scheduledStartMs": START_MS + 3_600_000, "status": "upcoming"}},
        "refreshedAt": SNAPSHOT_AT.isoformat(),
        "revision": int(newer_source.timestamp() * 1000),
    }

    world.run(START - timedelta(minutes=5))  # source SNAPSHOT_AT (older revision) wants to replace it

    stored = world.config[("__system__", live_reminder.STREAM_SCHEDULE_KEY)]
    assert list(stored["entries"]) == ["v_new"]
    assert stored["revision"] == int(newer_source.timestamp() * 1000)


def test_a_candidate_with_an_invalid_preference_or_no_subscription_is_skipped_and_the_rest_are_served(world):
    """The checks the old per-client loop made still hold for each candidate: bad stored preference -> skipped; no push subscription -> nothing to send."""
    _register_fans(world, "aizawa_ema", 4, prefix="fan")
    world.config[("fan0", "notificationPreference")] = {"enabled": "not-a-bool"}
    del world.config[("fan1", "pushSubscription")]
    del world.config[("fan2", "notificationPreference")]
    world.run(START - timedelta(minutes=5))

    summary = world.run(START + timedelta(seconds=10))

    assert summary["delivered"] == 1
    assert [push["endpoint"].rsplit("/", 1)[1] for push in world.pushes] == ["fan3"]


def test_a_reminder_item_whose_value_is_invalid_is_skipped_and_never_stops_the_others(world):
    """A corrupt stored reminder degrades only itself."""
    _register_fans(world, "aizawa_ema", 2, prefix="fan")
    world.config[("fan0", live_reminder.creator_reminder_key("aizawa_ema", "all"))] = {"notifyAtStart": "yes"}
    world.run(START - timedelta(minutes=5))

    assert world.run(START + timedelta(seconds=10))["delivered"] == 1
