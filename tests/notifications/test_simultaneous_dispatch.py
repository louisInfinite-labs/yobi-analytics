"""同時開播預告 end to end through the real dispatcher on an in-memory world, with every storage operation counted.

The notice is CHANGE-TRIGGERED: it follows the ~10-minute schedule derivation (a new snapshot makes the dispatcher re-derive its "streamSchedule"; nothing
here adds a poll or a refresh), compares the collisions of the previous and the new schedule, and notifies the clients a NEW collision is newly relevant
to. There is no lead time and no minimum remaining time; the only limit is the scheduled start itself. The first-ever schedule is a baseline (nothing that
already existed is announced), so every test starts from a baseline in which only creator A's stream is known.

Creators: A = aizawa_ema (video vA), B = kamito (vB), C = third (vC); the shared start is START (21:15 JST).
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from api import read_api
from api.holodex_client import HolodexAPIError
from notifications import live_reminder, push_sender, simultaneous_dispatcher
from notifications import simultaneous_live as sim
from notifications.push_sender import PushResult
from tests.notifications.op_counting_harness import CountingHarness
from tests.notifications.test_notification_dispatcher import _creator, _preference_value
from tests.notifications.test_scheduled_start_notifications import AT_START, SNAPSHOT_AT, START, _stream

A, B, C = "aizawa_ema", "kamito", "third"
BASELINE = START - timedelta(hours=10)
START_MS = int(START.timestamp() * 1000)
SYSTEM = live_reminder.SYSTEM_CLIENT_ID


def vA(start: datetime = START) -> dict:
    """Creator A's upcoming stream."""
    return _stream("vA", start=start, creator=A, title="Ranked grind")


def vB(start: datetime = START) -> dict:
    """Creator B's upcoming stream."""
    return _stream("vB", start=start, creator=B, title="Cozy chat")


def vC(start: datetime = START) -> dict:
    """Creator C's upcoming stream."""
    return _stream("vC", start=start, creator=C, title="Karaoke")


@pytest.fixture(autouse=True)
def no_retry_pause(monkeypatch):
    """The immediate re-send after a transient failure must not sleep in tests."""
    monkeypatch.setattr(push_sender, "_RETRY_PAUSE_SECONDS", 0)


@pytest.fixture
def world(monkeypatch):
    """Three creators; the schedule has been derived once (the baseline) knowing only A's stream; nobody is subscribed yet."""
    harness = CountingHarness(monkeypatch)
    harness.creators = [
        _creator(),
        _creator(creator_id=B, display_name="神成きゅぴ", youtube_channel_id="UC_b"),
        _creator(creator_id=C, display_name="三人目", youtube_channel_id="UC_c"),
    ]
    harness.refresh_snapshot([vA()], SNAPSHOT_AT)
    harness.run(BASELINE)
    harness.take_ops()
    return harness


def follower(world, client_id: str, *, creators=(A, B), opted_in: bool = True, preference=None, setting=AT_START) -> None:
    """A subscribed client with a creator 全部 reminder for each of `creators`; opted in to the notice only when asked (it is OFF by default)."""
    world.add_client(client_id, preference=preference, creator_reminders={creator: setting for creator in creators})
    if opted_in:
        world.config[(client_id, sim.OPT_IN_KEY)] = {"enabled": True}


def show(world, streams: list[dict], now: datetime, context=None) -> dict:
    """A NEWER shared snapshot lists `streams` (the ~10-minute refresh ran) and the dispatcher runs at `now`."""
    world.refresh_snapshot(streams, world.snapshot_at + timedelta(minutes=10))
    return world.run(now, context)


def notices(world) -> list[dict]:
    """Every simultaneous-livestream push that actually went out."""
    return [push for push in world.pushes if push["sent"] and push["data"].get("simultaneous")]


def who(pushes: list[dict]) -> list[str]:
    """The clients a list of pushes went to, sorted."""
    return sorted(push["endpoint"].rsplit("/", 1)[1] for push in pushes)


def ledger_keys(world) -> list[str]:
    """The ledger records currently stored."""
    return sorted(key for (client, key) in world.config if client == SYSTEM and key.startswith(sim.LEDGER_KEY_PREFIX))


def pending(world) -> list[str]:
    """The pending notice ids listed in the stored schedule record."""
    return world.config[(SYSTEM, live_reminder.STREAM_SCHEDULE_KEY)].get("pendingNotices", [])


def feature_ops(ops: list[tuple]) -> list[tuple]:
    """The storage operations that belong to this feature: ledgers, the opt-in index, follower lookups, and the notice rows of the delivery log."""
    return [
        op
        for op in ops
        if sim.LEDGER_KEY_PREFIX in str(op)
        or sim.OPT_IN_KEY in str(op)
        or (op[0] == "list_by_key" and str(op[1]).startswith(("creatorReminder#", "streamOverride#")))
        or op[0] == "list_prefix"
        or (op[0] in ("delivery_read", "delivery_write") and str(op[2]).startswith(sim.NOTICE_KEY_PREFIX))
    ]


# ============ the agreed example: A, then A+B, then A+B+C ============


def test_a_then_a_plus_b_then_a_plus_b_plus_c_notifies_each_user_only_when_something_new_is_relevant_to_them(world):
    """12:00 A is known -> nothing. 14:00 B discovered -> users following A+B. 17:00 C discovered -> users following A+B+C get the expanded notice, users
    following A+C or B+C become eligible, and users following only A+B are NOT told the identical A+B again. An unchanged refresh sends nothing."""
    follower(world, "ab", creators=(A, B))
    follower(world, "abc", creators=(A, B, C))
    follower(world, "ac", creators=(A, C))
    follower(world, "bc", creators=(B, C))
    follower(world, "a_only", creators=(A,))

    assert show(world, [vA()], START - timedelta(hours=9)).get("simultaneous") is None  # 12:00: A alone
    assert notices(world) == []

    show(world, [vA(), vB()], START - timedelta(hours=7))  # 14:00: B discovered
    first = notices(world)
    assert who(first) == ["ab", "abc"]
    assert all(sorted(push["data"]["videoIds"]) == ["vA", "vB"] for push in first)
    assert all("藍沢エマ" in push["title"] and "神成きゅぴ" in push["title"] for push in first)

    show(world, [vA(), vB(), vC()], START - timedelta(hours=4))  # 17:00: C discovered
    second = notices(world)[len(first):]
    assert who(second) == ["abc", "ac", "bc"]  # ab is not told A+B again; ac and bc are newly eligible
    by_client = {push["endpoint"].rsplit("/", 1)[1]: sorted(push["data"]["videoIds"]) for push in second}
    assert by_client == {"abc": ["vA", "vB", "vC"], "ac": ["vA", "vC"], "bc": ["vB", "vC"]}
    assert who(notices(world)).count("ab") == 1 and who(notices(world)).count("abc") == 2 and "a_only" not in who(notices(world))

    world.take_ops()
    sent = len(notices(world))
    show(world, [vA(), vB(), vC()], START - timedelta(hours=3, minutes=50))  # the next ~10-minute refresh: nothing changed
    assert len(notices(world)) == sent
    assert feature_ops(world.take_ops()) == []


# ============ default OFF, creators with live notifications enabled ============


def test_the_feature_is_off_for_everyone_until_they_explicitly_opt_in(world):
    """Following both creators with live reminders is not enough: no opt-in item, no notice -- and nobody is looked up beyond the opt-in index."""
    for index in range(30):
        follower(world, f"fan{index:02d}", opted_in=False)
    world.take_ops()

    show(world, [vA(), vB()], START - timedelta(hours=2))

    assert notices(world) == []
    lookups = [op for op in world.take_ops() if op[0] == "list_by_key" and (op[1] == sim.OPT_IN_KEY or str(op[1]).startswith("creatorReminder#"))]
    assert lookups == [("list_by_key", sim.OPT_IN_KEY)]  # the sparse opt-in index is empty, so no follower Query is made


def test_opting_in_afterwards_does_not_replay_a_collision_that_was_already_announced(world):
    """Turning the switch on later never replays history: the notice is about a CHANGE, and that change has passed."""
    follower(world, "late", opted_in=False)
    show(world, [vA(), vB()], START - timedelta(hours=2))
    world.config[("late", sim.OPT_IN_KEY)] = {"enabled": True}

    show(world, [vA(), vB()], START - timedelta(hours=1))  # an unchanged refresh

    assert notices(world) == []


def test_only_creators_the_client_has_live_notifications_enabled_for_count_and_at_least_two_are_needed(world):
    """One followed creator, or a creator whose reminder is switched off, or a per-stream override that is off, leaves nothing simultaneous."""
    follower(world, "ok")
    follower(world, "only_a", creators=(A,))
    follower(world, "b_off")
    world.config[("b_off", live_reminder.creator_reminder_key(B, "all"))] = {"notifyAtStart": False, "advanceReminder": None}
    follower(world, "override_off")
    world.config[("override_off", live_reminder.stream_override_key("vB"))] = {"creatorId": B, "notifyAtStart": False, "advanceReminder": None}
    follower(world, "creator_disabled", preference=_preference_value(creatorOverride={B: False}))
    follower(world, "master_off", preference=_preference_value(enabled=False))

    show(world, [vA(), vB()], START - timedelta(hours=2))

    assert who(notices(world)) == ["ok"]


# ============ late discovery: no lead time, no minimum remaining time ============


@pytest.mark.parametrize(
    "before_start",
    [timedelta(days=1), timedelta(hours=6), timedelta(minutes=10), timedelta(minutes=5), timedelta(minutes=1), timedelta(seconds=10)],
)
def test_a_collision_is_notified_however_early_or_late_it_is_discovered_as_long_as_the_start_has_not_passed(world, before_start):
    """Discovered a day ahead, or at 20:55 for 21:00, or ten seconds before: all eligible. There is no window."""
    follower(world, "c1")

    show(world, [vA(), vB()], START - before_start)

    assert who(notices(world)) == ["c1"]


@pytest.mark.parametrize("after_start", [timedelta(seconds=0), timedelta(seconds=1), timedelta(minutes=3)])
def test_a_warning_is_never_sent_once_the_scheduled_start_has_passed(world, after_start):
    """A collision that only becomes known at or after its start is not announced (and costs no lookup)."""
    follower(world, "c1")
    world.take_ops()

    show(world, [vA(), vB()], START + after_start)

    assert notices(world) == []
    assert not [op for op in world.take_ops() if op[0] == "list_by_key" and op[1] == sim.OPT_IN_KEY]


def test_a_retry_that_falls_due_after_the_start_is_dropped_not_sent(world):
    """A failed first push is retried a minute later -- unless that is after the start: then the notice is simply over."""
    follower(world, "c1")
    world.push_results = [PushResult(sent=False, subscription_expired=False, error="down")]
    show(world, [vA(), vB()], START - timedelta(seconds=30))

    world.run(START + timedelta(seconds=40))  # the retry (due 30 s after the start); the ordinary start reminders go out, the notice does not

    simultaneous = [push for push in world.pushes if push["data"].get("simultaneous")]
    assert notices(world) == [] and len(simultaneous) == 1  # only the first (failed) attempt


# ============ per-user deduplication ============


def test_a_client_following_only_a_and_b_is_not_told_the_identical_group_again_when_c_joins(world):
    """The key is the client's OWN relevant creators/videos plus the exact start, not the global group: A+B stays A+B for this client."""
    follower(world, "ab", creators=(A, B))
    show(world, [vA(), vB()], START - timedelta(hours=5))
    assert who(notices(world)) == ["ab"]

    show(world, [vA(), vB(), vC()], START - timedelta(hours=4))

    assert who(notices(world)) == ["ab"]


def test_the_same_creators_at_a_different_start_are_a_new_notice(world):
    """Rescheduled together to another start: the key contains the exact start, so it is a different notice."""
    follower(world, "ab")
    show(world, [vA(), vB()], START - timedelta(hours=5))

    later = START + timedelta(hours=1)
    show(world, [vA(later), vB(later)], START - timedelta(hours=4))

    assert [push["data"]["startMs"] for push in notices(world)] == [START_MS, int(later.timestamp() * 1000)]


def test_two_different_collisions_do_not_suppress_each_other(world):
    """Another pair at another start is its own notice for the same client."""
    follower(world, "c1", creators=(A, B, C, "fourth"))
    later = START + timedelta(hours=1)
    show(world, [vA(), vB()], START - timedelta(hours=5))

    show(world, [vA(), vB(), vC(later), _stream("v4", start=later, creator="fourth", title="Fourth")], START - timedelta(hours=4))

    assert sorted(tuple(sorted(push["data"]["videoIds"])) for push in notices(world)) == [("v4", "vC"), ("vA", "vB")]


def test_the_notice_is_in_the_clients_own_language_and_local_time(world):
    """The preference's locale and time zone shape the text like every other notification."""
    follower(world, "c_ja", preference=_preference_value(notificationLocale="ja"))
    follower(world, "c_en")

    show(world, [vA(), vB()], START - timedelta(hours=2))

    pushes = {push["endpoint"].rsplit("/", 1)[1]: push for push in notices(world)}
    assert pushes["c_ja"]["title"].endswith("の配信開始予定が重なっています")
    assert pushes["c_en"]["title"].endswith("are scheduled to go live at the same time")
    assert pushes["c_en"]["body"] == "21:15  Ranked grind / Cozy chat" and pushes["c_en"]["data"]["url"] == "/schedule"


# ============ identical snapshots cost nothing ============


def test_an_unchanged_refresh_performs_no_storage_work_for_this_feature_at_all(world):
    """Many refreshes in a row with the same collision: no opt-in lookup, no follower Query, no ledger access, no delivery-log row, no delete."""
    follower(world, "c1")
    show(world, [vA(), vB()], START - timedelta(hours=5))
    show(world, [vA(), vB()], START - timedelta(hours=5) + timedelta(minutes=10))  # a later refresh settles the stored pending list
    world.take_ops()

    for minute in range(1, 7):
        show(world, [vA(), vB()], START - timedelta(hours=4) + timedelta(minutes=10 * minute))
        world.run(START - timedelta(hours=4) + timedelta(minutes=10 * minute + 1))  # and plain minutes in between

    assert feature_ops(world.take_ops()) == []
    assert len(notices(world)) == 1


def test_a_schedule_with_no_collision_costs_nothing_whatever_the_number_of_subscribers(world):
    """No collision, nothing to look up: 200 opted-in subscribers are never read."""
    for index in range(200):
        follower(world, f"fan{index:03d}")
    world.take_ops()

    show(world, [vA(), _stream("vB", start=START + timedelta(minutes=1), creator=B)], START - timedelta(hours=2))

    assert feature_ops(world.take_ops()) == []


# ============ cancellations ============


def test_a_cancelled_member_before_its_notice_could_be_sent_is_never_announced(world):
    """The collision exists only briefly: if B is gone again at the next refresh, a notice that failed and is pending is deleted and never retried."""
    follower(world, "c1")
    world.push_results = [PushResult(sent=False, subscription_expired=False, error="down")]
    base = START - timedelta(hours=2)
    show(world, [vA(), vB()], base)
    assert ledger_keys(world) and pending(world)

    show(world, [vA()], base + timedelta(seconds=30))  # B cancelled
    world.run(base + timedelta(minutes=2))
    world.run(base + timedelta(minutes=10))

    assert ledger_keys(world) == [] and pending(world) == [] and notices(world) == []


def test_a_member_cancelled_after_the_notice_was_delivered_leaves_nothing_behind_and_a_return_does_not_repeat_it(world):
    """B drops out and comes back (a Holodex dropout): the ledger is deleted and recreated, but the client's delivery-log row stops a second notice."""
    follower(world, "c1")
    show(world, [vA(), vB()], START - timedelta(hours=5))
    assert len(notices(world)) == 1

    show(world, [vA()], START - timedelta(hours=4))
    assert ledger_keys(world) == []
    show(world, [vA(), vB()], START - timedelta(hours=3))

    assert len(notices(world)) == 1


def test_when_the_streams_go_live_the_collision_and_its_ledger_disappear_and_nothing_more_is_read(world):
    """After the start the streams are live: the collision is gone, its ledger deleted, and later minutes do nothing."""
    follower(world, "c1")
    show(world, [vA(), vB()], START - timedelta(hours=5))
    live = [_stream("vA", status="live", creator=A, actual=START), _stream("vB", status="live", creator=B, actual=START)]
    show(world, live, START + timedelta(minutes=1))
    world.take_ops()

    world.run(START + timedelta(minutes=2))

    assert ledger_keys(world) == [] and len(notices(world)) == 1 and feature_ops(world.take_ops()) == []


# ============ rescheduling ============


def test_b_rescheduled_away_from_a_means_no_collision_and_no_notice(world):
    """B moves one hour later: A and B no longer start together, so there is nothing to say."""
    follower(world, "c1")

    show(world, [vA(), vB(START + timedelta(hours=1))], START - timedelta(hours=2))

    assert notices(world) == []


def test_b_rescheduled_onto_a_notifies_when_the_schedule_change_is_discovered(world):
    """B first starts an hour after A, then moves onto A's start: that change creates the collision and is announced once."""
    follower(world, "c1")
    show(world, [vA(), vB(START + timedelta(hours=1))], START - timedelta(hours=5))
    assert notices(world) == []

    show(world, [vA(), vB()], START - timedelta(hours=4))

    assert who(notices(world)) == ["c1"] and notices(world)[0]["data"]["startMs"] == START_MS


def test_a_pending_notice_whose_collision_is_rescheduled_is_replaced_by_the_new_one(world):
    """The first push failed; both streams then move an hour later. The old pending notice dies with its collision; the new one is judged on its own."""
    follower(world, "c1")
    world.push_results = [PushResult(sent=False, subscription_expired=False, error="down")]
    base = START - timedelta(hours=3)
    show(world, [vA(), vB()], base)
    old_ledgers = ledger_keys(world)
    later = START + timedelta(hours=1)

    show(world, [vA(later), vB(later)], base + timedelta(minutes=20))

    assert not set(old_ledgers) & set(ledger_keys(world))
    assert len(notices(world)) == 1 and notices(world)[0]["data"]["startMs"] == int(later.timestamp() * 1000)


# ============ refresh failure ============


def test_a_failed_refresh_invents_nothing_keeps_the_pending_notice_and_a_later_success_continues(world, monkeypatch):
    """A Holodex / snapshot failure reuses the stored schedule and its pending list untouched; the pending retry still goes out; a later refresh works."""
    follower(world, "c1")
    world.push_results = [PushResult(sent=False, subscription_expired=False, error="down")]
    base = START - timedelta(hours=2)
    show(world, [vA(), vB()], base)
    stored = dict(world.config[(SYSTEM, live_reminder.STREAM_SCHEDULE_KEY)])
    assert pending(world)

    def failing(*_a, **_kw):
        """The live read fails."""
        raise HolodexAPIError("Holodex timed out")

    monkeypatch.setattr(read_api, "get_live_streams", failing)
    world.snapshot_at += timedelta(minutes=10)  # a newer source: a derivation is attempted and fails
    world.run(base + timedelta(minutes=2))  # the retry is due

    assert world.config[(SYSTEM, live_reminder.STREAM_SCHEDULE_KEY)] == stored  # nothing rewritten
    assert len(notices(world)) == 1  # delivered by the retry

    monkeypatch.setattr(read_api, "get_live_streams", lambda *_a, **_kw: {"streams": [vA(), vB(), vC()]})
    world.snapshot_at += timedelta(minutes=10)
    follower(world, "abc", creators=(A, B, C))
    world.run(START - timedelta(hours=1))
    assert who(notices(world)) == ["abc", "c1"]


def test_a_crash_between_creating_the_ledger_and_writing_the_schedule_loses_nothing(world, monkeypatch):
    """The ledger is created BEFORE the new schedule is written: if the process dies in between, the next derivation sees the same difference, finds
    the ledger already there, and the notice is still delivered exactly once."""
    follower(world, "c1")
    real = world._put_config_if_newer
    calls: list[int] = []

    def die_once(record, *, revision):
        """The schedule write fails the first time (the process died)."""
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("process died before the schedule was written")
        return real(record, revision=revision)

    monkeypatch.setattr("stores.remote_config_store.put_remote_config_if_newer", die_once)
    world.refresh_snapshot([vA(), vB()], world.snapshot_at + timedelta(minutes=10))
    base = START - timedelta(hours=2)
    with pytest.raises(RuntimeError, match="process died"):
        world.run(base)
    assert ledger_keys(world) and notices(world) == []

    world.run(base + timedelta(minutes=1))  # the next run derives again

    assert who(notices(world)) == ["c1"]
    assert len(ledger_keys(world)) == 1


# ============ concurrency ============


def test_two_overlapping_dispatcher_runs_notify_exactly_once(world, monkeypatch):
    """While the first run is inside its send, a second run starts on the same collision: it finds the lease held and skips; one push in total."""
    follower(world, "c1")
    inner: list[dict] = []
    original = world._send_push
    base = START - timedelta(hours=2)

    def push_then_overlap(subscription, **kwargs):
        """While the first run is sending, a second invocation starts."""
        if not inner:
            inner.append(world.run(base + timedelta(seconds=5)))
        return original(subscription, **kwargs)

    monkeypatch.setattr(push_sender, "send_push_notification", push_then_overlap)

    show(world, [vA(), vB()], base)

    assert len(notices(world)) == 1
    assert "simultaneous" not in inner[0] or inner[0]["simultaneous"]["delivered"] == 0


def test_two_runs_that_both_derive_the_same_new_collision_still_notify_once(world, monkeypatch):
    """Both runs see the same change (one loses the revision-guarded schedule write): the ledger is created once and each client is notified once."""
    follower(world, "c1")
    follower(world, "c2")
    real = world._put_config_if_newer
    first: list[int] = []

    def lose_the_race(record, *, revision):
        """The first derivation loses the conditional write to an identical record another run stored."""
        if not first:
            first.append(1)
            world._put_config(record)
            return False
        return real(record, revision=revision)

    monkeypatch.setattr("stores.remote_config_store.put_remote_config_if_newer", lose_the_race)
    base = START - timedelta(hours=2)

    show(world, [vA(), vB()], base)
    world.run(base + timedelta(minutes=1))
    show(world, [vA(), vB()], base + timedelta(minutes=12))

    assert who(notices(world)) == ["c1", "c2"] and len(ledger_keys(world)) == 1


def test_a_lost_compare_and_set_means_the_other_pass_owns_the_collision(world, monkeypatch):
    """If another pass wins the lease write, this one does nothing for that collision."""
    follower(world, "c1")
    monkeypatch.setattr("stores.remote_config_store.put_remote_config_versioned", lambda record, *, expected_version: False)

    summary = show(world, [vA(), vB()], START - timedelta(hours=2))

    assert "simultaneous" not in summary and world.pushes == []


def test_a_crash_in_the_middle_of_a_pass_loses_only_its_progress_and_nobody_is_notified_twice(world, monkeypatch):
    """The process dies while sending to the second client: after the lease expires the next pass starts again, the delivery log skips the client
    already served, the dead pass's live claim is waited for until it expires, and the second client is delivered -- never lost, never twice."""
    follower(world, "c1")
    follower(world, "c2")
    original = world._send_push
    crashed: list[int] = []
    base = START - timedelta(hours=2)

    def dying_on_the_second(subscription, **kwargs):
        """The process dies while sending to the second client."""
        if len(world.pushes) == 1 and not crashed:
            crashed.append(1)
            raise KeyboardInterrupt  # not an Exception: nothing in the dispatcher may swallow a real crash
        return original(subscription, **kwargs)

    monkeypatch.setattr(push_sender, "send_push_notification", dying_on_the_second)
    with pytest.raises(KeyboardInterrupt):
        show(world, [vA(), vB()], base)
    assert len(notices(world)) == 1
    simultaneous_dispatcher.reset_cache()  # a fresh container

    world.run(base + timedelta(seconds=30))  # the dead pass's lease (120 s) is still held
    assert len(notices(world)) == 1
    world.run(base + timedelta(seconds=150))  # lease expired; the dead pass's CLAIM on c2 is still live: waited for
    assert len(notices(world)) == 1
    world.run(base + timedelta(minutes=21))  # the claim expired (20 minutes)

    assert who(notices(world)) == ["c1", "c2"]


def test_a_lost_closing_write_is_repaired_by_the_next_pass_without_notifying_anyone_twice(world, monkeypatch):
    """The progress write after the sends is lost: after the lease expires everything is re-derived and the delivery log stops every repeat."""
    follower(world, "c1")
    follower(world, "c2")
    real = world._put_config_versioned
    writes: list[int] = []

    def lose_the_closing_write(record, *, expected_version):
        """The third ledger write (creation, lease, closing) never lands."""
        if str(record["key"]).startswith(sim.LEDGER_KEY_PREFIX):
            writes.append(1)
            if len(writes) == 3:
                raise RuntimeError("process died")
        return real(record, expected_version=expected_version)

    monkeypatch.setattr("stores.remote_config_store.put_remote_config_versioned", lose_the_closing_write)
    base = START - timedelta(hours=2)
    show(world, [vA(), vB()], base)
    assert len(notices(world)) == 2
    monkeypatch.setattr("stores.remote_config_store.put_remote_config_versioned", real)
    simultaneous_dispatcher.reset_cache()

    world.run(base + timedelta(seconds=150))  # lease expired: the pass is redone, nothing is sent again

    assert len(notices(world)) == 2
    assert world.config[(SYSTEM, ledger_keys(world)[0])]["state"] == sim.STATE_SETTLED


# ============ the pending list rides in the schedule record ============


def test_the_collision_is_listed_as_pending_with_the_schedule_and_the_list_is_cleaned_by_the_next_derivation(world):
    """Pending ids live in the record the dispatcher reads every minute anyway; once settled they are dropped by the next derivation."""
    follower(world, "c1")

    show(world, [vA(), vB()], START - timedelta(hours=2))
    assert len(pending(world)) == 1 and len(notices(world)) == 1  # written with the schedule, delivered in the same run

    show(world, [vA(), vB()], START - timedelta(hours=1))
    assert pending(world) == []


def test_a_cold_container_reads_one_stale_pending_ledger_once_and_then_nothing(world):
    """A container that remembers nothing finds the (already settled) id in the record, reads that one ledger, and never again."""
    follower(world, "c1")
    base = START - timedelta(hours=2)
    show(world, [vA(), vB()], base)
    simultaneous_dispatcher.reset_cache()  # a fresh container
    world.pushes.clear()
    world.take_ops()

    world.run(base + timedelta(minutes=1))
    first = feature_ops(world.take_ops())
    world.run(base + timedelta(minutes=2))
    second = feature_ops(world.take_ops())

    assert [op for op in first if op[0] == "get"] and world.pushes == [] and second == []


def test_with_nothing_pending_even_a_cold_container_reads_nothing_for_this_feature(world):
    """No pending notice in the record: no ledger, no opt-in, no lookup, whatever the container remembers."""
    follower(world, "c1")
    base = START - timedelta(hours=2)
    show(world, [vA()], base)
    simultaneous_dispatcher.reset_cache()
    world.take_ops()

    world.run(base + timedelta(minutes=1))

    assert feature_ops(world.take_ops()) == []


# ============ delivery, retries, expiry ============


def test_a_failed_push_releases_the_claim_and_is_retried_a_minute_later(world):
    """Claim -> failed push -> claim released and the notice kept as open work; the retry delivers once."""
    follower(world, "c1")
    world.push_results = [PushResult(sent=False, subscription_expired=False, error="push service hiccup")]
    base = START - timedelta(hours=2)

    first = show(world, [vA(), vB()], base)["simultaneous"]
    assert first["delivered"] == 0 and first["pending"] == 1 and notices(world) == []
    assert not any(key.startswith(sim.NOTICE_KEY_PREFIX) for (_, key) in world.delivery)  # the claim was given back

    world.run(base + timedelta(seconds=30))  # not yet due: nothing happens
    assert notices(world) == []
    second = world.run(base + timedelta(seconds=61))["simultaneous"]

    assert second["delivered"] == 1 and len(notices(world)) == 1
    assert world.config[(SYSTEM, ledger_keys(world)[0])]["state"] == sim.STATE_SETTLED


def test_retries_are_bounded_and_the_notice_is_then_given_up(world):
    """Three failed attempts in total, then it is dropped for good -- no fourth push is ever attempted."""
    follower(world, "c1")
    world.push_results = [PushResult(sent=False, subscription_expired=False, error="down")] * 10
    base = START - timedelta(hours=2)
    show(world, [vA(), vB()], base)

    for seconds in (61, 61 + 181, 61 + 181 + 600):
        world.run(base + timedelta(seconds=seconds))

    assert len(world.pushes) == sim.MAX_ATTEMPTS and notices(world) == []
    ledger = world.config[(SYSTEM, ledger_keys(world)[0])]
    assert ledger["state"] == sim.STATE_SETTLED and ledger["gaveUp"] == 1 and ledger["work"] == {}


def test_a_transient_failure_gets_one_immediate_retry_inside_the_same_pass(world):
    """A transport error / 5xx is re-sent once straight away; no ledger retry is needed when that works."""
    follower(world, "c1")
    world.push_results = [PushResult(sent=False, subscription_expired=False, error="connection reset", retryable=True)]

    summary = show(world, [vA(), vB()], START - timedelta(hours=2))["simultaneous"]

    assert summary["delivered"] == 1 and summary["pending"] == 0 and len(world.pushes) == 2


def test_a_non_retryable_failure_is_not_resent_immediately(world):
    """A permanent-looking failure goes to the delayed retry, not a tight loop."""
    follower(world, "c1")
    world.push_results = [PushResult(sent=False, subscription_expired=False, error="bad request", retryable=False)]

    show(world, [vA(), vB()], START - timedelta(hours=2))

    assert len(world.pushes) == 1


def test_an_expired_subscription_is_dropped_not_retried(world):
    """404 / 410: the claim is released and the client is not retried."""
    follower(world, "c1")
    world.push_results = [PushResult(sent=False, subscription_expired=True, error="gone")]
    base = START - timedelta(hours=2)

    summary = show(world, [vA(), vB()], base)["simultaneous"]
    world.run(base + timedelta(minutes=2))

    assert summary["dropped"] == 1 and len(world.pushes) == 1


def test_a_claim_held_by_another_worker_is_waited_for_not_assumed_delivered(world):
    """A live claim (a worker that may still be sending) is looked at again later; it is neither skipped as delivered nor sent over."""
    follower(world, "c1")
    now = START - timedelta(hours=2)
    key = sim.notice_key(START_MS // 1000, ("vA", "vB"))
    world.delivery[("c1", key)] = {"status": "claimed", "at": now.isoformat()}

    show(world, [vA(), vB()], now)
    assert world.pushes == []
    world.delivery[("c1", key)] = {"status": "claimed", "at": (now - timedelta(minutes=30)).isoformat()}  # that worker is gone: the claim expired
    world.run(now + timedelta(seconds=61))

    assert len(notices(world)) == 1


def test_a_client_already_delivered_this_notice_is_not_notified_again_even_with_a_fresh_ledger(world):
    """The delivery log is the idempotency authority: a recreated ledger (a dropout of the stream, a new container) never re-sends."""
    follower(world, "c1")
    now = START - timedelta(hours=2)
    world.delivery[("c1", sim.notice_key(START_MS // 1000, ("vA", "vB")))] = {"status": "delivered", "at": now.isoformat()}

    summary = show(world, [vA(), vB()], now)["simultaneous"]

    assert world.pushes == [] and summary["dropped"] == 1


# ============ the client's choices are re-read right before sending ============


def test_an_opt_out_between_finding_the_recipients_and_sending_is_respected(world, monkeypatch):
    """c2 opts out while c1's push is in flight: c2's opt-in is re-read right before its send, so it is dropped, not notified."""
    follower(world, "c1")
    follower(world, "c2")
    original = world._send_push

    def opt_out_during_first_send(subscription, **kwargs):
        """c2 opts out while the first client's push is in flight."""
        world.config.pop(("c2", sim.OPT_IN_KEY), None)
        return original(subscription, **kwargs)

    monkeypatch.setattr(push_sender, "send_push_notification", opt_out_during_first_send)

    summary = show(world, [vA(), vB()], START - timedelta(hours=2))["simultaneous"]

    assert who(notices(world)) == ["c1"] and summary["dropped"] == 1


def test_turning_notifications_off_or_losing_the_subscription_before_the_send_drops_the_notice(world):
    """The preference and the push subscription are read fresh: master OFF or no subscription means no push."""
    follower(world, "c1")
    follower(world, "turned_off", preference=_preference_value(enabled=False))
    follower(world, "unsubscribed")
    del world.config[("unsubscribed", "pushSubscription")]

    summary = show(world, [vA(), vB()], START - timedelta(hours=2))["simultaneous"]

    assert who(notices(world)) == ["c1"] and summary["dropped"] == 2


def test_a_muted_client_is_looked_at_again_exactly_when_the_mute_ends_not_polled(world):
    """A temporary mute defers the notice to the instant it ends (never every minute); once it ends before the start the notice goes out."""
    now = START - timedelta(hours=2)
    mute_until = now + timedelta(minutes=25)
    follower(world, "c1")
    follower(world, "muted", preference=_preference_value(temporaryMute=mute_until.isoformat()))

    first = show(world, [vA(), vB()], now)["simultaneous"]
    assert who(notices(world)) == ["c1"] and first["pending"] == 1
    world.take_ops()

    for minute in range(1, 25):  # nothing at all is read for the muted client while the mute lasts
        world.run(now + timedelta(minutes=minute))
    assert not any(op[0] in ("get", "list_prefix", "delivery_read") and op[1] == "muted" for op in world.take_ops())

    world.run(now + timedelta(minutes=26))  # the mute has ended

    assert who(notices(world)) == ["c1", "muted"]


def test_quiet_hours_defer_to_their_end_and_a_start_that_comes_first_drops_the_notice(world):
    """Quiet hours that end before the start: delivered when they end. Quiet hours that outlast the start: never sent, never after the start."""
    now = START - timedelta(hours=2)  # 19:15 JST
    follower(world, "ends_in_time", preference=_preference_value(quietHours=["19:00", "20:00"]))  # over at 20:00 JST, the start is 21:15 JST
    follower(world, "outlasts_the_start", preference=_preference_value(quietHours=["19:00", "23:30"]))

    show(world, [vA(), vB()], now)
    assert notices(world) == []
    world.run(now + timedelta(minutes=44))
    assert notices(world) == []
    world.run(now + timedelta(minutes=46))  # 20:01 JST

    assert who(notices(world)) == ["ends_in_time"]
    world.run(START + timedelta(minutes=1))
    assert who(notices(world)) == ["ends_in_time"]


# ============ realistic shape ============


def test_a_real_schedule_shape_four_creators_at_once_tells_a_client_only_about_the_ones_it_follows(world):
    """The live production schedule has groups of 4-5 creators on the same :00 start. A client following two of four is told about exactly those two."""
    world.creators = [*world.creators, _creator(creator_id="fourth", display_name="四人目")]
    follower(world, "picky", creators=(B, "fourth"))
    show(world, [vA(), vB()], START - timedelta(hours=6))
    assert notices(world) == []  # B joins A, but picky follows B and not A

    show(world, [vA(), vB(), vC(), _stream("v4", creator="fourth", title="Fourth")], START - timedelta(hours=4))

    [push] = notices(world)
    assert sorted(push["data"]["videoIds"]) == ["v4", "vB"]
    assert "神成きゅぴ" in push["title"] and "四人目" in push["title"] and "藍沢エマ" not in push["title"]


# ============ the existing reminders are unaffected ============


def test_a_failure_in_the_simultaneous_step_never_breaks_the_reminders(world, monkeypatch):
    """The notice is optional: if it blows up the due reminder still goes out and the run still succeeds."""
    follower(world, "c1", creators=(A,))

    def boom(*_a, **_kw):
        """The simultaneous step fails outright."""
        raise RuntimeError("ledger store down")

    monkeypatch.setattr(simultaneous_dispatcher, "run", boom)

    summary = world.run(START + timedelta(seconds=10))

    assert summary["delivered"] == 1 and summary["statusCode"] == 200


# ============ shrinking groups, superseded retries, stale memory ============


def test_a_group_that_merely_shrinks_is_not_announced_again_and_costs_no_lookup(world):
    """A+B+C becomes A+B again (C cancelled or dropped out of one refresh): nothing new is relevant to anybody, so no recipient is even looked up."""
    follower(world, "abc", creators=(A, B, C))
    show(world, [vA(), vB(), vC()], START - timedelta(hours=5))
    assert len(notices(world)) == 1
    follower(world, "late_ab", creators=(A, B))  # opted in only after that notice: it must not be told by a mere shrink
    world.take_ops()

    show(world, [vA(), vB()], START - timedelta(hours=4))

    ops = feature_ops(world.take_ops())
    assert len(notices(world)) == 1
    assert [op[0] for op in ops] == ["delete"]  # only the removed A+B+C collision's ledger; no opt-in lookup, no follower Query, no delivery-log read


def test_a_pending_retry_of_a_smaller_group_is_superseded_by_the_expanded_group_without_a_duplicate(world):
    """c1 follows A+B only; its A+B push failed and is pending when C joins. The A+B ledger goes, the A+B+C pass finds c1's identical key unclaimed and
    delivers it once -- not twice, and not never."""
    follower(world, "c1", creators=(A, B))
    world.push_results = [PushResult(sent=False, subscription_expired=False, error="down")]
    base = START - timedelta(hours=5)
    show(world, [vA(), vB()], base)
    assert notices(world) == []

    show(world, [vA(), vB(), vC()], base + timedelta(seconds=30))

    assert who(notices(world)) == ["c1"] and notices(world)[0]["data"]["videoIds"] == ["vA", "vB"]
    world.run(base + timedelta(minutes=5))
    assert len(notices(world)) == 1


def test_a_stale_settled_memory_never_suppresses_a_new_episode_of_the_same_collision(world):
    """The container remembers a collision as settled; it vanishes and returns as a NEW change. The memory must not hide the new pending ledger: a
    client that opted in meanwhile (so has no delivery row) is notified."""
    follower(world, "first")
    show(world, [vA(), vB()], START - timedelta(hours=5))
    assert who(notices(world)) == ["first"]
    show(world, [vA()], START - timedelta(hours=4))  # the group dissolves; its ledger and the memory go with it
    follower(world, "second")

    show(world, [vA(), vB()], START - timedelta(hours=3))  # and it returns

    assert who(notices(world)) == ["first", "second"]


# ============ V1 target: 100 simultaneous recipients ============


def test_v1_target_one_hundred_simultaneous_notice_recipients_are_each_notified_exactly_once_with_the_production_settings(world, monkeypatch):
    """The V1 sizing target: 100 opted-in followers of a new collision, attempted with the production worker count against a fake push service (nobody
    real is notified): all 100 delivered exactly once, concurrently, and the ledger settles with nothing left to retry."""
    from notifications import parallel
    from tests.notifications.test_dispatcher_resilience import _SlowPush

    monkeypatch.setattr(simultaneous_dispatcher, "_ATTEMPT_WORKERS", parallel.DEFAULT_WORKERS)
    push = _SlowPush()
    monkeypatch.setattr(push_sender, "send_push_notification", push)
    for index in range(100):
        follower(world, f"c{index:03d}")

    summary = show(world, [vA(), vB()], START - timedelta(hours=2))["simultaneous"]

    assert summary["delivered"] == 100 and summary["pending"] == 0 and summary["dropped"] == 0
    assert len(push.endpoints) == 100 and len(set(push.endpoints)) == 100 and 1 < push.max_in_flight <= parallel.DEFAULT_WORKERS
    assert world.config[(SYSTEM, ledger_keys(world)[0])]["state"] == sim.STATE_SETTLED


def test_v1_target_a_hundred_recipient_notice_survives_a_deadline_a_cold_start_and_a_failed_refresh(world, monkeypatch):
    """100 recipients, the Lambda runs out of time after 40 pushes, the next container is cold and the shared refresh fails meanwhile: the pending
    list in the stored schedule still drives the remaining 60 to completion, each client exactly once."""
    from notifications import parallel

    monkeypatch.setattr(simultaneous_dispatcher, "_ATTEMPT_WORKERS", parallel.DEFAULT_WORKERS)
    for index in range(100):
        follower(world, f"c{index:03d}")

    class _Deadline:
        """Time runs out after 40 pushes of the current run."""

        def __init__(self):
            """Count pushes from now on."""
            self.start = len(world.pushes)

        def get_remaining_time_in_millis(self):
            """Plenty until 40 pushes went out, then less than the margin."""
            return 1_000_000 if len(world.pushes) - self.start < 40 else 1_000

    base = START - timedelta(hours=2)
    show(world, [vA(), vB()], base, _Deadline())
    cut_short = len(notices(world))
    assert 0 < cut_short < 100 and pending(world)

    def failing(*_a, **_kw):
        """The shared refresh fails while the next run executes."""
        raise HolodexAPIError("Holodex timed out")

    monkeypatch.setattr(read_api, "get_live_streams", failing)
    world.snapshot_at += timedelta(minutes=10)
    simultaneous_dispatcher.reset_cache()  # a cold container
    world.run(base + timedelta(minutes=1))
    world.run(base + timedelta(minutes=2))

    endpoints = [push["endpoint"] for push in notices(world)]
    assert len(endpoints) == 100 and len(set(endpoints)) == 100
