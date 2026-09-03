"""Quota-adaptive failure classification and retry-interval decisions (Roadmap 2.5).

Pure decision logic only — no AWS dependency, no I/O. This is the part of
2.5 that's safe to build and test standalone: classifying a YouTube API
failure, deciding how long to wait before a deferred retry, and computing
the Pacific-day quota reset boundary (DST-aware via zoneinfo). Durable
persistence of retry state (a DynamoDB table) and deferred-retry scheduling
(EventBridge Scheduler/SQS) are real AWS infrastructure this module
deliberately does not create — see the module's own callers for that gap.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

PACIFIC_TZ = ZoneInfo("America/Los_Angeles")

# Roadmap 2.5 "initial configurable thresholds" — runtime configuration, not
# permanent constants.
QUOTA_LIMIT_UNITS = 10_000
NORMAL_QUOTA_TARGET_RATIO = 0.20
IMMEDIATE_PHASE_CAP_RATIO = 0.30
MID_BAND_RATIO = 0.35
DAILY_HARD_CAP_RATIO = 0.40

NORMAL_TARGET_UNITS = int(QUOTA_LIMIT_UNITS * NORMAL_QUOTA_TARGET_RATIO)
IMMEDIATE_PHASE_CAP_UNITS = int(QUOTA_LIMIT_UNITS * IMMEDIATE_PHASE_CAP_RATIO)
DAILY_HARD_CAP_UNITS = int(QUOTA_LIMIT_UNITS * DAILY_HARD_CAP_RATIO)

RETRY_CUTOFF_BUFFER_MINUTES = 15
# The original scheduled request is attempt 1; attempts 2 and 3 are the two
# immediate retries. Three total, not "one plus three".
IMMEDIATE_MAX_ATTEMPTS = 3

# Failure categories (Roadmap 2.5): decide before scheduling any retry.
RETRYABLE = "retryable"
STOP_ALL = "stop_all"
NON_RETRYABLE = "non_retryable"

_RETRYABLE_HTTP_STATUSES = {429, 500, 502, 503, 504}
_RETRYABLE_REASONS = {"rateLimitExceeded", "userRateLimitExceeded", "backendError", "internalError"}
_STOP_ALL_REASONS = {"quotaExceeded", "dailyLimitExceeded"}


def classify_http_error(status_code: int, reason: str | None) -> str:
    """Classify one YouTube API HTTP error into RETRYABLE / STOP_ALL / NON_RETRYABLE.

    `reason` is YouTube's machine-readable error reason code (e.g.
    "quotaExceeded"), not the human-readable message — see
    youtube_client._extract_error_reason for how to obtain it from an
    HttpError. `status_code` alone is used when no reason code is available.
    """
    if reason in _STOP_ALL_REASONS:
        return STOP_ALL
    if reason in _RETRYABLE_REASONS or status_code in _RETRYABLE_HTTP_STATUSES:
        return RETRYABLE
    return NON_RETRYABLE


def decide_retry_interval_minutes(projected_quota_ratio: float) -> int | None:
    """Return minutes to wait before a deferred retry, or None if the hard cap is reached.

    Roadmap 2.5 "Quota-Adaptive Interval Decision" table:
    <30% -> 60min, 30-35% -> 120min, 35-40% -> 180min, >=40% -> stop.
    """
    if projected_quota_ratio >= DAILY_HARD_CAP_RATIO:
        return None
    if projected_quota_ratio >= MID_BAND_RATIO:
        return 180
    if projected_quota_ratio >= IMMEDIATE_PHASE_CAP_RATIO:
        return 120
    return 60


def quota_reset_at(quota_date_pacific: date) -> datetime:
    """Return the Pacific-time midnight that ends quota_date_pacific, DST-aware.

    zoneinfo resolves the correct UTC offset for that specific calendar date
    (PST UTC-8 or PDT UTC-7) — no manual DST arithmetic needed.
    """
    next_day = quota_date_pacific + timedelta(days=1)
    return datetime(next_day.year, next_day.month, next_day.day, tzinfo=PACIFIC_TZ)


def retry_cutoff_at(quota_date_pacific: date, buffer_minutes: int = RETRY_CUTOFF_BUFFER_MINUTES) -> datetime:
    """Return the latest a deferred retry may start: quota_reset_at minus a safety buffer."""
    return quota_reset_at(quota_date_pacific) - timedelta(minutes=buffer_minutes)


def fits_before_cutoff(attempt_at: datetime, interval_minutes: int, quota_date_pacific: date) -> bool:
    """Return whether a retry starting at attempt_at and taking interval_minutes
    would finish before this Pacific day's retry_cutoff_at.

    Roadmap 2.5 step 6: never substitute a shorter, more quota-aggressive
    interval just to fit before the cutoff — the caller should stop and wait
    for the next normal schedule instead when this returns False.
    """
    return attempt_at + timedelta(minutes=interval_minutes) <= retry_cutoff_at(quota_date_pacific)


@dataclass(frozen=True)
class RetryRecord:
    """Durable retry/quota state for one creator's failed batch on one Pacific day.

    Mirrors the JSON shape in Roadmap 2.5's "Quota-Adaptive Interval
    Decision" section. `version` supports optimistic-concurrency (atomic
    conditional update) when persisted — see that section for why a stale
    read must never be acted on without rechecking this field.
    """

    quota_date_pacific: str
    quota_limit_units: int
    used_units: int
    reserved_units: int
    estimated_retry_units: int
    creator_id: str
    snapshot_date: str
    failed_batch_ids: list[str]
    attempt_number: int
    last_attempt_at: str
    decision_reason: str
    status: str
    version: int
    retry_interval_minutes: int | None = None
    next_retry_at: str | None = None

    @property
    def projected_units(self) -> int:
        """Total quota units this record accounts for: used + reserved + the next estimated retry."""
        return self.used_units + self.reserved_units + self.estimated_retry_units

    @property
    def projected_quota_ratio(self) -> float:
        """projected_units as a fraction of the day's quota limit."""
        return self.projected_units / self.quota_limit_units
