"""Video Trending Rankings (Roadmap 3.2 Creator Trending, 3.3 Organization Trending).

Pure ranking logic only: given a list of already-computed GrowthResult
values (Roadmap 3.1), sort, filter, and rank them for one trending view.
Scoping the input list to a single creator's videos (3.2) or to every video
across an organization (3.3) — joining against Creator/Video Master — is the
caller's job, not this module's; the ranking math itself is identical
either way (Video Trending "for a creator" vs. "across an organization" is a
pre-filter, not a different sort), so it lives here once instead of being
duplicated per scope.
"""

from __future__ import annotations

from dataclasses import dataclass

from view_growth_analytics import STATUS_OK, GrowthResult

MOST_VIEWED = "most_viewed"
FASTEST_GROWING = "fastest_growing"
DAILY_TRENDING = "daily_trending"
SEVEN_DAY_TRENDING = "7d_trending"
THIRTY_DAY_TRENDING = "30d_trending"

# The three "Nd Trending" ranking types each require GrowthResult values
# computed for that specific period (Roadmap 3.1's period=1d|7d|30d) — this
# maps a ranking type to the period its input results must match.
_PERIOD_TRENDING_TYPES = {
    DAILY_TRENDING: "1d",
    SEVEN_DAY_TRENDING: "7d",
    THIRTY_DAY_TRENDING: "30d",
}

RANKING_TYPES = frozenset({MOST_VIEWED, FASTEST_GROWING, *_PERIOD_TRENDING_TYPES})


class InvalidRankingTypeError(ValueError):
    """Raised when a requested ranking type is not one of the supported RANKING_TYPES."""


@dataclass(frozen=True)
class RankedEntry:
    """One position in a trending ranking (Roadmap 3.2's "1. Video A +180K" example)."""

    rank: int
    video_id: str
    value: float
    result: GrowthResult


def rank_videos(results: list[GrowthResult], ranking_type: str, limit: int | None = None) -> list[RankedEntry]:
    """Sort growth results into a ranked, numbered trending list.

    Excludes any result whose ranked metric is not actually available
    (STATUS_OK view count, a defined growth_percent, or a defined absolute
    growth for the matching period) — Roadmap 3.1 never fabricates a value
    for a pending/not_available point, so leaving a video out of a ranking
    is correct here; sorting it as if its missing metric were zero would
    misrepresent it as the worst performer instead of simply unranked.
    """
    if ranking_type not in RANKING_TYPES:
        raise InvalidRankingTypeError(
            f"Unsupported ranking type {ranking_type!r}; expected one of {sorted(RANKING_TYPES)}"
        )

    rankable = [(result, _metric_value(result, ranking_type)) for result in results]
    rankable = [(result, value) for result, value in rankable if value is not None]
    rankable.sort(key=lambda pair: pair[1], reverse=True)

    if limit is not None:
        rankable = rankable[:limit]

    return [
        RankedEntry(rank=position, video_id=result.video_id, value=value, result=result)
        for position, (result, value) in enumerate(rankable, start=1)
    ]


def _metric_value(result: GrowthResult, ranking_type: str) -> float | None:
    """Return the value result should be ranked by, or None if not rankable for ranking_type."""
    if ranking_type == MOST_VIEWED:
        return result.latest.view_count if result.latest.status == STATUS_OK else None
    if ranking_type == FASTEST_GROWING:
        return result.growth_percent
    expected_period = _PERIOD_TRENDING_TYPES[ranking_type]
    if result.period != expected_period:
        return None
    return result.growth
