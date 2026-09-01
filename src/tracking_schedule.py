"""Adaptive Tracking Frequency (Roadmap 1.5).

Decides which already-tracked videos need a fresh statistics check today, and
how a video's activity_state evolves after each check. Age and activity are
separate dimensions: every video is checked daily for its first 30 days
regardless of activity_state; afterward, activity_state (Hot/Unknown/Warm/Cold)
governs the schedule via a stable per-video rotation (not a calendar trigger),
so the daily workload stays roughly even instead of spiking on any particular
date.

Discovery (1.4.2/1.4.3) is unaffected by this — it keeps running daily for
every discovery-enabled creator. This module only decides how often a video's
*statistics* get refreshed once it is already in the Tracking Universe.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import date, datetime

RECENT_MAX_AGE_DAYS = 30

UNKNOWN_CYCLE_DAYS = 2
WARM_CYCLE_DAYS = 3
COLD_CYCLE_DAYS = 15
_CYCLE_DAYS_BY_STATE = {"Unknown": UNKNOWN_CYCLE_DAYS, "Warm": WARM_CYCLE_DAYS, "Cold": COLD_CYCLE_DAYS}

# "Unknown" needs at least three snapshots (two valid comparison intervals)
# before it may become Cold, and Warm is only evaluated once that same
# minimum evidence is reached (it is "rechecked on its 3-day schedule").
# A strong first interval is the one exception: it may promote Unknown
# straight to Hot immediately, without waiting for this gate.
MIN_SNAPSHOTS_BEFORE_COLD_ELIGIBLE = 3

# Demotion requires 2-3 consecutive quiet observations to prevent
# Hot/Warm/Cold oscillation from a single noisy/quiet data point. The
# higher-frequency tier (Hot, checked daily) demotes on less evidence than
# the bigger drop from Warm (3-day cycle) to Cold (15-day cycle), which
# warrants more confirmation before parking a video that far out.
DEMOTION_QUIET_STREAK_HOT_TO_WARM = 2
DEMOTION_QUIET_STREAK_WARM_TO_COLD = 3
_DEMOTION_THRESHOLD_BY_STATE = {
    "Hot": DEMOTION_QUIET_STREAK_HOT_TO_WARM,
    "Warm": DEMOTION_QUIET_STREAK_WARM_TO_COLD,
}

# Roadmap 1.5 "initial tuning thresholds" — runtime configuration, not
# permanent constants. Each tier is reached via percent-of-current-views
# growth OR an absolute views/day floor, so a five-million-view video
# gaining a trivial +10/day stays Cold while a 5,000-view video gaining
# +1,000/day reads as Hot even though its percent growth would qualify on
# its own. Hot's percent path additionally requires a modest absolute
# floor so a tiny video can't reach Hot purely from a trivial absolute
# gain (e.g. 10 -> 15 views); Warm's percent path has no such floor.
# Store the measurements/reason so thresholds can be tuned without
# rewriting snapshot history.
HOT_MIN_PERCENT_PER_DAY = 2.0
HOT_MIN_ABS_VIEWS_PER_DAY_FOR_PERCENT = 100
HOT_MIN_AVG_VIEWS_PER_DAY = 1000
WARM_MIN_PERCENT_PER_DAY = 0.5
WARM_MIN_AVG_VIEWS_PER_DAY = 100

_DEMOTE_TO = {"Hot": "Warm", "Warm": "Cold", "Cold": "Cold"}


def is_due_today(video_id: str, published_at: str, activity_state: str, as_of: date) -> bool:
    """Return whether a tracked video should get a fresh statistics check today."""
    try:
        age_days = _age_in_days(published_at, as_of)
    except (ValueError, TypeError, AttributeError) as exc:
        print(f"Warning: could not determine age for video {video_id!r} (publishedAt={published_at!r}): {exc}")
        return True  # can't determine age; check it today to be safe

    if age_days <= RECENT_MAX_AGE_DAYS:
        return True
    if activity_state == "Hot":
        return True

    cycle_days = _CYCLE_DAYS_BY_STATE.get(activity_state)
    if cycle_days is None:
        return True  # unrecognized state; check it today to be safe
    return _rotation_slot(video_id, cycle_days) == as_of.toordinal() % cycle_days


@dataclass(frozen=True)
class ClassificationResult:
    """The updated scheduler state for one video after a fresh observation.

    `percent_per_day`/`avg_views_per_day` are the velocity measurements this
    observation was classified on — None only for `bootstrap_first_snapshot`,
    where there was no prior observation to measure growth against. Callers
    persist these onto Video Master so a past Hot/Warm/Cold decision can be
    audited or used to retune thresholds later, without recomputing it from
    raw snapshot history.
    """

    activity_state: str
    snapshot_count: int
    quiet_streak: int
    reason: str
    percent_per_day: float | None
    avg_views_per_day: float | None


def classify_after_observation(
    *,
    current_state: str,
    snapshot_count: int,
    quiet_streak: int,
    previous_view_count: int | None,
    previous_checked_at: str | None,
    new_view_count: int,
    observed_at: str,
) -> ClassificationResult:
    """Decide a video's next activity_state from its latest statistics snapshot.

    `previous_view_count`/`previous_checked_at` are the video's prior
    Video Master state, or None if this is its first-ever snapshot. Missing
    or incomplete snapshots must never reach this function at all — a skipped
    check does not count as a quiet observation and cannot demote a video
    (Roadmap 1.5); the caller simply leaves that video's record untouched.
    """
    new_snapshot_count = snapshot_count + 1

    if previous_view_count is None or previous_checked_at is None:
        # A first cumulative viewCount is only a baseline — every first-time
        # import is Unknown, even if it's old and has few total views.
        return ClassificationResult("Unknown", new_snapshot_count, 0, "bootstrap_first_snapshot", None, None)

    percent_per_day, avg_views_per_day = _growth_per_day(
        previous_view_count, new_view_count, previous_checked_at, observed_at
    )
    is_hot = avg_views_per_day >= HOT_MIN_AVG_VIEWS_PER_DAY or (
        percent_per_day >= HOT_MIN_PERCENT_PER_DAY and avg_views_per_day >= HOT_MIN_ABS_VIEWS_PER_DAY_FOR_PERCENT
    )
    is_warm = avg_views_per_day >= WARM_MIN_AVG_VIEWS_PER_DAY or percent_per_day >= WARM_MIN_PERCENT_PER_DAY

    if current_state == "Unknown":
        if is_hot:
            # A strong first interval may promote Unknown straight to Hot
            # immediately, bypassing the minimum-evidence gate below.
            return ClassificationResult(
                "Hot", new_snapshot_count, 0, "strong_growth", percent_per_day, avg_views_per_day
            )
        if new_snapshot_count < MIN_SNAPSHOTS_BEFORE_COLD_ELIGIBLE:
            # Every other transition follows the minimum-evidence gate:
            # Unknown must accumulate MIN_SNAPSHOTS_BEFORE_COLD_ELIGIBLE
            # snapshots before it may become Warm or Cold.
            return ClassificationResult(
                "Unknown", new_snapshot_count, 0, "bootstrap_awaiting_more_snapshots", percent_per_day, avg_views_per_day
            )
        if is_warm:
            return ClassificationResult(
                "Warm", new_snapshot_count, 0, "moderate_growth_after_bootstrap", percent_per_day, avg_views_per_day
            )
        return ClassificationResult(
            "Cold", new_snapshot_count, 0, "quiet_after_bootstrap", percent_per_day, avg_views_per_day
        )

    if is_hot:
        return ClassificationResult("Hot", new_snapshot_count, 0, "strong_growth", percent_per_day, avg_views_per_day)

    if is_warm:
        # Moderate (though not "strong") growth is not a quiet observation —
        # it resets the demotion streak, and promotes Warm/Cold up to Warm.
        # A Hot video showing only moderate growth this time stays Hot; only
        # a run of genuinely quiet observations demotes it (see below).
        next_state = "Hot" if current_state == "Hot" else "Warm"
        return ClassificationResult(
            next_state, new_snapshot_count, 0, "moderate_growth", percent_per_day, avg_views_per_day
        )

    next_quiet_streak = quiet_streak + 1
    demotion_threshold = _DEMOTION_THRESHOLD_BY_STATE.get(current_state)
    if demotion_threshold is not None and next_quiet_streak >= demotion_threshold:
        return ClassificationResult(
            _DEMOTE_TO[current_state],
            new_snapshot_count,
            0,
            "demoted_after_quiet_streak",
            percent_per_day,
            avg_views_per_day,
        )
    return ClassificationResult(
        current_state, new_snapshot_count, next_quiet_streak, "quiet_observation", percent_per_day, avg_views_per_day
    )


def _growth_per_day(
    previous_view_count: int, new_view_count: int, previous_checked_at: str, observed_at: str
) -> tuple[float, float]:
    """Return (percent-of-previous-views growth per day, absolute views per day) since the last observation."""
    previous_dt = datetime.fromisoformat(previous_checked_at.replace("Z", "+00:00"))
    observed_dt = datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
    elapsed_days = max((observed_dt - previous_dt).total_seconds() / 86400, 1e-9)
    # A rare downward view-count correction from YouTube is not "growth"; floor at 0
    # rather than letting it read as negative.
    delta_views = max(new_view_count - previous_view_count, 0)
    avg_views_per_day = delta_views / elapsed_days
    if previous_view_count <= 0:
        # Percent growth from a zero baseline is undefined, not "100%/day" —
        # treat it as not applicable (quiet) rather than a false spike. The
        # absolute views/day floor above still applies in this case.
        return 0.0, avg_views_per_day
    return delta_views / previous_view_count / elapsed_days * 100, avg_views_per_day


def _age_in_days(published_at: str, as_of: date) -> int:
    """Return how many days old a video is, given its ISO 8601 publishedAt."""
    published_date = datetime.fromisoformat(published_at.replace("Z", "+00:00")).date()
    return (as_of - published_date).days


def _rotation_slot(video_id: str, cycle_days: int) -> int:
    """Return a stable slot (0..cycle_days-1) for video_id, evenly spread across the cycle."""
    digest = hashlib.md5(video_id.encode("utf-8")).hexdigest()
    return int(digest, 16) % cycle_days
