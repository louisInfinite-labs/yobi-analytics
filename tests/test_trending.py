import pytest

from trending import (
    DAILY_TRENDING,
    FASTEST_GROWING,
    MOST_VIEWED,
    SEVEN_DAY_TRENDING,
    THIRTY_DAY_TRENDING,
    InvalidRankingTypeError,
    rank_videos,
)
from view_growth_analytics import STATUS_OK, STATUS_PENDING, DatedViewCount, GrowthResult


def _point(status: str, view_count: int | None = None) -> DatedViewCount:
    """Build a minimal DatedViewCount for a test."""
    return DatedViewCount(date="2026-09-01", status=status, view_count=view_count, last_updated_at=None)


def _result(
    video_id: str, *, period: str = "7d", view_count: int | None, growth: int | None, growth_percent: float | None
) -> GrowthResult:
    """Build a minimal GrowthResult for a test, matching calculate_growth's own shape."""
    latest_status = STATUS_OK if view_count is not None else STATUS_PENDING
    return GrowthResult(
        video_id=video_id,
        period=period,
        report_date="2026-09-01",
        comparison_date="2026-08-25",
        latest=_point(latest_status, view_count),
        comparison=_point(STATUS_OK if growth is not None else STATUS_PENDING),
        status=STATUS_OK if growth is not None else STATUS_PENDING,
        growth=growth,
        growth_percent=growth_percent,
        last_updated_at=None,
    )


def test_most_viewed_sorts_by_latest_view_count_descending():
    results = [
        _result("a", view_count=100, growth=10, growth_percent=10.0),
        _result("b", view_count=300, growth=10, growth_percent=3.3),
        _result("c", view_count=200, growth=10, growth_percent=5.0),
    ]

    ranked = rank_videos(results, MOST_VIEWED)

    assert [entry.video_id for entry in ranked] == ["b", "c", "a"]
    assert [entry.rank for entry in ranked] == [1, 2, 3]


def test_most_viewed_excludes_a_video_with_no_recorded_latest_snapshot():
    """A video whose latest point is pending/not_available has no view count to
    rank by and must be left out, not sorted as if it were zero (the worst)."""
    results = [
        _result("a", view_count=100, growth=10, growth_percent=10.0),
        _result("b", view_count=None, growth=None, growth_percent=None),
    ]

    ranked = rank_videos(results, MOST_VIEWED)

    assert [entry.video_id for entry in ranked] == ["a"]


def test_fastest_growing_sorts_by_growth_percent_descending():
    results = [
        _result("a", view_count=1000, growth=100, growth_percent=11.1),
        _result("b", view_count=1000, growth=500, growth_percent=100.0),
        _result("c", view_count=1000, growth=10, growth_percent=1.0),
    ]

    ranked = rank_videos(results, FASTEST_GROWING)

    assert [entry.video_id for entry in ranked] == ["b", "a", "c"]


def test_fastest_growing_excludes_zero_denominator_results():
    """A result whose growth_percent is None (zero-denominator comparison, per
    Roadmap 3.1) cannot be meaningfully ranked by percent and is excluded."""
    results = [
        _result("a", view_count=1000, growth=100, growth_percent=10.0),
        _result("b", view_count=1000, growth=1000, growth_percent=None),
    ]

    ranked = rank_videos(results, FASTEST_GROWING)

    assert [entry.video_id for entry in ranked] == ["a"]


def test_seven_day_trending_matches_roadmap_worked_example():
    """Roadmap 3.2's own worked example: 藍沢エマ — 7 Day Trending ordering by absolute growth."""
    results = [
        _result("video_c", period="7d", view_count=1000, growth=61_000, growth_percent=6.1),
        _result("video_a", period="7d", view_count=5000, growth=180_000, growth_percent=18.0),
        _result("video_b", period="7d", view_count=3000, growth=92_000, growth_percent=9.2),
    ]

    ranked = rank_videos(results, SEVEN_DAY_TRENDING)

    assert [entry.video_id for entry in ranked] == ["video_a", "video_b", "video_c"]
    assert [entry.value for entry in ranked] == [180_000, 92_000, 61_000]


def test_daily_trending_ignores_results_computed_for_a_different_period():
    """A 30d-period result must not leak into a daily_trending ranking just
    because it has a growth value — the period itself must match."""
    results = [
        _result("a", period="1d", view_count=1000, growth=50, growth_percent=5.0),
        _result("b", period="30d", view_count=1000, growth=500, growth_percent=50.0),
    ]

    ranked = rank_videos(results, DAILY_TRENDING)

    assert [entry.video_id for entry in ranked] == ["a"]


def test_thirty_day_trending_sorts_by_absolute_growth():
    results = [
        _result("a", period="30d", view_count=1000, growth=1000, growth_percent=100.0),
        _result("b", period="30d", view_count=1000, growth=5000, growth_percent=500.0),
    ]

    ranked = rank_videos(results, THIRTY_DAY_TRENDING)

    assert [entry.video_id for entry in ranked] == ["b", "a"]


def test_limit_truncates_the_ranking():
    results = [_result(f"v{i}", view_count=i, growth=i, growth_percent=float(i)) for i in range(5)]

    ranked = rank_videos(results, MOST_VIEWED, limit=2)

    assert [entry.video_id for entry in ranked] == ["v4", "v3"]


def test_rejects_unsupported_ranking_type():
    with pytest.raises(InvalidRankingTypeError):
        rank_videos([], "most_commented")


def test_empty_input_returns_empty_ranking():
    assert rank_videos([], MOST_VIEWED) == []
