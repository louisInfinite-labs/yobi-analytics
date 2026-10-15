"""Video Search (the Video List SearchView): one creator's COMPLETE video catalog, searched by TITLE ONLY, with the creator's existing
Filter/Sort (contentType / sort / metric / excludeShorts) applied to the result. Video Tag/Topic selection is deliberately NOT a
parameter here -- Search always considers every video, never just the currently selected topic.

SearchView and Topic Filter are two different operations. Topic Filter filters by a video's pre-classified canonical topic id. SearchView
never looks at a video's persisted `topic` at all: a video with a missing, wrong or unrelated topic is still found when its title matches,
and a video is never returned merely because its topic matches. The two share only VOCABULARY -- the Topic Catalog's labels and search
aliases -- and that sharing happens on the FRONTEND: it resolves the typed query against the downloaded GET /topics catalog (prefix match
on id / localized labels / aliases) and sends the matching concepts' LITERAL labels and aliases as explicit title-search terms.

The request therefore carries
  q      -- the raw text, ALWAYS present and ALWAYS applied
  terms  -- zero or more already-expanded literal strings (a JSON array of strings; empty is the normal "nothing resolved" case)
and a row matches when its normalized title contains the normalized `q` OR any normalized, de-duplicated term (see video_matches_query).
This module never imports tracking.video_topics, never applies a topic regex, and never falls back to persisted-topic matching.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from analytics.video_ranking import (
    CONTENT_TYPE_SCOPE_ALL,
    CONTENT_TYPE_SHORT,
    LIVE_STATUS_SCOPE_ALL,
    TOTAL_METRIC,
    row_matches_live_status,
)
from search.query_normalization import normalize_query

SORT_NEWEST = "newest"
SORT_OLDEST = "oldest"
SORT_MOST_VIEWS = "mostViews"
VALID_SEARCH_SORTS = frozenset({SORT_NEWEST, SORT_OLDEST, SORT_MOST_VIEWS})


def normalize_terms(raw_terms: Iterable[str]) -> frozenset[str]:
    """The authoritative term set: every term normalized with the same NFKC / whitespace / casefold rules as the query and the titles,
    blank terms dropped and duplicates collapsed (two spellings that normalize identically are one term)."""
    return frozenset(term for term in (normalize_query(raw) for raw in raw_terms) if term)


def video_matches_query(row: dict[str, Any], normalized_query: str, terms: frozenset[str] = frozenset()) -> bool:
    """TITLE-ONLY: a row matches when its normalized title contains `normalized_query` as a substring, OR contains any of `terms` (already
    normalized -- see normalize_terms). The row's persisted `topic` is never read. An empty `normalized_query` never matches, whatever
    `terms` hold (an accidental empty Search must never behave like "match everything")."""
    if not normalized_query:
        return False
    title = normalize_query(row.get("title") or "")
    if normalized_query in title:
        return True
    return any(term in title for term in terms)


def search_creator_video_rows(
    rows: list[dict[str, Any]],
    *,
    raw_query: str,
    terms: Iterable[str] = (),
    content_type: str = CONTENT_TYPE_SCOPE_ALL,
    live_status: str = LIVE_STATUS_SCOPE_ALL,
    exclude_shorts: bool = True,
    sort: str = SORT_NEWEST,
    metric: str = TOTAL_METRIC,
) -> list[dict[str, Any]]:
    """`rows` is already this one creator's own rows (the caller's job, exactly like analytics.video_ranking.rank_video_rows) -- Search is
    never given a multi-creator row set to filter down itself, so "search is scoped to the current creator" is enforced by the caller.

    `terms` are the literal title-search strings the CALLER (the frontend) expanded from the query against the Topic Catalog's labels and
    aliases; they are normalized and de-duplicated here, so duplicate aliases can never produce duplicate results (each row is visited once
    and is either in or out). An empty `terms` is the normal "nothing resolved" case: the raw query still searches titles on its own.

    Filter order: title match (raw query OR any term) -> contentType -> excludeShorts -> liveStatus -> sort. There is no topic parameter
    of any kind: neither the selected Video Tag nor any video's persisted topic influences which rows match.

    `sort`/`metric` mirror the existing Oshi Videos shelf's own Filter/Sort semantics exactly (newest/oldest = publishedAt stable sort,
    mostViews = the existing ranking metric) -- Search introduces no relevance ranking of its own.
    """
    normalized = normalize_query(raw_query)
    normalized_terms = normalize_terms(terms)
    matching = [row for row in rows if video_matches_query(row, normalized, normalized_terms)]

    if content_type != CONTENT_TYPE_SCOPE_ALL:
        matching = [row for row in matching if row.get("contentType") == content_type]
    if exclude_shorts:
        matching = [row for row in matching if row.get("contentType") != CONTENT_TYPE_SHORT]
    if live_status != LIVE_STATUS_SCOPE_ALL:
        matching = [row for row in matching if row_matches_live_status(row, live_status)]

    if sort == SORT_MOST_VIEWS:
        return _sort_by_metric(matching, metric)
    by_video_id = sorted(matching, key=lambda row: row["videoId"])
    dated = [row for row in by_video_id if row.get("publishedAt")]
    undated = [row for row in by_video_id if not row.get("publishedAt")]
    if sort == SORT_OLDEST:
        return sorted(dated, key=lambda row: row["publishedAt"]) + undated
    return sorted(dated, key=lambda row: row["publishedAt"], reverse=True) + undated


def _sort_by_metric(rows: list[dict[str, Any]], metric: str) -> list[dict[str, Any]]:
    """Mirrors analytics.video_ranking.rank_video_rows' own ordering exactly (same sort keys, same
    videoId tie-break, same growth-metric gap exclusion -- a row whose own anchor{metric}ViewCount is
    None is dropped from a growth-metric sort entirely, never given a fabricated baseline) but returns
    the ORIGINAL row dicts rather than rank_video_rows' own rank/anchorViewCount/absoluteGrowth output
    shape: Search's response must stay in ONE consistent row shape across every sort mode, not switch
    shape only for this one option."""
    if metric == TOTAL_METRIC:
        return sorted(rows, key=lambda row: (-row["currentViewCount"], row["videoId"]))
    anchor_field = f"anchor{metric}ViewCount"
    candidates = [row for row in rows if row.get(anchor_field) is not None]
    return sorted(candidates, key=lambda row: (-(row["currentViewCount"] - row[anchor_field]), row["videoId"]))
