import itertools
from datetime import date, timedelta

from tracking_schedule import (
    COLD_CYCLE_DAYS,
    DEMOTION_QUIET_STREAK_HOT_TO_WARM,
    DEMOTION_QUIET_STREAK_WARM_TO_COLD,
    MIN_SNAPSHOTS_BEFORE_COLD_ELIGIBLE,
    UNKNOWN_CYCLE_DAYS,
    WARM_CYCLE_DAYS,
    classify_after_observation,
    is_due_today,
)


def _published_days_ago(days: int, as_of: date) -> str:
    """Return an ISO 8601 publishedAt string that is `days` old relative to as_of."""
    return (as_of - timedelta(days=days)).isoformat() + "T00:00:00Z"


# --- is_due_today: age gate ------------------------------------------------


def test_recent_video_is_always_due_regardless_of_state():
    """A video published within the last 30 days is checked every day, even if Cold."""
    today = date(2026, 8, 30)
    published_at = _published_days_ago(0, today)

    assert is_due_today("any_video_id", published_at, "Cold", today) is True


def test_video_exactly_thirty_days_old_is_still_recent():
    """The 30-day boundary is inclusive: still checked every day."""
    today = date(2026, 8, 30)
    published_at = _published_days_ago(30, today)

    assert is_due_today("any_video_id", published_at, "Cold", today) is True


def test_malformed_published_at_defaults_to_due():
    """An unparsable publishedAt errs on the side of checking the video today."""
    today = date(2026, 8, 30)

    assert is_due_today("weird_video_id", "not-a-date", "Cold", today) is True


def test_unrecognized_activity_state_defaults_to_due():
    """An unrecognized activity_state (e.g. stale data) errs on the side of checking today."""
    today = date(2026, 8, 30)
    published_at = _published_days_ago(60, today)

    assert is_due_today("weird_video_id", published_at, "SomethingUnexpected", today) is True


# --- is_due_today: activity_state beyond the 30-day age gate ---------------


def test_hot_video_is_always_due_beyond_thirty_days():
    """A Hot video older than 30 days is still checked every day."""
    today = date(2026, 8, 30)
    published_at = _published_days_ago(60, today)

    results = [is_due_today("hot_video", published_at, "Hot", today + timedelta(days=i)) for i in range(10)]

    assert all(results)


def test_unknown_tier_video_is_not_due_every_day():
    """An Unknown-state video older than 30 days is not checked every single day."""
    today = date(2026, 8, 30)
    published_at = _published_days_ago(60, today)

    results = [is_due_today("some_video_id", published_at, "Unknown", today + timedelta(days=i)) for i in range(14)]

    assert any(results)
    assert not all(results)


def test_rotation_decision_is_deterministic():
    """The same video ID, state, and date always produce the same due/not-due result."""
    today = date(2026, 8, 30)
    published_at = _published_days_ago(60, today)

    first = is_due_today("stable_video_id", published_at, "Warm", today)
    second = is_due_today("stable_video_id", published_at, "Warm", today)

    assert first == second


def test_cold_tier_video_uses_fifteen_day_cycle():
    """A Cold video rotates on the 15-day cycle."""
    today = date(2026, 8, 30)
    published_at = _published_days_ago(200, today)

    due_days = [i for i in range(60) if is_due_today("cold_video_id", published_at, "Cold", today + timedelta(days=i))]

    # 60 consecutive days is exactly 4 full 15-day cycles, so it comes due exactly 4 times.
    assert len(due_days) == 4


def test_full_cycle_covers_every_unknown_tier_video_exactly_once():
    """Across UNKNOWN_CYCLE_DAYS consecutive days, each Unknown-state video is due exactly once."""
    today = date(2026, 8, 30)
    published_at = _published_days_ago(60, today)
    video_ids = [f"video_{i}" for i in range(50)]

    due_counts = {video_id: 0 for video_id in video_ids}
    for offset in range(UNKNOWN_CYCLE_DAYS):
        day = today + timedelta(days=offset)
        for video_id in video_ids:
            if is_due_today(video_id, published_at, "Unknown", day):
                due_counts[video_id] += 1

    assert all(count == 1 for count in due_counts.values())


def test_full_cycle_covers_every_warm_tier_video_exactly_once():
    """Across WARM_CYCLE_DAYS consecutive days, each Warm-state video is due exactly once."""
    today = date(2026, 8, 30)
    published_at = _published_days_ago(60, today)
    video_ids = [f"video_{i}" for i in range(50)]

    due_counts = {video_id: 0 for video_id in video_ids}
    for offset in range(WARM_CYCLE_DAYS):
        day = today + timedelta(days=offset)
        for video_id in video_ids:
            if is_due_today(video_id, published_at, "Warm", day):
                due_counts[video_id] += 1

    assert all(count == 1 for count in due_counts.values())


def test_full_cycle_covers_every_cold_tier_video_exactly_once():
    """Across COLD_CYCLE_DAYS consecutive days, each Cold-state video is due exactly once."""
    today = date(2026, 8, 30)
    published_at = _published_days_ago(200, today)
    video_ids = [f"video_{i}" for i in range(50)]

    due_counts = {video_id: 0 for video_id in video_ids}
    for offset in range(COLD_CYCLE_DAYS):
        day = today + timedelta(days=offset)
        for video_id in video_ids:
            if is_due_today(video_id, published_at, "Cold", day):
                due_counts[video_id] += 1

    assert all(count == 1 for count in due_counts.values())


def test_no_gap_exceeds_cold_cycle_across_state_change():
    """If a video's state changes mid-window, the rotation phases are independent per
    cycle length; verify no single state's due-gap ever exceeds its own cycle length."""
    today = date(2026, 8, 30)
    published_at = _published_days_ago(200, today)
    max_offset = 71

    for video_id in (f"video_{i}" for i in range(30)):
        due_offsets = [
            offset for offset in range(max_offset) if is_due_today(video_id, published_at, "Cold", today + timedelta(days=offset))
        ]
        gaps = [b - a for a, b in itertools.pairwise(due_offsets)]
        assert all(gap <= COLD_CYCLE_DAYS for gap in gaps), f"{video_id} had a gap > {COLD_CYCLE_DAYS}: {gaps}"


# --- classify_after_observation: bootstrap ----------------------------------


def test_first_snapshot_bootstraps_to_unknown():
    """A video with no prior observation (previous_view_count=None) always starts Unknown,
    even though this specific call's numbers might otherwise look like strong growth."""
    result = classify_after_observation(
        current_state="Unknown",
        snapshot_count=0,
        quiet_streak=0,
        previous_view_count=None,
        previous_checked_at=None,
        new_view_count=50,
        observed_at="2026-08-30T18:00:00+09:00",
    )

    assert result.activity_state == "Unknown"
    assert result.snapshot_count == 1
    assert result.quiet_streak == 0
    assert result.reason == "bootstrap_first_snapshot"


# --- classify_after_observation: promotion to Hot ---------------------------


def test_strong_percent_growth_promotes_to_hot():
    """>=2%/day promotes straight to Hot, regardless of current state."""
    result = classify_after_observation(
        current_state="Cold",
        snapshot_count=5,
        quiet_streak=1,
        previous_view_count=10_000,
        previous_checked_at="2026-08-29T18:00:00+09:00",
        new_view_count=12_000,  # +2,000 views over 1 day = 20%/day
        observed_at="2026-08-30T18:00:00+09:00",
    )

    assert result.activity_state == "Hot"
    assert result.quiet_streak == 0
    assert result.reason == "strong_growth"


def test_high_percent_growth_on_a_small_video_is_capped_to_warm():
    """Hot's percent path requires an absolute views/day floor alongside the
    percent floor, specifically so a small video can't reach Hot purely from
    a trivial absolute gain — 10 -> 15 views is 50%/day but only 5 views/day,
    which is below the floor, so it lands on Warm instead (via the percent
    path, which has no absolute floor)."""
    result = classify_after_observation(
        current_state="Warm",  # already past the Unknown bootstrap gate
        snapshot_count=5,
        quiet_streak=0,
        previous_view_count=10,
        previous_checked_at="2026-08-29T18:00:00+09:00",
        new_view_count=15,  # +5 views/day = 50%/day, below Hot's absolute floor
        observed_at="2026-08-30T18:00:00+09:00",
    )

    assert result.activity_state == "Warm"


def test_large_absolute_gain_promotes_to_hot_even_with_tiny_percent():
    """A large enough absolute views/day gain promotes to Hot on its own,
    even when the percent growth is tiny on a huge existing view count."""
    result = classify_after_observation(
        current_state="Warm",
        snapshot_count=5,
        quiet_streak=0,
        previous_view_count=10_000_000,
        previous_checked_at="2026-08-29T18:00:00+09:00",
        new_view_count=10_001_000,  # +1,000 views/day, ~0.01%/day
        observed_at="2026-08-30T18:00:00+09:00",
    )

    assert result.activity_state == "Hot"


def test_moderate_absolute_gain_promotes_to_warm_even_with_tiny_percent():
    """A moderate absolute views/day gain promotes to Warm on its own, even
    when the percent growth is tiny on a huge existing view count."""
    result = classify_after_observation(
        current_state="Cold",
        snapshot_count=5,
        quiet_streak=0,
        previous_view_count=10_000_000,
        previous_checked_at="2026-08-29T18:00:00+09:00",
        new_view_count=10_000_100,  # +100 views/day, ~0.001%/day
        observed_at="2026-08-30T18:00:00+09:00",
    )

    assert result.activity_state == "Warm"


# --- classify_after_observation: Unknown bootstrap path ----------------------


def test_unknown_does_not_promote_to_warm_before_minimum_snapshots():
    """Unknown must accumulate MIN_SNAPSHOTS_BEFORE_COLD_ELIGIBLE snapshots
    before it may become Warm or Cold — only a strong (Hot-tier) interval
    is allowed to skip this gate (see test below)."""
    result = classify_after_observation(
        current_state="Unknown",
        snapshot_count=1,  # this will be only the 2nd snapshot, still < the minimum
        quiet_streak=0,
        previous_view_count=1_000,
        previous_checked_at="2026-08-29T18:00:00+09:00",
        new_view_count=1_010,  # +10 views/day = 1%/day: Warm-tier if evaluated, not Hot-tier
        observed_at="2026-08-30T18:00:00+09:00",
    )

    assert result.activity_state == "Unknown"
    assert result.snapshot_count == 2


def test_strong_growth_promotes_unknown_to_hot_before_minimum_snapshots():
    """A strong first interval is the one exception to Unknown's minimum-evidence
    gate: it may promote Unknown straight to Hot immediately, even on only its
    2nd-ever snapshot."""
    result = classify_after_observation(
        current_state="Unknown",
        snapshot_count=1,  # this will be only the 2nd snapshot, still < the minimum
        quiet_streak=0,
        previous_view_count=1_000,
        previous_checked_at="2026-08-29T18:00:00+09:00",
        new_view_count=10_000,  # +9,000 views/day: Hot-tier
        observed_at="2026-08-30T18:00:00+09:00",
    )

    assert result.activity_state == "Hot"
    assert result.snapshot_count == 2


def test_unknown_promotes_to_warm_once_minimum_snapshots_reached():
    """Once Unknown reaches the minimum snapshot count, moderate growth promotes it to Warm."""
    result = classify_after_observation(
        current_state="Unknown",
        snapshot_count=MIN_SNAPSHOTS_BEFORE_COLD_ELIGIBLE - 1,  # this call reaches the minimum
        quiet_streak=0,
        previous_view_count=1_000,
        previous_checked_at="2026-08-29T18:00:00+09:00",
        new_view_count=1_010,  # +10 views/day = 1%/day: over Warm's 0.5%, under Hot's 2%
        observed_at="2026-08-30T18:00:00+09:00",
    )

    assert result.activity_state == "Warm"
    assert result.snapshot_count == MIN_SNAPSHOTS_BEFORE_COLD_ELIGIBLE


def test_unknown_stays_unknown_while_quiet_and_under_minimum_snapshots():
    """A quiet Unknown video with fewer than 3 total snapshots stays Unknown, not Cold."""
    result = classify_after_observation(
        current_state="Unknown",
        snapshot_count=1,  # -> becomes the 2nd snapshot, still < MIN_SNAPSHOTS_BEFORE_COLD_ELIGIBLE
        quiet_streak=0,
        previous_view_count=1_000,
        previous_checked_at="2026-08-29T18:00:00+09:00",
        new_view_count=1_002,  # +2 views/day = 0.2%/day: below the 0.5%/100-views Warm floor
        observed_at="2026-08-30T18:00:00+09:00",
    )

    assert result.activity_state == "Unknown"
    assert result.snapshot_count == 2
    assert result.snapshot_count < MIN_SNAPSHOTS_BEFORE_COLD_ELIGIBLE


def test_unknown_becomes_cold_once_quiet_at_minimum_snapshots():
    """A quiet Unknown video reaching MIN_SNAPSHOTS_BEFORE_COLD_ELIGIBLE snapshots becomes Cold."""
    result = classify_after_observation(
        current_state="Unknown",
        snapshot_count=MIN_SNAPSHOTS_BEFORE_COLD_ELIGIBLE - 1,  # this call reaches the minimum
        quiet_streak=1,
        previous_view_count=1_000,
        previous_checked_at="2026-08-29T18:00:00+09:00",
        new_view_count=1_002,  # quiet
        observed_at="2026-08-30T18:00:00+09:00",
    )

    assert result.activity_state == "Cold"
    assert result.snapshot_count == MIN_SNAPSHOTS_BEFORE_COLD_ELIGIBLE


# --- classify_after_observation: moderate growth on already-classified videos ---


def test_cold_video_reactivating_is_promoted_to_warm_regardless_of_age():
    """A Cold video showing renewed moderate growth is promoted to Warm; age never blocks reactivation."""
    result = classify_after_observation(
        current_state="Cold",
        snapshot_count=10,
        quiet_streak=2,
        previous_view_count=10_000,
        previous_checked_at="2026-08-15T18:00:00+09:00",  # 15 days ago
        new_view_count=11_500,  # +1,500 views over 15 days = 1%/day: Warm, not Hot
        observed_at="2026-08-30T18:00:00+09:00",
    )

    assert result.activity_state == "Warm"
    assert result.quiet_streak == 0


def test_hot_video_with_only_moderate_growth_stays_hot():
    """A Hot video that shows moderate (not strong) growth this time is not immediately
    demoted — only a run of genuinely quiet observations demotes it."""
    result = classify_after_observation(
        current_state="Hot",
        snapshot_count=10,
        quiet_streak=0,
        previous_view_count=10_000,
        previous_checked_at="2026-08-29T18:00:00+09:00",
        new_view_count=10_150,  # +150 views/day: Warm-tier, not Hot-tier
        observed_at="2026-08-30T18:00:00+09:00",
    )

    assert result.activity_state == "Hot"
    assert result.quiet_streak == 0


# --- classify_after_observation: demotion ------------------------------------


def test_quiet_observation_increments_streak_without_demoting_below_threshold():
    """A quiet observation increments quiet_streak but doesn't demote until the threshold.
    Warm->Cold uses the higher DEMOTION_QUIET_STREAK_WARM_TO_COLD threshold."""
    result = classify_after_observation(
        current_state="Warm",
        snapshot_count=10,
        quiet_streak=DEMOTION_QUIET_STREAK_WARM_TO_COLD - 2,
        previous_view_count=10_000,
        previous_checked_at="2026-08-29T18:00:00+09:00",
        new_view_count=10_010,  # essentially flat: quiet
        observed_at="2026-08-30T18:00:00+09:00",
    )

    assert result.activity_state == "Warm"
    assert result.quiet_streak == DEMOTION_QUIET_STREAK_WARM_TO_COLD - 1


def test_reaching_quiet_streak_threshold_demotes_warm_to_cold():
    """Reaching DEMOTION_QUIET_STREAK_WARM_TO_COLD consecutive quiet observations demotes Warm to Cold."""
    result = classify_after_observation(
        current_state="Warm",
        snapshot_count=10,
        quiet_streak=DEMOTION_QUIET_STREAK_WARM_TO_COLD - 1,
        previous_view_count=10_000,
        previous_checked_at="2026-08-29T18:00:00+09:00",
        new_view_count=10_010,
        observed_at="2026-08-30T18:00:00+09:00",
    )

    assert result.activity_state == "Cold"
    assert result.quiet_streak == 0


def test_reaching_quiet_streak_threshold_demotes_hot_to_warm():
    """Reaching DEMOTION_QUIET_STREAK_HOT_TO_WARM consecutive quiet observations demotes
    Hot to Warm, not straight to Cold. Hot's threshold is lower than Warm's since it's
    checked daily and cheap to re-promote if the demotion turns out to be premature."""
    result = classify_after_observation(
        current_state="Hot",
        snapshot_count=10,
        quiet_streak=DEMOTION_QUIET_STREAK_HOT_TO_WARM - 1,
        previous_view_count=10_000,
        previous_checked_at="2026-08-29T18:00:00+09:00",
        new_view_count=10_010,
        observed_at="2026-08-30T18:00:00+09:00",
    )

    assert result.activity_state == "Warm"


def test_cold_cannot_demote_further():
    """A Cold video that stays quiet remains Cold — there is no lower state."""
    result = classify_after_observation(
        current_state="Cold",
        snapshot_count=20,
        quiet_streak=DEMOTION_QUIET_STREAK_WARM_TO_COLD - 1,
        previous_view_count=10_000,
        previous_checked_at="2026-08-15T18:00:00+09:00",
        new_view_count=10_010,
        observed_at="2026-08-30T18:00:00+09:00",
    )

    assert result.activity_state == "Cold"


def test_zero_baseline_with_trivial_gain_stays_quiet():
    """Growing from 0 views is undefined as a percentage — a trivial absolute
    gain (0 -> 1 view) must not be treated as "100%/day" strong growth, and
    is also too small to clear either tier's absolute views/day floor."""
    result = classify_after_observation(
        current_state="Unknown",
        snapshot_count=1,
        quiet_streak=0,
        previous_view_count=0,
        previous_checked_at="2026-08-29T18:00:00+09:00",
        new_view_count=1,
        observed_at="2026-08-30T18:00:00+09:00",
    )

    assert result.activity_state != "Hot"
    assert result.activity_state != "Warm"


def test_zero_baseline_with_large_absolute_gain_is_hot_via_absolute_floor():
    """Percent growth from a zero baseline is undefined and treated as 0.0,
    but a large enough absolute jump (e.g. 0 -> 5,000 views in a day) still
    clears Hot's absolute views/day floor on its own — this is also a strong
    enough interval to promote Unknown early, before the minimum-evidence gate."""
    result = classify_after_observation(
        current_state="Unknown",
        snapshot_count=1,  # still below the minimum-evidence gate
        quiet_streak=0,
        previous_view_count=0,
        previous_checked_at="2026-08-29T18:00:00+09:00",
        new_view_count=5_000,
        observed_at="2026-08-30T18:00:00+09:00",
    )

    assert result.activity_state == "Hot"


def test_downward_view_count_correction_is_treated_as_quiet_not_negative():
    """A rare downward viewCount correction from YouTube must not read as negative
    velocity or crash — it's floored to a quiet (zero-growth) observation."""
    result = classify_after_observation(
        current_state="Warm",
        snapshot_count=10,
        quiet_streak=0,
        previous_view_count=10_000,
        previous_checked_at="2026-08-29T18:00:00+09:00",
        new_view_count=9_990,  # a correction, not growth
        observed_at="2026-08-30T18:00:00+09:00",
    )

    assert result.activity_state == "Warm"
    assert result.quiet_streak == 1
