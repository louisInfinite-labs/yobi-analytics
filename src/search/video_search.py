"""Video Search (the Video List Multilingual Search feature): one creator's COMPLETE video catalog,
searched by DIRECT TITLE MATCH **union** TOPIC MATCH, with the creator's existing Filter/Sort
(contentType / sort / metric / excludeShorts) applied to the combined result. Video Tag/Topic selection
is deliberately NOT a parameter here -- Search always considers every topic, never just the currently
selected one (see api.read_api.get_creator_video_search's docstring for the product rule this encodes).

FINAL ARCHITECTURE (Video Search frontend-resolved-topics pass): canonical multilingual topic
resolution -- turning a raw query like "VALO" or "エペ" into the topic id(s) it refers to -- is now the
FRONTEND's job, done locally against the SAME authoritative catalog GET /topics exposes (id + labels +
tracking.video_topics.Topic.search_aliases; see frontend/dashboard/src/features/video-search/model/
topicResolution.ts). This module therefore no longer resolves a query to topic ids itself: the request
already carries both pieces the frontend has already decided --

  q        -- the raw text, for direct title matching (ALWAYS present and ALWAYS applied, independently
              of topic resolution; see video_matches_query -- a resolved topic id can never substitute
              for or suppress a title match)
  topicIds -- the canonical ids the frontend already resolved from that SAME q against the catalog
              (empty when the query didn't resolve to any topic, which is not an error -- direct title
              matching still applies on its own)

and `video_matches_query`/`search_creator_video_rows` only need to check "does this row's own
persisted topic belong to the given id set", a plain membership test with no multilingual knowledge of
its own. There is no remaining backend code path that re-derives topic ids from query text: this
module no longer imports tracking.video_topics or search.canonical_topic_matching at all (the
canonical_topic_matching module itself, and this module's own former resolve_query_topics/
resolve_query_topics_with_evidence/matched_topic_aliases_for_row, were deleted as dead code once their
only caller -- this file's own old self-resolution path -- was removed). Topic.search_aliases remains
very much alive: it is what GET /topics now serves to the frontend (api.dashboard_catalog_api.
get_topics), it just has no remaining backend Search-side consumer.

UNION, NOT FALLBACK: a row is included if EITHER its title contains `q` OR its topic is in `topicIds`
-- never "if topic resolved, only match by topic" and never "title OR topic, pick one." Both sources are
evaluated unconditionally; see video_matches_query. Because this is a single boolean OR per row (not two
separately built lists that are then merged), there is no separate "dedupe by videoId" step needed: each
row is visited exactly once, so a row matching both conditions is naturally included only once -- see
video_matches_query's own docstring.

Why the frontend, not the backend, resolves topic ids: the topic catalog (today 8 topics, intended to
grow to a much larger backend-managed catalog later, see docs/) only changes when a creator-management
action adds a topic, not per Search keystroke -- resolving it once per request would be pointless
re-computation. The frontend already needs this same catalog for Tag display and a future Topic Picker,
so sharing ONE downloaded, authoritative copy for all three uses (display, future picker, Search
resolution) avoids a second backend-owned taxonomy duplicated into the request path, which is exactly
what this product has repeatedly guarded against introducing on the FRONTEND side (see topicResolution.ts
for the local resolver, which depends on exactly the same prefix-matching monotonicity property
resolve_canonical_ids_with_evidence used to provide here).
"""

from __future__ import annotations

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


def video_matches_query(row: dict[str, Any], normalized_query: str, topic_ids: frozenset[str]) -> bool:
    """A row matches when its (normalized) title contains `normalized_query` as a substring, OR its
    persisted topic is one `topic_ids` names -- pure OR (UNION semantics), either condition alone is
    enough, and both are always evaluated (never "stop checking title once a topic matched"). An empty
    `normalized_query` always returns False regardless of `topic_ids` -- the same defensive rule as
    before (an accidental empty/whitespace-only Search must never behave like "match everything"), now
    also covering the case of a caller sending topic_ids without a real query. A row with no persisted
    topic can only ever match by title."""
    if not normalized_query:
        return False
    title = normalize_query(row.get("title") or "")
    if normalized_query in title:
        return True
    return bool(topic_ids) and row.get("topic") in topic_ids


def search_creator_video_rows(
    rows: list[dict[str, Any]],
    *,
    raw_query: str,
    topic_ids: frozenset[str] = frozenset(),
    content_type: str = CONTENT_TYPE_SCOPE_ALL,
    live_status: str = LIVE_STATUS_SCOPE_ALL,
    exclude_shorts: bool = True,
    sort: str = SORT_NEWEST,
    metric: str = TOTAL_METRIC,
) -> list[dict[str, Any]]:
    """`rows` is already this one creator's own rows (the caller's job, exactly like
    analytics.video_ranking.rank_video_rows) -- Search is never given a multi-creator row set to filter
    down itself, so "search is scoped to the current creator" is enforced by the caller, not re-checked
    here.

    `topic_ids` are canonical topic ids the CALLER has already resolved from `raw_query` (frontend-side,
    against the authoritative /topics catalog) -- an unknown id (one that matches no real topic) is
    harmless: no row's own `topic` will ever equal it, so it simply contributes nothing, never an error.
    An empty `topic_ids` is the normal "this query didn't resolve to any topic" case, not an error --
    direct title matching still applies on its own (see video_matches_query).

    Filter order: query match (title OR topic, unioned) -> contentType -> excludeShorts -> liveStatus ->
    sort. There is no `topic` TAG parameter: Video Tag/Topic SELECTION never narrows a Search (spec:
    "Search ignores the currently selected Video Tag") -- `topic_ids` here is query-DERIVED, a completely
    different concept from the user's separately-remembered browsing Tag, which the caller must never
    pass through to this parameter.

    `sort`/`metric` mirror the existing Oshi Videos shelf's own Filter/Sort semantics exactly (newest/
    oldest = publishedAt stable sort, mostViews = the existing ranking metric) -- Search introduces no
    relevance ranking of its own; if no special sort is requested the normal default (newest) applies.
    """
    normalized = normalize_query(raw_query)
    matching = [row for row in rows if video_matches_query(row, normalized, topic_ids)]

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
