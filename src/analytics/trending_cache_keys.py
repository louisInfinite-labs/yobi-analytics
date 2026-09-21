"""Cache-key construction for YobiTrendingCache — shared between every writer
and reader of that table, so no two of them ever need to import each other.

Pure string-building only: no AWS dependency, and no other project module
imported. Before this module existed, ranking_reducer.py's persist_rankings()
reached into read_api.py for trending_cache_key via a lazy (inside-function)
import specifically to dodge a circular import — read_api.py owned that
function, and ranking_reducer.py needed it. Adding the new creator-summary/
organization-leaderboard cache keys the other way around (read_api.py
importing from ranking_reducer.py, to serve the new cache-only summary/
leaderboard endpoints) would have completed that cycle for real. Moving every
cache-key builder here — read_api.py and ranking_reducer.py both import from
this module, neither imports the other for this purpose — avoids it entirely.
"""

from __future__ import annotations

from datetime import date

# The scheduled collection/ranking pipeline (history_worker.py/
# ranking_reducer.py) only ever computes and caches results for this time
# zone's own day boundary — read_api.py uses this to decide whether an
# incoming request's own timeZone could ever match a cached entry at all,
# before it even builds a cache key to look up.
CANONICAL_CACHE_TIME_ZONE = "Asia/Tokyo"

_CREATOR_SUMMARY_PREFIX = "creatorSummary"
_ORG_LEADERBOARD_PREFIX = "orgLeaderboard"


def trending_cache_key(*, scope_type: str, scope_value: str, period: str, ranking_type: str, report_date: date) -> str:
    """Build YobiTrendingCache's cacheKey for one scope/period/rankingType/reportDate.

    Always keyed to CANONICAL_CACHE_TIME_ZONE, so a writer and a reader of
    this cache shape always agree on the same key for the same request.
    """
    return f"{scope_type}:{scope_value}:{period}:{ranking_type}:{report_date.isoformat()}:{CANONICAL_CACHE_TIME_ZONE}"


def creator_summary_cache_key(*, creator_id: str, period: str, report_date: date) -> str:
    """Build YobiTrendingCache's cacheKey for one creator/period/reportDate summary.

    A namespace distinct from trending_cache_key's own scope-ranking keys
    (scope_type there is always one of creator/organization/branch/global,
    never the literal string "creatorSummary") — YobiTrendingCache has only
    one key attribute (cacheKey, no sort key), so the whole string must be,
    and is, unique.
    """
    return f"{_CREATOR_SUMMARY_PREFIX}:{creator_id}:{period}:{report_date.isoformat()}"


def organization_leaderboard_cache_key(*, organization: str, period: str, report_date: date) -> str:
    """Build YobiTrendingCache's cacheKey for one organization/period/reportDate leaderboard."""
    return f"{_ORG_LEADERBOARD_PREFIX}:{organization}:{period}:{report_date.isoformat()}"
