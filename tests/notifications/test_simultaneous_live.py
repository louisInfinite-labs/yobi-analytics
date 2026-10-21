"""同時開播預告, pure logic: what a collision is, who it is relevant to, the notice window and the ledger's stored shape."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from notifications import live_reminder, notification_text
from notifications import simultaneous_live as sim
from notifications.live_reminder import LiveReminderSetting, StreamScheduleEntry

START_MS = int(datetime(2026, 10, 17, 12, 15, tzinfo=timezone.utc).timestamp() * 1000)
ON = LiveReminderSetting(notify_at_start=True, advance_reminder=None)
OFF = LiveReminderSetting(notify_at_start=False, advance_reminder=None)


def _entry(creator: str, start_ms: int = START_MS, *, status: str | None = "upcoming", topic: str | None = None) -> StreamScheduleEntry:
    """One schedule entry."""
    return StreamScheduleEntry(creator_id=creator, scheduled_start_ms=start_ms, topic=topic, status=status)


# ============ detection ============


def test_two_creators_in_the_same_minute_are_a_collision():
    """Exactly the same start minute, different creators."""
    collisions = sim.detect_collisions({"v1": _entry("a"), "v2": _entry("b")}, now_ms=START_MS - 3_600_000)

    assert [c.members for c in collisions.values()] == [(("a", "v1"), ("b", "v2"))]


def test_only_the_exact_same_scheduled_start_is_a_collision_not_merely_the_same_minute():
    """Exactly the same instant (whole seconds, as Holodex reports them): a start one second apart is a different time, even inside one minute."""
    together = sim.detect_collisions({"v1": _entry("a", START_MS + 5_000), "v2": _entry("b", START_MS + 5_000)}, now_ms=0)
    one_second_apart = sim.detect_collisions({"v1": _entry("a", START_MS + 5_000), "v2": _entry("b", START_MS + 6_000)}, now_ms=0)
    next_minute = sim.detect_collisions({"v1": _entry("a", START_MS), "v2": _entry("b", START_MS + 60_000)}, now_ms=0)

    assert len(together) == 1 and one_second_apart == {} and next_minute == {}


def test_sub_second_noise_is_ignored_because_holodex_reports_whole_seconds():
    """The schedule stores epoch ms from an ISO timestamp with no fraction; if a fraction ever appeared it must not split an exact collision."""
    collisions = sim.detect_collisions({"v1": _entry("a", START_MS + 250), "v2": _entry("b", START_MS)}, now_ms=0)

    assert len(collisions) == 1


def test_a_real_production_shaped_schedule_groups_by_the_identical_timestamp():
    """Shape of the live schedule that was checked (planned streams on :00; one unplanned waiting room with odd seconds that is already live):
    the groups sharing a start minute each share ONE exact timestamp, so exact and per-minute matching agree, and the odd-second live stream joins nothing."""
    entries = {
        "a1": _entry("a", START_MS), "b1": _entry("b", START_MS), "c1": _entry("c", START_MS),
        "d1": _entry("d", START_MS + 3_600_000), "e1": _entry("e", START_MS + 3_600_000),
        "odd": StreamScheduleEntry(creator_id="f", scheduled_start_ms=START_MS - 86_400_000 + 32_000, status="live"),
    }

    collisions = sim.detect_collisions(entries, now_ms=0)

    assert sorted(len(c.members) for c in collisions.values()) == [2, 3]


def test_one_creator_with_two_streams_at_once_is_not_a_collision():
    """Simultaneous means different creators."""
    assert sim.detect_collisions({"v1": _entry("a"), "v2": _entry("a")}, now_ms=0) == {}


@pytest.mark.parametrize("status", ["live", "past", "missing", None])
def test_only_upcoming_streams_count(status):
    """A live, ended or status-less record never takes part (fail closed)."""
    assert sim.detect_collisions({"v1": _entry("a"), "v2": _entry("b", status=status)}, now_ms=0) == {}


def test_a_stream_already_past_its_start_does_not_count_unless_asked_to_for_cleanup():
    """`now_ms=None` keeps a past start so a previous snapshot's collision can still be recognised for cleanup."""
    entries = {"v1": _entry("a"), "v2": _entry("b")}

    assert sim.detect_collisions(entries, now_ms=START_MS + 1) == {}
    assert len(sim.detect_collisions(entries, now_ms=None)) == 1


def test_three_creators_are_one_collision_and_two_separate_groups_are_two():
    """Membership decides the group."""
    one = sim.detect_collisions({"v1": _entry("a"), "v2": _entry("b"), "v3": _entry("c")}, now_ms=0)
    two = sim.detect_collisions(
        {"v1": _entry("a"), "v2": _entry("b"), "v3": _entry("c", START_MS + 60_000), "v4": _entry("d", START_MS + 60_000)}, now_ms=0
    )

    assert [len(c.members) for c in one.values()] == [3]
    assert len(two) == 2


def test_the_id_is_stable_for_an_unchanged_collision_and_new_when_membership_or_start_changes():
    """Unchanged = same id (no duplicate notice); a member joining, leaving or a reschedule = a different collision."""
    base = sim.detect_collisions({"v1": _entry("a"), "v2": _entry("b")}, now_ms=0)
    again = sim.detect_collisions({"v2": _entry("b"), "v1": _entry("a")}, now_ms=0)  # iteration order is irrelevant
    joined = sim.detect_collisions({"v1": _entry("a"), "v2": _entry("b"), "v3": _entry("c")}, now_ms=0)
    moved = sim.detect_collisions({"v1": _entry("a", START_MS + 60_000), "v2": _entry("b", START_MS + 60_000)}, now_ms=0)

    assert list(base) == list(again)
    assert not set(base) & set(joined) and not set(base) & set(moved)


# ============ notice window ============


def test_there_is_no_lead_time_and_no_minimum_remaining_time_only_the_scheduled_start_limits_a_notice():
    """The fixed 3 h / 10 min window was never authorised: nothing in the pure logic knows about one, and a collision is simply upcoming or not."""
    for name in ("NOTICE_LEAD_MS", "NOTICE_MIN_REMAINING_MS", "notice_window_open", "window_could_have_opened"):
        assert not hasattr(sim, name), name
    entries = {"v1": _entry("a"), "v2": _entry("b")}

    assert len(sim.detect_collisions(entries, now_ms=START_MS - 5_000)) == 1  # five seconds before the start: still a collision
    assert len(sim.detect_collisions(entries, now_ms=START_MS - 30 * 24 * 3_600_000)) == 1  # a month ahead: also
    assert sim.detect_collisions(entries, now_ms=START_MS) == {}  # at the start: over


# ============ relevance ============


def _collision_and_entries():
    """A two-creator collision and its entries."""
    entries = {"v1": _entry("a", topic=None), "v2": _entry("b", topic=None)}
    return next(iter(sim.detect_collisions(entries, now_ms=0).values())), entries


def test_a_client_is_told_only_when_at_least_two_distinct_creators_have_live_notifications_enabled():
    """One followed creator (or two with the second switched off) leaves nothing simultaneous to say."""
    collision, entries = _collision_and_entries()

    both = live_reminder.ReminderSettings(creator_all={"a": ON, "b": ON})
    only_a = live_reminder.ReminderSettings(creator_all={"a": ON})
    b_off = live_reminder.ReminderSettings(creator_all={"a": ON, "b": OFF})

    assert sim.relevant_members(both, collision, entries) == (("a", "v1"), ("b", "v2"))
    assert sim.relevant_members(only_a, collision, entries) == ()
    assert sim.relevant_members(b_off, collision, entries) == ()


def test_a_per_stream_override_beats_the_creator_setting_when_deciding_relevance():
    """The same precedence as a reminder: override > creator 全部 > creator + topic."""
    collision, entries = _collision_and_entries()
    settings = live_reminder.ReminderSettings(
        creator_all={"a": ON, "b": ON}, stream_overrides={"v2": live_reminder.StreamReminderOverride("b", OFF)}
    )

    assert sim.relevant_members(settings, collision, entries) == ()


def test_a_topic_reminder_counts_only_for_a_stream_of_that_topic():
    """creator + topic items apply to the matching stream only."""
    entries = {"v1": _entry("a", topic="fps"), "v2": _entry("b", topic="rpg")}
    collision = next(iter(sim.detect_collisions(entries, now_ms=0).values()))
    settings = live_reminder.ReminderSettings(creator_topics={("a", "fps"): ON, ("b", "fps"): ON})

    assert sim.relevant_members(settings, collision, entries) == ()  # b's topic reminder is for fps, but its stream is rpg


def test_an_advance_only_reminder_counts_as_enabled():
    """notify-at-start off with an advance time is still a live notification."""
    assert sim.is_reminder_enabled(LiveReminderSetting(False, "30min")) and not sim.is_reminder_enabled(OFF) and not sim.is_reminder_enabled(None)


def test_the_notice_key_is_stable_per_client_relevant_set_and_distinct_for_another():
    """Idempotency: the same notice always has the same key; a different relevant set or start is a different notice."""
    one = sim.notice_key(100, ("v1", "v2"))

    assert one == sim.notice_key(100, ("v2", "v1")) and one != sim.notice_key(100, ("v1", "v3")) and one != sim.notice_key(101, ("v1", "v2"))
    assert one.startswith(sim.NOTICE_KEY_PREFIX) and ":reminder:" not in one


@pytest.mark.parametrize("raw, expected", [({"enabled": True}, True), ({"enabled": False}, False), ({}, False), (None, False), ("yes", False), ({"enabled": 1}, False)])
def test_only_exactly_enabled_true_is_an_opt_in(raw, expected):
    """Anything else is off."""
    assert sim.is_opted_in(raw) is expected


# ============ ledger shape ============


def test_a_ledger_survives_its_stored_form_and_an_unusable_one_is_none():
    """The stored JSON round-trips; garbage never raises."""
    collision, _ = _collision_and_entries()
    ledger = sim.Ledger(
        version=3, state=sim.STATE_PENDING, lease_until_ms=5, resolved=True,
        work={"c1": sim.WorkItem(attempts=1, next_at_ms=9, video_ids=("v1", "v2"), reason=sim.REASON_SEND_FAILED)}, delivered=2, dropped=1, gave_up=0,
    )

    assert sim.parse_ledger(sim.ledger_to_value(ledger, collision)) == ledger
    for garbage in (None, "x", {}, {"version": "1"}, {"version": True}):
        assert sim.parse_ledger(garbage) is None
    assert sim.parse_ledger({"version": 1, "work": {"c": {"videoIds": []}, "d": "no"}}).work == {}


def test_the_retry_delay_grows_and_is_bounded():
    """Attempt 1 failed -> a minute, attempt 2 failed -> three minutes."""
    assert sim.retry_delay_ms(1) == 60_000 and sim.retry_delay_ms(2) == 180_000 and sim.retry_delay_ms(9) == 180_000


# ============ wording ============


@pytest.mark.parametrize(
    "locale, expected_title",
    [
        ("en", "A, B and 2 more are scheduled to go live at the same time"),
        ("ja", "A、B ほか2人 の配信開始予定が重なっています"),
        ("zh-TW", "A、B 等 2 位 預定同時開播"),
    ],
)
def test_the_notice_wording_in_every_locale_names_two_creators_and_counts_the_rest(locale, expected_title):
    """Title names at most two creators; the body carries the local time and the original titles, untouched."""
    text = notification_text.simultaneous_notification(
        locale=locale, creator_names=["A", "B", "C", "D"], start_label="21:15", stream_titles=["Ranked grind", " ", None]
    )

    assert text.title == expected_title
    assert text.body == "21:15  Ranked grind"


def test_the_notice_text_is_never_empty_and_never_claims_anyone_is_live():
    """A missing name or title falls back; the body is at least the time."""
    text = notification_text.simultaneous_notification(locale="xx", creator_names=[None, ""], start_label="09:00", stream_titles=[])

    assert text.title and text.body == "09:00"
    assert "live now" not in text.title and "has started" not in text.title
