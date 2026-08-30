import itertools
from datetime import date, timedelta

from tracking_schedule import MEDIUM_CYCLE_DAYS, OLD_CYCLE_DAYS, is_due_today


def _published_days_ago(days: int, as_of: date) -> str:
    """Return an ISO 8601 publishedAt string that is `days` old relative to as_of."""
    return (as_of - timedelta(days=days)).isoformat() + "T00:00:00Z"


def test_recent_video_is_always_due():
    """A video published within the last 30 days is checked every day."""
    today = date(2026, 8, 30)
    published_at = _published_days_ago(0, today)

    assert is_due_today("any_video_id", published_at, today) is True


def test_video_exactly_thirty_days_old_is_still_recent():
    """The 30-day boundary is inclusive: still checked every day."""
    today = date(2026, 8, 30)
    published_at = _published_days_ago(30, today)

    assert is_due_today("any_video_id", published_at, today) is True


def test_medium_tier_video_is_not_due_every_day():
    """A 31+ day old video is not checked every single day (only on its rotation slot)."""
    today = date(2026, 8, 30)
    published_at = _published_days_ago(31, today)

    results = [is_due_today("some_video_id", published_at, today + timedelta(days=i)) for i in range(14)]

    assert any(results)
    assert not all(results)


def test_medium_tier_decision_is_deterministic():
    """The same video ID and date always produce the same due/not-due result."""
    today = date(2026, 8, 30)
    published_at = _published_days_ago(60, today)

    first = is_due_today("stable_video_id", published_at, today)
    second = is_due_today("stable_video_id", published_at, today)

    assert first == second


def test_old_tier_video_uses_thirty_day_cycle():
    """A video older than 180 days rotates on the 30-day cycle, not the 7-day one."""
    today = date(2026, 8, 30)
    published_at = _published_days_ago(200, today)

    due_days = [i for i in range(60) if is_due_today("old_video_id", published_at, today + timedelta(days=i))]

    # 60 consecutive days is exactly 2 full 30-day cycles, so it comes due exactly twice.
    assert len(due_days) == 2


def test_malformed_published_at_defaults_to_due():
    """An unparsable publishedAt errs on the side of checking the video today."""
    today = date(2026, 8, 30)

    assert is_due_today("weird_video_id", "not-a-date", today) is True


def test_medium_tier_rotation_is_roughly_even_across_a_cycle():
    """Across many video IDs, roughly 1/7 should be due on any single day (even spread)."""
    today = date(2026, 8, 30)
    published_at = _published_days_ago(60, today)
    video_ids = [f"video_{i}" for i in range(700)]

    due_count = sum(1 for video_id in video_ids if is_due_today(video_id, published_at, today))
    expected = len(video_ids) / MEDIUM_CYCLE_DAYS

    assert expected * 0.5 <= due_count <= expected * 1.5


def test_full_cycle_covers_every_medium_tier_video_exactly_once():
    """Across MEDIUM_CYCLE_DAYS consecutive days, each video is due exactly once."""
    today = date(2026, 8, 30)
    published_at = _published_days_ago(60, today)
    video_ids = [f"video_{i}" for i in range(50)]

    due_counts = {video_id: 0 for video_id in video_ids}
    for offset in range(MEDIUM_CYCLE_DAYS):
        day = today + timedelta(days=offset)
        for video_id in video_ids:
            if is_due_today(video_id, published_at, day):
                due_counts[video_id] += 1

    assert all(count == 1 for count in due_counts.values())


def test_medium_to_old_transition_always_triggers_a_check():
    """A video is always due the day it turns 181 (MEDIUM_MAX_AGE_DAYS + 1) days
    old, regardless of its rotation slot, so the transition itself can't be missed."""
    today = date(2026, 8, 30)

    for video_id in ("video_a", "video_b", "video_c", "video_d", "video_e"):
        published_at = _published_days_ago(181, today)
        assert is_due_today(video_id, published_at, today) is True


def test_no_gap_exceeds_thirty_days_across_medium_to_old_transition():
    """The medium (7-day) and old (30-day) cycles use independent rotation phases;
    without a forced check at the transition, a video could go ~35 days without
    one (e.g. last due at age 175, not due again until age 210). Verify the
    largest gap between consecutive due-days, for many video IDs, stays <= 30."""
    today = date(2026, 8, 30)
    # Simulate each video from age 150 to age 220, spanning the day-181 transition.
    published_at = _published_days_ago(150, today)
    max_offset = 71  # range(71) is offsets 0..70, i.e. ages 150..220 inclusive

    for video_id in (f"video_{i}" for i in range(30)):
        due_offsets = [
            offset
            for offset in range(max_offset)
            if is_due_today(video_id, published_at, today + timedelta(days=offset))
        ]
        gaps = [b - a for a, b in itertools.pairwise(due_offsets)]
        assert all(gap <= OLD_CYCLE_DAYS for gap in gaps), f"{video_id} had a gap > {OLD_CYCLE_DAYS}: {gaps}"


def test_full_cycle_covers_every_old_tier_video_exactly_once():
    """Across OLD_CYCLE_DAYS consecutive days, each old-tier video is due exactly once."""
    today = date(2026, 8, 30)
    published_at = _published_days_ago(200, today)
    video_ids = [f"video_{i}" for i in range(50)]

    due_counts = {video_id: 0 for video_id in video_ids}
    for offset in range(OLD_CYCLE_DAYS):
        day = today + timedelta(days=offset)
        for video_id in video_ids:
            if is_due_today(video_id, published_at, day):
                due_counts[video_id] += 1

    assert all(count == 1 for count in due_counts.values())
