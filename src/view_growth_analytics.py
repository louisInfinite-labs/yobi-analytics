"""View Growth Analytics (Roadmap 3.1): daily/7-day/30-day growth from historical snapshots.

Pure calculation logic only — no I/O, no AWS/DynamoDB dependency. Given a
video's already-fetched snapshot for a report date and its comparison date,
this module computes growth and classifies why a value might be missing
(pending vs. permanently not available) rather than fabricating a zero or
silently substituting a nearby date. Looking those snapshots up (locally or
via DynamoDB) and wiring this to the Roadmap 3.4 Read API is the caller's
job, not this module's.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from zoneinfo import ZoneInfo

from snapshot_store import Snapshot

# The project's own collection start date (Roadmap 3.1's own worked example).
# No reportDate/comparisonDate before this can ever resolve, no matter how
# long a caller waits — this is the "not available", never "pending", case.
COLLECTION_START_DATE = date(2026, 8, 29)

PERIOD_DAYS = {"1d": 1, "7d": 7, "30d": 30}

STATUS_OK = "ok"
STATUS_PENDING = "pending"
STATUS_NOT_AVAILABLE = "not_available"


class InvalidTimeZoneError(ValueError):
    """Raised when a requested time zone is not a valid IANA zone name."""


class InvalidPeriodError(ValueError):
    """Raised when a requested period is not one of the supported 1d/7d/30d values."""


def validate_time_zone(time_zone: str) -> ZoneInfo:
    """Resolve an IANA time zone name, raising InvalidTimeZoneError for anything else.

    Accepts any zone in the deployed tz database (e.g. Asia/Tokyo,
    Asia/Hong_Kong, Europe/London) rather than a hardcoded allowlist — see
    Roadmap 3.1/3.4. A raw numeric UTC offset or a garbage string is rejected
    here, not passed through to a downstream date calculation.
    """
    try:
        return ZoneInfo(time_zone)
    except Exception as exc:  # ZoneInfoNotFoundError, ValueError, or TypeError on a malformed value
        raise InvalidTimeZoneError(f"Not a valid IANA time zone: {time_zone!r}") from exc


def comparison_date(report_date: date, period: str) -> date:
    """Return report_date minus the period's day count.

    Pure calendar-date arithmetic: `timedelta` on a `date` has no
    time-of-day component, so this is correct for every IANA zone,
    daylight-saving included, without ever touching a UTC offset. A naive
    implementation that round-trips report_date through a UTC datetime
    first (e.g. local-midnight -> UTC instant -> subtract N*24h -> convert
    back) would land on the wrong calendar date across a DST transition;
    this deliberately never does that.
    """
    try:
        days = PERIOD_DAYS[period]
    except KeyError:
        raise InvalidPeriodError(f"Unsupported period {period!r}; expected one of {sorted(PERIOD_DAYS)}") from None
    return report_date - timedelta(days=days)


@dataclass(frozen=True)
class DatedViewCount:
    """One resolved point (a date) in a growth comparison."""

    date: str
    status: str
    view_count: int | None
    last_updated_at: str | None


@dataclass(frozen=True)
class GrowthResult:
    """The full growth comparison for one video between report_date and its comparison_date."""

    video_id: str
    period: str
    report_date: str
    comparison_date: str
    latest: DatedViewCount
    comparison: DatedViewCount
    status: str
    growth: int | None
    growth_percent: float | None
    last_updated_at: str | None


def calculate_growth(
    *,
    video_id: str,
    report_date: date,
    period: str,
    latest_snapshot: Snapshot | None,
    comparison_snapshot: Snapshot | None,
    earliest_available_date: date,
) -> GrowthResult:
    """Compute one video's growth for period, given its two already-fetched snapshot points.

    Raw snapshots remain the source of truth (Roadmap 3.1): this never
    fabricates a zero for a missing point and never treats an older
    snapshot as the requested date's value. `earliest_available_date` is
    the earliest calendar date this specific video could possibly have a
    snapshot (e.g. derived from when its creator/video was onboarded into
    Video Master) — a missing point before
    max(COLLECTION_START_DATE, earliest_available_date) is classified
    not_available (will never resolve); a missing point on/after that date
    is classified pending (no snapshot recorded yet, whether because the
    day's run hasn't completed or this video simply wasn't due that day
    under the adaptive tracking schedule).
    """
    comp_date = comparison_date(report_date, period)
    latest = _resolve_point(
        target_date=report_date, snapshot=latest_snapshot, earliest_available_date=earliest_available_date
    )
    comparison = _resolve_point(
        target_date=comp_date, snapshot=comparison_snapshot, earliest_available_date=earliest_available_date
    )

    if latest.status == STATUS_OK and comparison.status == STATUS_OK:
        growth = latest.view_count - comparison.view_count
        growth_percent = (growth / comparison.view_count * 100) if comparison.view_count > 0 else None
        overall_status = STATUS_OK
    else:
        growth = None
        growth_percent = None
        # not_available (permanent) outranks pending (temporary) when both
        # points are missing — "this will never resolve" is the more urgent
        # fact for a caller to know than "one of these might still arrive".
        overall_status = STATUS_NOT_AVAILABLE if STATUS_NOT_AVAILABLE in (latest.status, comparison.status) else STATUS_PENDING

    return GrowthResult(
        video_id=video_id,
        period=period,
        report_date=report_date.isoformat(),
        comparison_date=comp_date.isoformat(),
        latest=latest,
        comparison=comparison,
        status=overall_status,
        growth=growth,
        growth_percent=growth_percent,
        last_updated_at=latest.last_updated_at,
    )


def _resolve_point(*, target_date: date, snapshot: Snapshot | None, earliest_available_date: date) -> DatedViewCount:
    """Classify one date's snapshot lookup result into ok / pending / not_available."""
    if snapshot is not None:
        return DatedViewCount(
            date=target_date.isoformat(),
            status=STATUS_OK,
            view_count=snapshot.view_count,
            last_updated_at=snapshot.observed_at,
        )
    effective_start = max(COLLECTION_START_DATE, earliest_available_date)
    if target_date < effective_start:
        return DatedViewCount(date=target_date.isoformat(), status=STATUS_NOT_AVAILABLE, view_count=None, last_updated_at=None)
    return DatedViewCount(date=target_date.isoformat(), status=STATUS_PENDING, view_count=None, last_updated_at=None)
