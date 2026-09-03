from datetime import date

import pytest

from snapshot_store import Snapshot
from view_growth_analytics import (
    COLLECTION_START_DATE,
    STATUS_NOT_AVAILABLE,
    STATUS_OK,
    STATUS_PENDING,
    InvalidPeriodError,
    InvalidTimeZoneError,
    calculate_growth,
    comparison_date,
    validate_time_zone,
)


def _snapshot(snapshot_date: str, view_count: int, observed_at: str | None = None) -> Snapshot:
    """Build a minimal Snapshot for a growth-calculation test."""
    return Snapshot(
        snapshot_date=snapshot_date,
        observed_at=observed_at or f"{snapshot_date}T18:00:05+09:00",
        creator_id="aizawa_ema",
        video_id="v1",
        title="Test Video",
        published_at="2026-08-20T00:00:00Z",
        view_count=view_count,
        organization="vspo",
    )


# --- validate_time_zone --------------------------------------------------


@pytest.mark.parametrize("zone", ["Asia/Tokyo", "Asia/Hong_Kong", "Europe/London", "UTC"])
def test_validate_time_zone_accepts_representative_iana_zones(zone):
    """Positive-offset, negative-offset, UTC, and DST zones are all accepted."""
    validate_time_zone(zone)


def test_validate_time_zone_rejects_a_raw_numeric_offset():
    """A raw UTC offset string is not an IANA zone name and must be rejected."""
    with pytest.raises(InvalidTimeZoneError):
        validate_time_zone("+09:00")


def test_validate_time_zone_rejects_garbage_string():
    """An unrecognized zone name must not silently fall back to another zone."""
    with pytest.raises(InvalidTimeZoneError):
        validate_time_zone("Not/A_Real_Zone")


# --- comparison_date -------------------------------------------------------


def test_comparison_date_one_day():
    """period=1d subtracts exactly one calendar day."""
    assert comparison_date(date(2026, 9, 1), "1d") == date(2026, 8, 31)


def test_comparison_date_seven_days():
    """period=7d subtracts exactly seven calendar days."""
    assert comparison_date(date(2026, 9, 1), "7d") == date(2026, 8, 25)


def test_comparison_date_thirty_days():
    """period=30d subtracts exactly thirty calendar days."""
    assert comparison_date(date(2026, 9, 1), "30d") == date(2026, 8, 2)


def test_comparison_date_crosses_a_month_boundary():
    """Subtraction across a month boundary lands on the correct prior-month date."""
    assert comparison_date(date(2026, 3, 1), "1d") == date(2026, 2, 28)


def test_comparison_date_across_european_dst_spring_forward():
    """Europe/London's DST transition (clocks forward in late March) must not
    shift the calendar-date subtraction by a day — comparison_date never
    round-trips through a UTC instant, so it is unaffected either way."""
    # 2026-03-29 is the UK's spring-forward date; report_date is just after it.
    assert comparison_date(date(2026, 3, 30), "1d") == date(2026, 3, 29)
    assert comparison_date(date(2026, 4, 5), "7d") == date(2026, 3, 29)


def test_comparison_date_across_european_dst_fall_back():
    """Same guarantee across the UK's autumn clocks-back transition."""
    # 2026-10-25 is the UK's fall-back date.
    assert comparison_date(date(2026, 10, 26), "1d") == date(2026, 10, 25)
    assert comparison_date(date(2026, 11, 1), "7d") == date(2026, 10, 25)


def test_comparison_date_rejects_unsupported_period():
    """A period outside 1d/7d/30d is rejected rather than silently ignored."""
    with pytest.raises(InvalidPeriodError):
        comparison_date(date(2026, 9, 1), "14d")


# --- calculate_growth: both points present --------------------------------


def test_calculate_growth_positive_growth():
    """A straightforward day-over-day increase computes both absolute and percent growth."""
    result = calculate_growth(
        video_id="v1",
        report_date=date(2026, 9, 1),
        period="1d",
        latest_snapshot=_snapshot("2026-09-01", 1240),
        comparison_snapshot=_snapshot("2026-08-31", 1000),
        earliest_available_date=COLLECTION_START_DATE,
    )

    assert result.status == STATUS_OK
    assert result.growth == 240
    assert result.growth_percent == pytest.approx(24.0)
    assert result.report_date == "2026-09-01"
    assert result.comparison_date == "2026-08-31"
    assert result.last_updated_at == "2026-09-01T18:00:05+09:00"


def test_calculate_growth_negative_growth_from_a_view_count_correction():
    """A downward YouTube view-count correction is reported as-is, not floored at zero."""
    result = calculate_growth(
        video_id="v1",
        report_date=date(2026, 9, 1),
        period="1d",
        latest_snapshot=_snapshot("2026-09-01", 900),
        comparison_snapshot=_snapshot("2026-08-31", 1000),
        earliest_available_date=COLLECTION_START_DATE,
    )

    assert result.status == STATUS_OK
    assert result.growth == -100
    assert result.growth_percent == pytest.approx(-10.0)


def test_calculate_growth_zero_growth():
    """No change between the two points reports zero, not a missing/pending status."""
    result = calculate_growth(
        video_id="v1",
        report_date=date(2026, 9, 1),
        period="1d",
        latest_snapshot=_snapshot("2026-09-01", 1000),
        comparison_snapshot=_snapshot("2026-08-31", 1000),
        earliest_available_date=COLLECTION_START_DATE,
    )

    assert result.growth == 0
    assert result.growth_percent == pytest.approx(0.0)


def test_calculate_growth_zero_comparison_denominator_leaves_percent_unavailable():
    """A comparison snapshot of 0 views makes percent growth mathematically
    undefined; the absolute growth is still a plain subtraction."""
    result = calculate_growth(
        video_id="v1",
        report_date=date(2026, 9, 1),
        period="1d",
        latest_snapshot=_snapshot("2026-09-01", 500),
        comparison_snapshot=_snapshot("2026-08-31", 0),
        earliest_available_date=COLLECTION_START_DATE,
    )

    assert result.status == STATUS_OK
    assert result.growth == 500
    assert result.growth_percent is None


# --- calculate_growth: missing points -------------------------------------


def test_calculate_growth_pending_when_todays_snapshot_not_recorded_yet():
    """A report_date within range but with no recorded snapshot yet is pending, not zero."""
    result = calculate_growth(
        video_id="v1",
        report_date=date(2026, 9, 2),
        period="1d",
        latest_snapshot=None,
        comparison_snapshot=_snapshot("2026-09-01", 1000),
        earliest_available_date=COLLECTION_START_DATE,
    )

    assert result.status == STATUS_PENDING
    assert result.latest.status == STATUS_PENDING
    assert result.comparison.status == STATUS_OK
    assert result.growth is None
    assert result.growth_percent is None


def test_calculate_growth_surfaces_the_latest_completed_timestamp_when_todays_point_is_pending():
    """Roadmap 3.1: a pending `latest` must still report the most recent
    *completed* data's timestamp (here, the comparison snapshot's), not
    None — a caller needs to know how fresh the last real data is even
    while waiting for today's."""
    result = calculate_growth(
        video_id="v1",
        report_date=date(2026, 9, 2),
        period="1d",
        latest_snapshot=None,
        comparison_snapshot=_snapshot("2026-09-01", 1000, observed_at="2026-09-01T18:00:05+09:00"),
        earliest_available_date=COLLECTION_START_DATE,
    )

    assert result.last_updated_at == "2026-09-01T18:00:05+09:00"


def test_calculate_growth_not_available_before_project_collection_start():
    """A comparison date before the project's own collection start date can
    never resolve — distinctly not_available, never pending."""
    result = calculate_growth(
        video_id="v1",
        report_date=date(2026, 8, 30),
        period="7d",  # comparison_date is 2026-08-23, before COLLECTION_START_DATE
        latest_snapshot=_snapshot("2026-08-30", 1000),
        comparison_snapshot=None,
        earliest_available_date=COLLECTION_START_DATE,
    )

    assert result.comparison.status == STATUS_NOT_AVAILABLE
    assert result.status == STATUS_NOT_AVAILABLE
    assert result.growth is None


def test_calculate_growth_not_available_before_video_onboarding_even_after_collection_start():
    """A video onboarded after the project's collection start has no possible
    history before its own onboarding date — a clean not_available result,
    not confused with a missing/pending day (Roadmap 3.1)."""
    onboarded = date(2026, 8, 31)
    result = calculate_growth(
        video_id="v1",
        report_date=date(2026, 9, 1),
        period="7d",  # comparison_date 2026-08-25: after project start, before onboarding
        latest_snapshot=_snapshot("2026-09-01", 1000),
        comparison_snapshot=None,
        earliest_available_date=onboarded,
    )

    assert result.comparison.status == STATUS_NOT_AVAILABLE
    assert result.status == STATUS_NOT_AVAILABLE


def test_calculate_growth_not_available_outranks_pending_when_both_points_missing():
    """When both the latest and comparison points are missing for different
    reasons, the permanent not_available fact takes priority over pending."""
    result = calculate_growth(
        video_id="v1",
        report_date=date(2026, 9, 5),  # within range but not recorded yet -> pending
        period="30d",  # comparison_date 2026-08-06, before COLLECTION_START_DATE -> not_available
        latest_snapshot=None,
        comparison_snapshot=None,
        earliest_available_date=COLLECTION_START_DATE,
    )

    assert result.latest.status == STATUS_PENDING
    assert result.comparison.status == STATUS_NOT_AVAILABLE
    assert result.status == STATUS_NOT_AVAILABLE
    assert result.growth is None
    assert result.growth_percent is None
