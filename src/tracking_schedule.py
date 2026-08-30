"""Tiered Tracking Frequency (Roadmap 1.5).

Decides which already-tracked videos need a fresh statistics check today.
Recent videos are checked every day; older videos rotate through a longer
cycle using a stable per-video hash (not a calendar trigger), so the daily
workload stays roughly even instead of spiking on any particular date.

Discovery (1.4.2/1.4.3) is unaffected by this — it keeps running daily for
every active creator. This module only decides how often a video's
*statistics* get refreshed once it is already in the Tracking Universe.
"""

from __future__ import annotations

import hashlib
from datetime import date, datetime

RECENT_MAX_AGE_DAYS = 30
MEDIUM_MAX_AGE_DAYS = 180
MEDIUM_CYCLE_DAYS = 7
OLD_CYCLE_DAYS = 30


def is_due_today(video_id: str, published_at: str, as_of: date) -> bool:
    """Return whether a tracked video should get a fresh statistics check today."""
    try:
        age_days = _age_in_days(published_at, as_of)
    except (ValueError, TypeError, AttributeError) as exc:
        print(f"Warning: could not determine age for video {video_id!r} (publishedAt={published_at!r}): {exc}")
        return True  # can't determine age; check it today to be safe

    if age_days <= RECENT_MAX_AGE_DAYS:
        return True
    if age_days == MEDIUM_MAX_AGE_DAYS + 1:
        # The medium (7-day) and old (30-day) cycles use independent rotation
        # keys, so their phases are unrelated. Without forcing a check right
        # at this transition, a video could go up to ~35 days without one
        # (e.g. last checked at age 175, not due again until age 210).
        return True

    cycle_days = MEDIUM_CYCLE_DAYS if age_days <= MEDIUM_MAX_AGE_DAYS else OLD_CYCLE_DAYS
    return _rotation_slot(video_id, cycle_days) == as_of.toordinal() % cycle_days


def _age_in_days(published_at: str, as_of: date) -> int:
    """Return how many days old a video is, given its ISO 8601 publishedAt."""
    published_date = datetime.fromisoformat(published_at.replace("Z", "+00:00")).date()
    return (as_of - published_date).days


def _rotation_slot(video_id: str, cycle_days: int) -> int:
    """Return a stable slot (0..cycle_days-1) for video_id, evenly spread across the cycle."""
    digest = hashlib.md5(video_id.encode("utf-8")).hexdigest()
    return int(digest, 16) % cycle_days
