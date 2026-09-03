from datetime import date, datetime, timedelta

from quota_ledger import (
    DAILY_HARD_CAP_RATIO,
    IMMEDIATE_PHASE_CAP_RATIO,
    MID_BAND_RATIO,
    NON_RETRYABLE,
    RETRYABLE,
    STOP_ALL,
    RetryRecord,
    classify_http_error,
    decide_retry_interval_minutes,
    fits_before_cutoff,
    quota_reset_at,
    retry_cutoff_at,
)


# --- classify_http_error -----------------------------------------------


def test_quota_exceeded_reason_stops_everything():
    """quotaExceeded must halt all further requests, not just this one."""
    assert classify_http_error(403, "quotaExceeded") == STOP_ALL


def test_daily_limit_exceeded_reason_stops_everything():
    assert classify_http_error(403, "dailyLimitExceeded") == STOP_ALL


def test_rate_limit_exceeded_reason_is_retryable():
    assert classify_http_error(403, "rateLimitExceeded") == RETRYABLE


def test_http_429_with_no_reason_is_retryable():
    """A bare 429 with no parseable reason code still counts as retryable by status alone."""
    assert classify_http_error(429, None) == RETRYABLE


def test_transient_server_statuses_are_retryable():
    for status in (500, 502, 503, 504):
        assert classify_http_error(status, None) == RETRYABLE


def test_forbidden_without_a_retryable_reason_is_non_retryable():
    """A 403 that isn't quota-related (e.g. plain forbidden) must not be retried forever."""
    assert classify_http_error(403, "forbidden") == NON_RETRYABLE


def test_bad_request_is_non_retryable():
    assert classify_http_error(400, "invalidParameter") == NON_RETRYABLE


def test_stop_all_reason_wins_even_with_a_retryable_status():
    """The reason code takes priority over the raw HTTP status when both are present."""
    assert classify_http_error(429, "quotaExceeded") == STOP_ALL


# --- decide_retry_interval_minutes --------------------------------------


def test_low_usage_retries_in_one_hour():
    assert decide_retry_interval_minutes(0.10) == 60


def test_just_under_immediate_cap_still_one_hour():
    assert decide_retry_interval_minutes(IMMEDIATE_PHASE_CAP_RATIO - 0.001) == 60


def test_at_immediate_cap_boundary_retries_in_two_hours():
    assert decide_retry_interval_minutes(IMMEDIATE_PHASE_CAP_RATIO) == 120


def test_mid_band_retries_in_two_hours():
    assert decide_retry_interval_minutes(0.34) == 120


def test_at_mid_band_boundary_retries_in_three_hours():
    assert decide_retry_interval_minutes(MID_BAND_RATIO) == 180


def test_just_under_hard_cap_retries_in_three_hours():
    assert decide_retry_interval_minutes(DAILY_HARD_CAP_RATIO - 0.001) == 180


def test_at_hard_cap_boundary_stops():
    assert decide_retry_interval_minutes(DAILY_HARD_CAP_RATIO) is None


def test_beyond_hard_cap_stops():
    assert decide_retry_interval_minutes(0.75) is None


# --- quota_reset_at / retry_cutoff_at (Pacific, DST-aware) --------------


def test_reset_time_during_pacific_daylight_time_matches_roadmap_example():
    """Roadmap 2.5's own worked example: 2026-09-01 (PDT, UTC-7) resets at
    2026-09-02T00:00:00-07:00."""
    reset = quota_reset_at(date(2026, 9, 1))

    assert reset.isoformat() == "2026-09-02T00:00:00-07:00"


def test_reset_time_during_pacific_standard_time_uses_utc_minus_eight():
    """A winter date (outside DST) resets at UTC-8, not UTC-7 — zoneinfo must
    pick the correct offset for that specific calendar date automatically."""
    reset = quota_reset_at(date(2026, 1, 15))

    assert reset.isoformat() == "2026-01-16T00:00:00-08:00"


def test_retry_cutoff_is_fifteen_minutes_before_reset_by_default():
    cutoff = retry_cutoff_at(date(2026, 9, 1))
    reset = quota_reset_at(date(2026, 9, 1))

    assert reset - cutoff == timedelta(minutes=15)


def test_fits_before_cutoff_true_when_interval_ends_in_time():
    quota_date = date(2026, 9, 1)
    # Reset is 2026-09-02T00:00:00-07:00, cutoff is 15 minutes earlier.
    attempt_at = datetime(2026, 9, 1, 20, 0, tzinfo=quota_reset_at(quota_date).tzinfo)

    assert fits_before_cutoff(attempt_at, interval_minutes=60, quota_date_pacific=quota_date) is True


def test_fits_before_cutoff_false_when_interval_would_cross_the_cutoff():
    quota_date = date(2026, 9, 1)
    attempt_at = datetime(2026, 9, 1, 23, 30, tzinfo=quota_reset_at(quota_date).tzinfo)

    assert fits_before_cutoff(attempt_at, interval_minutes=60, quota_date_pacific=quota_date) is False


# --- RetryRecord ----------------------------------------------------------


def test_retry_record_projected_units_matches_roadmap_worked_example():
    """Roadmap 2.5's own worked example: used=2200, reserved=100, estimated=80
    -> projected=2380, ratio=0.238."""
    record = RetryRecord(
        quota_date_pacific="2026-09-01",
        quota_limit_units=10_000,
        used_units=2200,
        reserved_units=100,
        estimated_retry_units=80,
        creator_id="aizawa_ema",
        snapshot_date="2026-09-01",
        failed_batch_ids=["batch-07"],
        attempt_number=4,
        last_attempt_at="2026-09-01T20:05:00+09:00",
        decision_reason="recovery_middle_band",
        status="scheduled",
        version=8,
    )

    assert record.projected_units == 2380
    assert record.projected_quota_ratio == 0.238
