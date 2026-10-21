"""How long a push service may hold a notification the device could not receive yet (the Web Push `TTL` header, RFC 8030).

`pywebpush` sends TTL=0 unless told otherwise, and a push service must then drop the message at once if the device is not reachable at that moment
(phone offline, asleep, in a tunnel). Every send therefore passes a positive TTL chosen for what the notification says:

- a new video stays worth showing for a day after it was published (a viewer coming back online that evening still wants it), so its lifetime is
  what is left of 24 hours since discovery, never less than an hour: the dispatcher may already have held it back for quiet hours or a delivery slot;
- a live reminder is only true until the stream starts, so an advance reminder lives until the scheduled start and a start reminder for a short grace
  after it -- a "starts in 10 minutes" that arrives after the start would be wrong, and a push service must not deliver it late;
- a simultaneous-livestream notice is only true until the shared start, so it lives exactly the time left until it (never past it).

The TTL only bounds how long the push service may keep an UNDELIVERED message; it does not guarantee delivery. It is unrelated to any DynamoDB TTL.
"""

from __future__ import annotations

import math
from datetime import datetime

# Never below this: a positive TTL is what stops "deliver now or drop"; below ~30 s the lifetime means nothing to a push service anyway. For a
# time-sensitive notice this is also the most it can outlive its moment (a notice sent in its last seconds).
MIN_TIME_SENSITIVE_TTL_SECONDS = 30
# The longest any notification may be held (also the new-video lifetime).
MAX_TTL_SECONDS = 24 * 3600
# A new video is held for at most this long after discovery, and at least the floor below even when it was discovered earlier.
NEW_VIDEO_TTL_SECONDS = MAX_TTL_SECONDS
MIN_NEW_VIDEO_TTL_SECONDS = 3600
# A start reminder says the stream's scheduled start has arrived; it is still useful for this long after that start.
START_REMINDER_GRACE_SECONDS = 600
# Used only by a caller that names no TTL (nothing in the dispatchers): short, but never 0.
DEFAULT_TTL_SECONDS = 3600


def _until(moment_ms: int, now: datetime) -> int:
    """Whole seconds from `now` until the epoch-millisecond `moment_ms` (negative once it has passed), rounded up."""
    return math.ceil((moment_ms - now.timestamp() * 1000) / 1000)


def _clamp(value: int, low: int, high: int) -> int:
    """`value` limited to [low, high]."""
    return max(low, min(high, value))


def new_video_ttl_seconds(*, discovered_at: datetime, now: datetime) -> int:
    """Lifetime of a new-video notification: what is left of 24 h since discovery, within [1 h, 24 h]."""
    remaining = NEW_VIDEO_TTL_SECONDS - int((now - discovered_at).total_seconds())
    return _clamp(remaining, MIN_NEW_VIDEO_TTL_SECONDS, NEW_VIDEO_TTL_SECONDS)


def advance_reminder_ttl_seconds(*, scheduled_start_ms: int, now: datetime) -> int:
    """Lifetime of an advance reminder: until the scheduled start (at least 30 s, at most 24 h)."""
    return _clamp(_until(scheduled_start_ms, now), MIN_TIME_SENSITIVE_TTL_SECONDS, MAX_TTL_SECONDS)


def simultaneous_notice_ttl_seconds(*, scheduled_start_ms: int, now: datetime) -> int:
    """Lifetime of a simultaneous-livestream notice: exactly the time left until the shared start (at least 1 s, at most 24 h), so it cannot outlive it.

    The dispatcher never sends at or after the start, so the remaining time is always positive; the 1 s floor only guards rounding.
    """
    return max(1, min(_until(scheduled_start_ms, now), MAX_TTL_SECONDS))


def start_reminder_ttl_seconds(*, scheduled_start_ms: int, now: datetime) -> int:
    """Lifetime of a start reminder: until 10 minutes after the scheduled start (at least 30 s)."""
    return _clamp(_until(scheduled_start_ms, now) + START_REMINDER_GRACE_SECONDS, MIN_TIME_SENSITIVE_TTL_SECONDS, START_REMINDER_GRACE_SECONDS)
