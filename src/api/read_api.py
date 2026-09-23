"""Read API request handling (Roadmap 3.4/4.1): validate a query, compute
growth or ranked trending, normalize a response.

Pure request-handling logic, wired to real storage — but with no AWS Lambda
or API Gateway dependency of its own, matching lambda_handler.py's pattern
(Roadmap 2.2): this module is the part that's fully testable locally, and an
actual Lambda entry point/API Gateway route in front of it is a deployment
step, not additional logic. `get_video_growth` mirrors a single-video growth
lookup; `get_creator_trending`/`get_organization_trending` mirror Roadmap
4.1's `GET /creators/{creatorId}/trending` and
`GET /organizations/{organization}/trending`, wiring 3.2/3.3's `trending.py`
ranking logic (previously untested/unwired from this module) to real
storage the same way `get_video_growth` already does.

`earliest_available_date` uses each video's own Video.discovered_at (Roadmap
1.5/2.3) when present, falling back to the global
view_growth_analytics.COLLECTION_START_DATE only for a Video Master record
written before that field existed. This keeps a video onboarded
significantly after project start (Roadmap 3.1's hololive EN/ID/VSPO EN
example, onboarded 2026-08-31) correctly reported `not_available` for dates
before its own onboarding, rather than the less precise `pending`.
"""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from tracking.creator_master import Creator, load_creators
from analytics.history_ranking import ALL_PERIOD, PERIODS as SUMMARY_PERIODS
from analytics.trending import (
    DAILY_TRENDING,
    RANKING_TYPES,
    SEVEN_DAY_TRENDING,
    THIRTY_DAY_TRENDING,
    RankedEntry,
)
from analytics.trending_cache_keys import (
    CANONICAL_CACHE_TIME_ZONE,
    creator_summary_cache_key,
    organization_leaderboard_cache_key,
    topic_leaderboard_cache_key,
    trending_cache_key,
)
from tracking.video_master import Video
from tracking.video_topics import TOPIC_IDS
from analytics.view_growth_analytics import (
    COLLECTION_START_DATE,
    PERIOD_DAYS,
    GrowthResult,
    InvalidTimeZoneError,
    calculate_growth,
    comparison_date,
    validate_time_zone,
)

if os.environ.get("YOBI_STORAGE_BACKEND") == "dynamodb":
    from stores.dynamodb_store import get_cached_trending, get_snapshot, get_video, get_videos_by_creator
else:
    from stores.snapshot_store import get_snapshot
    from tracking.video_master import get_video, get_videos_by_creator

    get_cached_trending = None  # no cache table in local/JSON dev, and no live fallback (V5.9) —
    # get_creator_trending/get_organization_trending always raise RankingNotReadyError here

# Reverse of trending.py's private period->ranking-type map (Roadmap 3.2/3.3):
# a period-trending ranking type only ranks GrowthResults computed for its
# matching period, since rank_videos filters by result.period internally.
_RANKING_TYPE_REQUIRED_PERIOD = {
    DAILY_TRENDING: "1d",
    SEVEN_DAY_TRENDING: "7d",
    THIRTY_DAY_TRENDING: "30d",
}
_PERIOD_DEFAULT_RANKING_TYPE = {period: ranking_type for ranking_type, period in _RANKING_TYPE_REQUIRED_PERIOD.items()}


class ClientError(ValueError):
    """A clean, safe-to-surface 4xx error for a malformed/invalid request.

    Every query parameter is untrusted input from a public URL (Roadmap
    3.4): this is raised instead of letting a malformed value reach any
    parsing/lookup code that could otherwise raise an unhandled exception
    (crashing the Lambda) or leak an internal stack trace. Applies equally
    to a genuine typo, an automated scanner probing the endpoint, or a
    deliberate attempt to break the parser.
    """


class VideoNotFoundError(ClientError):
    """Raised when the requested videoId does not exist in Video Master."""


class TrendingNotReadyError(Exception):
    """No longer raised by any code path (V5.9): the request-time live
    ranking fallback and its oversized-catalog guard were removed once the
    public trending API became cache-only (see RankingNotReadyError, which
    a genuine cache miss raises instead). Kept only because api_handler.py
    still maps it defensively to a 503, in case a future caller needs this
    distinct "well-formed but refused" shape again.
    """


class ScopeNotFoundError(ClientError):
    """Raised when a cache-only endpoint's creatorId/organization doesn't exist.

    Checked against Creator Master (a bundled local file, not a DynamoDB
    read — see get_creator_summary/get_organization_leaderboard) before
    ever touching YobiTrendingCache, so an unknown scope gets a clean 404
    instead of being indistinguishable from "this real scope just hasn't
    been computed yet today" (RankingNotReadyError, 503).
    """


class RankingNotReadyError(Exception):
    """Raised by a cache-only endpoint (get_creator_summary/get_organization_
    leaderboard) on a genuine YobiTrendingCache miss for an otherwise valid,
    existing scope/period/reportDate.

    Deliberately not a ClientError subclass, the same reasoning as
    TrendingNotReadyError: the request is well-formed and the scope is
    real — the server just hasn't computed today's ranking for it yet (or
    this reportDate is outside the pipeline's own retention). Never a
    signal to fall back to live computation — these endpoints have no live
    fallback at all. api_handler.py maps this to a 503 with a
    machine-readable "code": "RANKING_NOT_READY", distinct from
    TrendingNotReadyError's own plain 503 (a different endpoint family
    with a different meaning: "too large to compute on demand" there,
    "not computed yet" here).
    """


def parse_report_date(raw: Any) -> date:
    """Validate and parse a reportDate query parameter into a real calendar date.

    Python 3.11+'s date.fromisoformat() also accepts non-canonical ISO 8601
    forms this API does not — a bare "20260901" (no dashes) or an ISO
    week-date like "2026-W01-1" both parse without error. Round-tripping
    through isoformat() rejects anything that isn't exactly YYYY-MM-DD, since
    this value is untrusted public-URL input and the contract is that exact
    format, not "anything date.fromisoformat happens to accept".
    """
    if not isinstance(raw, str) or not raw:
        raise ClientError("reportDate is required and must be a string in YYYY-MM-DD format")
    try:
        parsed = date.fromisoformat(raw)
    except ValueError:
        raise ClientError(f"reportDate is not a valid YYYY-MM-DD date: {raw!r}") from None
    if parsed.isoformat() != raw:
        raise ClientError(f"reportDate must be in canonical YYYY-MM-DD format: {raw!r}")
    return parsed


def parse_time_zone(raw: Any) -> str:
    """Validate a timeZone query parameter is a real IANA zone name, returning it unchanged."""
    if not isinstance(raw, str) or not raw:
        raise ClientError("timeZone is required and must be a non-empty IANA zone name string")
    try:
        validate_time_zone(raw)
    except InvalidTimeZoneError:
        raise ClientError(f"timeZone is not a valid IANA time zone: {raw!r}") from None
    return raw


def parse_period(raw: Any) -> str:
    """Validate a period query parameter is one of the supported 1d/7d/30d values."""
    if not isinstance(raw, str) or raw not in PERIOD_DAYS:
        raise ClientError(f"period must be one of {sorted(PERIOD_DAYS)}, got {raw!r}")
    return raw


def parse_summary_period(raw: Any) -> str:
    """Validate an optional period query parameter for the cache-only
    creator-summary/organization-leaderboard endpoints.

    A deliberately separate function from parse_period — not parse_period
    widened to accept a 4th value — so the existing /trending endpoints'
    own period whitelist (1d/7d/30d only) can never be accidentally loosened
    to also accept "all" as a side effect of this one. Accepts
    history_ranking.PERIODS (1d/7d/30d/all). Absent/empty defaults to
    "all" — the one period that's always available from Day 1 of
    collection (history_ranking.CreatorPeriodPartial.is_complete never
    needs an anchor for it), a reasonable default for a caller that just
    wants "this creator's/organization's overall standing" without
    committing to a specific growth window.
    """
    if raw is None or raw == "":
        return ALL_PERIOD
    if not isinstance(raw, str) or raw not in SUMMARY_PERIODS:
        raise ClientError(f"period must be one of {sorted(SUMMARY_PERIODS)}, got {raw!r}")
    return raw


# Roadmap 5.3's "abuse containment": every real videoId/creatorId/organization
# value in this project is a short human- or YouTube-assigned identifier (a
# YouTube video/channel ID is ~11-24 characters; a creator/org slug is
# shorter still) — nothing legitimate is anywhere near this long. Rejecting
# an oversized value here is cheap input hygiene against a client sending a
# multi-kilobyte garbage string as one of these identifiers, before it can
# reach a string comparison/log line/downstream lookup sized to it.
MAX_IDENTIFIER_LENGTH = 128


def parse_video_id(raw: Any) -> str:
    """Validate a videoId query parameter is a non-empty string of a plausible length."""
    if not isinstance(raw, str) or not raw:
        raise ClientError("videoId is required and must be a non-empty string")
    if len(raw) > MAX_IDENTIFIER_LENGTH:
        raise ClientError(f"videoId must be at most {MAX_IDENTIFIER_LENGTH} characters, got {len(raw)}")
    return raw


def parse_creator_id(raw: Any) -> str:
    """Validate a creatorId query parameter is a non-empty string of a plausible length.

    Actual existence is checked against Creator Master by the caller (a
    syntactically valid but unknown creatorId is a separate ClientError),
    not hardcoded here.
    """
    if not isinstance(raw, str) or not raw:
        raise ClientError("creatorId is required and must be a non-empty string")
    if len(raw) > MAX_IDENTIFIER_LENGTH:
        raise ClientError(f"creatorId must be at most {MAX_IDENTIFIER_LENGTH} characters, got {len(raw)}")
    return raw


def parse_organization(raw: Any) -> str:
    """Validate an organization query parameter is a non-empty string of a plausible length.

    Not validated against a hardcoded {"hololive", "vspo"} set (Roadmap
    1.3: organizations are data, not business logic) — an organization with
    no matching Creator Master records is rejected by the caller instead.
    """
    if not isinstance(raw, str) or not raw:
        raise ClientError("organization is required and must be a non-empty string")
    if len(raw) > MAX_IDENTIFIER_LENGTH:
        raise ClientError(f"organization must be at most {MAX_IDENTIFIER_LENGTH} characters, got {len(raw)}")
    return raw


def parse_ranking_type(raw: Any, *, period: str) -> str:
    """Validate an optional rankingType query parameter, defaulting per period.

    Absent/empty defaults to the period-trending type matching `period`
    (Roadmap 4.1's `?period=7d` trending examples carry no separate ranking
    selector — the period itself implies "the 7-day growth trending list").
    An explicitly-passed value must be one of trending.RANKING_TYPES, and if
    it's a period-trending type it must match the requested `period` —
    otherwise it can never rank anything, since rank_videos only keeps
    results whose own `period` equals the type's expected period.
    """
    if raw is None or raw == "":
        return _PERIOD_DEFAULT_RANKING_TYPE[period]
    if not isinstance(raw, str) or raw not in RANKING_TYPES:
        raise ClientError(f"rankingType must be one of {sorted(RANKING_TYPES)}, got {raw!r}")
    required_period = _RANKING_TYPE_REQUIRED_PERIOD.get(raw)
    if required_period is not None and required_period != period:
        raise ClientError(f"rankingType {raw!r} requires period={required_period!r}, got period={period!r}")
    return raw


# No real page of trending results is ever this deep (Roadmap 5.3's
# "bounded reads only" for public routes) — a caller asking for more is
# almost certainly a mistake or a probe, not a legitimate UI need.
MAX_LIMIT = 100


def parse_limit(raw: Any) -> int | None:
    """Validate an optional limit query parameter is a positive integer at most MAX_LIMIT, or None if absent."""
    if raw is None or raw == "":
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise ClientError(f"limit must be a positive integer, got {raw!r}") from None
    if isinstance(raw, bool) or value <= 0:
        raise ClientError(f"limit must be a positive integer, got {raw!r}")
    if value > MAX_LIMIT:
        raise ClientError(f"limit must be at most {MAX_LIMIT}, got {value!r}")
    return value


def get_video_growth(query: dict[str, Any]) -> dict[str, Any]:
    """Validate a raw analytics query and return its normalized Roadmap 3.4 response.

    `query` is the untrusted request as a plain dict of string values (e.g.
    API Gateway's queryStringParameters) with at least `videoId`,
    `reportDate`, `timeZone`, and `period`. Raises ClientError/
    VideoNotFoundError for anything invalid; a caller maps those to an HTTP
    4xx response rather than letting them propagate as a 500.
    """
    video_id = parse_video_id(query.get("videoId"))
    report_date = parse_report_date(query.get("reportDate"))
    time_zone = parse_time_zone(query.get("timeZone"))
    period = parse_period(query.get("period"))

    video = get_video(video_id)
    if video is None:
        raise VideoNotFoundError(f"No video found for videoId {video_id!r}")

    comp_date = comparison_date(report_date, period)
    result = calculate_growth(
        video_id=video_id,
        report_date=report_date,
        period=period,
        latest_snapshot=get_snapshot(video_id, report_date),
        comparison_snapshot=get_snapshot(video_id, comp_date),
        earliest_available_date=_earliest_available_date_for(video),
    )

    return _to_response(result, video=video, creator=_find_creator(video.creator_id), time_zone=time_zone)


def _cached_trending(
    *, scope_type: str, scope_value: str, report_date: date, time_zone: str, period: str, ranking_type: str, limit: int | None
) -> dict[str, Any] | None:
    """Return a cached trending response if one exists for this exact scope/period/
    rankingType/reportDate, else None (a genuine miss — the public trending
    API is cache-only as of V5.9, with no live fallback to fall through to).

    Only ever attempted in the canonical cache time zone —
    trending_precompute.py/ranking_reducer.py only ever write for
    CANONICAL_CACHE_TIME_ZONE's own day boundary, so a request in any other
    time zone can never be satisfied by this cache and is treated as a miss
    without even building a key. An omitted `limit` no longer bypasses the
    cache: it still looks up the same canonical entry and returns it bounded
    by MAX_LIMIT, the same cap the writer itself already enforces (so this
    is a no-op slice in practice, never a truncation of real data) — never a
    live recomputation. An explicit `limit` slices the same cached rows to
    fewer.
    """
    if get_cached_trending is None or time_zone != CANONICAL_CACHE_TIME_ZONE:
        return None
    key = trending_cache_key(
        scope_type=scope_type, scope_value=scope_value, period=period, ranking_type=ranking_type, report_date=report_date
    )
    cached = get_cached_trending(key)
    if cached is None:
        return None
    effective_limit = limit if limit is not None else MAX_LIMIT
    # The cached payload's own top-level lastUpdatedAt is the oldest
    # timestamp across all MAX_LIMIT cached rows — after truncating to the
    # effective limit, that aggregate can point at a row no longer in
    # results, so it must be recomputed from just the rows actually
    # returned.
    results = cached["results"][:effective_limit]
    timestamps = [row["lastUpdatedAt"] for row in results if row.get("lastUpdatedAt") is not None]
    return {
        **cached,
        "results": results,
        "lastUpdatedAt": min(timestamps, key=datetime.fromisoformat) if timestamps else None,
    }


def get_creator_trending(query: dict[str, Any]) -> dict[str, Any]:
    """Validate a trending query for one creator and return a ranked Roadmap 4.1/3.2 response.

    `query` needs at least `creatorId`, `reportDate`, `timeZone`, and
    `period`; `rankingType` and `limit` are optional. Mirrors
    `GET /creators/{creatorId}/trending?period=7d`.

    Cache-only (V5.9): reads YobiTrendingCache via `_cached_trending` and
    nothing else — cost never scales with this creator's own catalog size.
    A genuine cache miss raises RankingNotReadyError (503,
    code="RANKING_NOT_READY") instead of computing anything live.
    """
    creator_id = parse_creator_id(query.get("creatorId"))
    report_date = parse_report_date(query.get("reportDate"))
    time_zone = parse_time_zone(query.get("timeZone"))
    period = parse_period(query.get("period"))
    ranking_type = parse_ranking_type(query.get("rankingType"), period=period)
    limit = parse_limit(query.get("limit"))

    creator = _find_creator(creator_id)
    if creator is None:
        raise ClientError(f"No creator found for creatorId {creator_id!r}")

    cached = _cached_trending(
        scope_type="creator",
        scope_value=creator_id,
        report_date=report_date,
        time_zone=time_zone,
        period=period,
        ranking_type=ranking_type,
        limit=limit,
    )
    if cached is not None:
        return cached

    raise RankingNotReadyError(
        f"Trending for creatorId={creator_id!r} period={period!r} rankingType={ranking_type!r} "
        f"reportDate={report_date.isoformat()!r} is not yet computed"
    )


def get_organization_trending(query: dict[str, Any]) -> dict[str, Any]:
    """Validate a trending query across one organization and return a ranked Roadmap 4.1/3.3 response.

    `query` needs at least `organization`, `reportDate`, `timeZone`, and
    `period`; `rankingType` and `limit` are optional. Mirrors
    `GET /organizations/{organization}/trending?period=1d`.

    Cache-only (V5.9): reads YobiTrendingCache via `_cached_trending` and
    nothing else — cost never scales with the organization's member/catalog
    size. A genuine cache miss raises RankingNotReadyError (503,
    code="RANKING_NOT_READY") instead of computing anything live.
    """
    organization = parse_organization(query.get("organization"))
    report_date = parse_report_date(query.get("reportDate"))
    time_zone = parse_time_zone(query.get("timeZone"))
    period = parse_period(query.get("period"))
    ranking_type = parse_ranking_type(query.get("rankingType"), period=period)
    limit = parse_limit(query.get("limit"))

    creator_ids = {creator.creator_id for creator in load_creators() if creator.organization == organization}
    if not creator_ids:
        raise ClientError(f"No creators found for organization {organization!r}")

    cached = _cached_trending(
        scope_type="org",
        scope_value=organization,
        report_date=report_date,
        time_zone=time_zone,
        period=period,
        ranking_type=ranking_type,
        limit=limit,
    )
    if cached is not None:
        return cached

    raise RankingNotReadyError(
        f"Trending for organization={organization!r} period={period!r} rankingType={ranking_type!r} "
        f"reportDate={report_date.isoformat()!r} is not yet computed"
    )


def _today_in_canonical_time_zone() -> date:
    """Today's date in the cache's own canonical time zone (Asia/Tokyo) —
    the same "now in Asia/Tokyo" convention execution_lock.
    canonicalize_report_date falls back to when a daily execution's own
    input carries no explicit `date`, reused here for a reportDate query
    parameter that was simply omitted."""
    return datetime.now(ZoneInfo(CANONICAL_CACHE_TIME_ZONE)).date()


def get_creator_summary(query: dict[str, Any]) -> dict[str, Any]:
    """Cache-only creator summary (Roadmap 5.x): viewSum/coverage/topVideo/top10
    for one creator/period/reportDate, read directly from YobiTrendingCache.

    `query` needs `creatorId`; `period` defaults to "all" (see
    parse_summary_period), `reportDate` defaults to today in
    CANONICAL_CACHE_TIME_ZONE. Never falls back to live computation: a
    genuine cache miss raises RankingNotReadyError (503), not a
    recomputation — this endpoint has no history_worker.py/S3 dependency
    at all, only Creator Master (a local file) and one YobiTrendingCache
    GetItem.

    creatorId existence is checked against Creator Master *before* ever
    building a cache key or touching YobiTrendingCache, so an unknown
    creatorId gets a clean 404 (ScopeNotFoundError) instead of being
    indistinguishable from "this real creator just isn't cached yet today"
    (RankingNotReadyError, 503).
    """
    creator_id = parse_creator_id(query.get("creatorId"))
    period = parse_summary_period(query.get("period"))
    raw_report_date = query.get("reportDate")
    report_date = parse_report_date(raw_report_date) if raw_report_date else _today_in_canonical_time_zone()

    if _find_creator(creator_id) is None:
        raise ScopeNotFoundError(f"No creator found for creatorId {creator_id!r}")

    if get_cached_trending is None:
        raise RankingNotReadyError(
            f"Creator summary for creatorId={creator_id!r} period={period!r} "
            f"reportDate={report_date.isoformat()!r} is not yet computed"
        )
    key = creator_summary_cache_key(creator_id=creator_id, period=period, report_date=report_date)
    cached = get_cached_trending(key)
    if cached is None:
        raise RankingNotReadyError(
            f"Creator summary for creatorId={creator_id!r} period={period!r} "
            f"reportDate={report_date.isoformat()!r} is not yet computed"
        )
    return cached


def get_organization_leaderboard(query: dict[str, Any]) -> dict[str, Any]:
    """Cache-only organization leaderboard (Roadmap 5.x): byTotalViews/
    byTopVideo/coverage for one organization/period/reportDate, read
    directly from YobiTrendingCache.

    Same cache-only contract as get_creator_summary — see its own
    docstring. `organization` existence is checked the same way
    get_organization_trending already does (any Creator Master record with
    a matching organization), before ever touching YobiTrendingCache.

    For period "all", each byTotalViews row also carries totalViews,
    videoCount and averageViewsPerVideo. An omitted reportDate serves the
    newest cached report within LATEST_REPORT_LOOKBACK_DAYS; an explicit one
    requests exactly that date.
    """
    organization = parse_organization(query.get("organization"))
    period = parse_summary_period(query.get("period"))
    report_dates = _leaderboard_report_dates(query.get("reportDate"))

    has_any_creator = any(creator.organization == organization for creator in load_creators())
    if not has_any_creator:
        raise ScopeNotFoundError(f"No creators found for organization {organization!r}")

    _, [payload] = _read_organization_leaderboards([organization], period, report_dates)
    if period == ALL_PERIOD:
        return {**payload, "byTotalViews": [_with_all_period_metrics(row) for row in payload["byTotalViews"]]}
    return payload


def get_global_leaderboard(query: dict[str, Any]) -> dict[str, Any]:
    """Cache-only creator ranking across every organization in Creator Master.

    `GET /leaderboard` is the unscoped counterpart of
    `GET /organizations/{organization}/leaderboard`: it merges each
    organization's cached leaderboard rows and re-ranks them. For period
    "all" it also returns `byAverageViewsPerVideo`; growth periods carry no
    average.

    Population is whatever the organization leaderboards contain: every
    Creator Master creator with collected videos, including graduated
    creators and group/staff channels, and every video the daily collection
    returned (no Shorts/live/members-only filtering). It is not limited to
    active individual members.
    """
    period = parse_summary_period(query.get("period"))
    report_dates = _leaderboard_report_dates(query.get("reportDate"))

    creators = {creator.creator_id: creator for creator in load_creators()}
    organizations = sorted({creator.organization for creator in creators.values()})
    report_date, payloads = _read_organization_leaderboards(organizations, period, report_dates)

    rows = []
    for payload in payloads:
        for row in payload["byTotalViews"]:
            creator = creators.get(row["creatorId"])
            rows.append({**row, "organization": payload["organization"], "branch": creator.branch if creator else None})
    if period == ALL_PERIOD:
        rows = [_with_all_period_metrics(row) for row in rows]

    result = {
        "period": period,
        "reportDate": report_date.isoformat(),
        "organizations": organizations,
        "memberCount": sum(payload["memberCount"] for payload in payloads),
        "completeMemberCount": sum(payload["completeMemberCount"] for payload in payloads),
        "catalogVideoCount": sum(payload["catalogVideoCount"] for payload in payloads),
        "eligibleVideoCount": sum(payload["eligibleVideoCount"] for payload in payloads),
        "isComplete": all(payload["isComplete"] for payload in payloads),
        "byTotalViews": _rank_rows(rows, "value"),
    }
    if period == ALL_PERIOD:
        result["byAverageViewsPerVideo"] = _rank_rows(rows, "averageViewsPerVideo")
    return result


def get_topic_leaderboard(query: dict[str, Any]) -> dict[str, Any]:
    """Cache-only global (every organization combined) creator leaderboard for
    one canonical video topic (Topic Phase 3, #6/#7): topicTotalViews/
    topicVideoCount/topicAverageViewsPerVideo per creator, ranked two ways.

    `query` needs `topic`; `reportDate` and `organization` are optional.
    period="all" only — Topic Phase 3 deliberately does not compute topic
    growth periods (see the feature's own report); an explicitly-passed
    period other than "all" is a ClientError, not silently coerced.

    `topic` is validated against tracking.video_topics.TOPIC_IDS, the same
    canonical taxonomy GET /topics itself serves — a closed enum, like
    period/rankingType, not Creator-Master-style existence data, so an
    unknown topic is a plain ClientError (400) the same way parse_period/
    parse_ranking_type reject an unrecognized fixed value, not
    ScopeNotFoundError (404, reserved for a syntactically valid but
    nonexistent creatorId/organization).

    An omitted reportDate serves the newest cached report within
    LATEST_REPORT_LOOKBACK_DAYS, exactly like get_organization_leaderboard/
    get_global_leaderboard; an explicit reportDate never falls back.

    `?organization=hololive`/`?organization=vspo` optionally filters and
    re-ranks the already-cached global rows in memory (#8) — no separate
    cache entry, no extra read, since every cached row already carries its
    own `organization`.
    """
    topic = query.get("topic")
    if topic not in TOPIC_IDS:
        raise ClientError(f"topic must be one of {sorted(TOPIC_IDS)}, got {topic!r}")
    raw_period = query.get("period")
    if raw_period not in (None, "", ALL_PERIOD):
        raise ClientError(f"period must be {ALL_PERIOD!r} for a topic leaderboard, got {raw_period!r}")
    report_dates = _leaderboard_report_dates(query.get("reportDate"))

    payload = None
    if get_cached_trending is not None:
        for candidate_date in report_dates:
            cached = get_cached_trending(
                topic_leaderboard_cache_key(topic=topic, period=ALL_PERIOD, report_date=candidate_date)
            )
            if cached is not None:
                payload = cached
                break
    if payload is None:
        raise RankingNotReadyError(
            f"Topic leaderboard for topic={topic!r} period={ALL_PERIOD!r} "
            f"reportDate={report_dates[0].isoformat()!r} is not yet computed"
        )

    raw_organization = query.get("organization")
    if raw_organization:
        organization = parse_organization(raw_organization)
        by_total_views = _rank_topic_rows(payload["byTotalViews"], organization, "topicTotalViews")
        payload = {
            **payload,
            "creatorCount": len(by_total_views),
            "videoCount": sum(row["topicVideoCount"] for row in by_total_views),
            "byTotalViews": by_total_views,
            "byAverageViewsPerVideo": _rank_topic_rows(
                payload["byAverageViewsPerVideo"], organization, "topicAverageViewsPerVideo"
            ),
        }
    return payload


def _rank_topic_rows(rows: list[dict[str, Any]], organization: str, field: str) -> list[dict[str, Any]]:
    """Filter a cached topic leaderboard's rows to one organization and re-rank
    them within that subset (#8) — rank 1 is that organization's own top
    creator for this topic, not its original global rank."""
    return _rank_rows([row for row in rows if row["organization"] == organization], field)


# The daily pipeline finishes around 18:00 JST, so an omitted reportDate would
# otherwise miss until then; it serves the newest report found in this window.
LATEST_REPORT_LOOKBACK_DAYS = 3


def _leaderboard_report_dates(raw_report_date: Any) -> list[date]:
    if raw_report_date:
        return [parse_report_date(raw_report_date)]
    today = _today_in_canonical_time_zone()
    return [today - timedelta(days=offset) for offset in range(LATEST_REPORT_LOOKBACK_DAYS)]


def _read_organization_leaderboards(
    organizations: list[str], period: str, report_dates: list[date]
) -> tuple[date, list[dict[str, Any]]]:
    """Return the first report date, newest first, with every organization's leaderboard cached.

    All organizations must come from the same date so a merge never mixes days.
    """
    if get_cached_trending is not None:
        for report_date in report_dates:
            payloads = [
                get_cached_trending(
                    organization_leaderboard_cache_key(organization=organization, period=period, report_date=report_date)
                )
                for organization in organizations
            ]
            if None not in payloads:
                return report_date, payloads
    raise RankingNotReadyError(
        f"Organization leaderboard for organizations={organizations!r} period={period!r} "
        f"reportDate={report_dates[0].isoformat()!r} is not yet computed"
    )


def _with_all_period_metrics(row: dict[str, Any]) -> dict[str, Any]:
    total_views, video_count = row["value"], row["catalogVideoCount"]
    return {
        **row,
        "totalViews": total_views,
        "videoCount": video_count,
        "averageViewsPerVideo": total_views / video_count if video_count else None,
    }


def _rank_rows(rows: list[dict[str, Any]], field: str) -> list[dict[str, Any]]:
    ordered = sorted(rows, key=lambda row: (-(row[field] or 0), row["creatorId"]))
    return [{**row, "rank": rank} for rank, row in enumerate(ordered, start=1)]


def _load_videos_for_creators(creator_ids: set[str]) -> list[Video]:
    """Return every tracked video for the creators, one GSI query per creator."""
    videos: list[Video] = []
    for creator_id in creator_ids:
        videos.extend(get_videos_by_creator(creator_id))
    return videos


# Bounds how many concurrent legacy DynamoDB GetItem calls _compute_growth_results
# fans out for one trending request. Each video needs two independent
# snapshot lookups (report_date, comparison_date) with no ordering
# dependency between them — fetching sequentially for an organization with
# thousands of videos is what previously made a real production-scale
# trending request exceed API Gateway's fixed 29-second integration
# timeout; a bounded thread pool (I/O-bound network calls, not CPU-bound
# work, so the GIL is not a limiting factor here) brings that well under it
# without needing a schema change to Video Master.
#
_SNAPSHOT_FETCH_WORKERS = 100
def _compute_growth_results(
    videos: list[Video], *, report_date: date, period: str, executor: ThreadPoolExecutor | None = None
) -> list[GrowthResult]:
    """Compute one GrowthResult per candidate video for the same (report_date, period) comparison window.

    This legacy fallback considers every supplied video. The scheduled S3
    pipeline performs the same exact-anchor calculation shard-by-shard and
    bounds only its final Top-N output.

    `executor`: a live request handler (get_creator_trending/
    get_organization_trending) calls this once per request and leaves this
    None, so a fresh, self-managed pool is created and torn down here.
    trending_precompute.py's run() calls this hundreds of times in one
    Lambda invocation and passes its own single shared executor instead —
    2026-09-05: creating a fresh 100-worker ThreadPoolExecutor (each worker
    lazily creating its own thread-local boto3 DynamoDB resource and
    connection pool, dynamodb_store._resource) on every one of ~342 calls,
    then tearing it all down, accumulated enough abandoned thread/connection
    state across the run to exhaust the Lambda's own 1024MB and still time
    out at 900s — reusing one pool for the whole run keeps that resource
    creation bounded by worker count, not by call count.
    """
    # Architecture reset: exact ranking considers every successfully
    # collected tracked video. Hot/Warm/Cold and approximate candidate caps
    # no longer determine participation.
    candidates = list(videos)
    comp_date = comparison_date(report_date, period)

    def _fetch_snapshot_pair(video: Video) -> tuple[Any, Any]:
        return get_snapshot(video.video_id, report_date), get_snapshot(video.video_id, comp_date)

    if executor is not None:
        snapshot_pairs = list(executor.map(_fetch_snapshot_pair, candidates))
    else:
        with ThreadPoolExecutor(max_workers=_SNAPSHOT_FETCH_WORKERS) as owned_executor:
            snapshot_pairs = list(owned_executor.map(_fetch_snapshot_pair, candidates))

    return [
        calculate_growth(
            video_id=video.video_id,
            report_date=report_date,
            period=period,
            latest_snapshot=latest_snapshot,
            comparison_snapshot=comparison_snapshot,
            earliest_available_date=_earliest_available_date_for(video),
        )
        for video, (latest_snapshot, comparison_snapshot) in zip(candidates, snapshot_pairs)
    ]


def _earliest_available_date_for(video: Video) -> date:
    """The earliest report date this video can have real snapshot data for.

    Uses the video's own discovered_at (when this project started tracking
    it) so a video onboarded after COLLECTION_START_DATE correctly reports
    `not_available` rather than `pending` for dates before its own
    onboarding. Falls back to COLLECTION_START_DATE for a Video Master
    record written before discovered_at existed.
    """
    if video.discovered_at is None:
        return COLLECTION_START_DATE
    return datetime.fromisoformat(video.discovered_at).date()


def _trending_response(
    ranked: list[RankedEntry],
    *,
    scope: dict[str, str],
    report_date: date,
    period: str,
    ranking_type: str,
    time_zone: str,
) -> dict[str, Any]:
    """Build the normalized Roadmap 4.1/3.2/3.3 trending response dict from a ranked entry list."""
    return {
        "timeZone": time_zone,
        "reportDate": report_date.isoformat(),
        "comparisonDate": comparison_date(report_date, period).isoformat(),
        "period": period,
        "rankingType": ranking_type,
        "lastUpdatedAt": _aggregate_last_updated_at(ranked),
        **scope,
        "results": [_ranked_entry_to_dict(entry) for entry in ranked],
    }


def _aggregate_last_updated_at(ranked: list[RankedEntry]) -> str | None:
    """The trending list's own freshness: the oldest lastUpdatedAt among its results.

    A list is only as fresh as its stalest entry — reporting the newest
    entry's timestamp would overstate how current the rest of the list is.
    None (Roadmap 3.4's own "no value" convention) when ranked is empty or
    no entry carries a timestamp, rather than fabricating one.
    """
    timestamps = [entry.result.last_updated_at for entry in ranked if entry.result.last_updated_at is not None]
    if not timestamps:
        return None
    # Compare by actual instant, not by string value: two offset-bearing
    # ISO 8601 timestamps with different UTC offsets (e.g. "+09:00" vs
    # "+00:00") don't sort the same lexicographically as they do
    # chronologically. Returns the earliest entry's original string rather
    # than a reformatted one.
    return min(timestamps, key=datetime.fromisoformat)


def _ranked_entry_to_dict(entry: RankedEntry) -> dict[str, Any]:
    """Build one trending response row from a RankedEntry, joining Video/Creator Master for display fields."""
    video = get_video(entry.video_id)
    creator = _find_creator(video.creator_id) if video else None
    return {
        "rank": entry.rank,
        "videoId": entry.video_id,
        "value": entry.value,
        "title": video.title if video else None,
        "creatorId": video.creator_id if video else None,
        "channelName": creator.display_name if creator else None,
        "organization": creator.organization if creator else None,
        "branch": creator.branch if creator else None,
        "groupKey": creator.group_key if creator else None,
        "channelType": creator.channel_type if creator else None,
        "lifecycleStage": creator.lifecycle_stage if creator else None,
        "themeColor": creator.theme_color if creator else None,
        "latestViewCount": entry.result.latest.view_count,
        "lastUpdatedAt": entry.result.last_updated_at,
        "growth": entry.result.growth,
        "growthPercent": entry.result.growth_percent,
        "status": entry.result.status,
    }


def _find_creator(creator_id: str) -> Creator | None:
    """Return the Creator Master record for creator_id, or None if not found."""
    for creator in load_creators():
        if creator.creator_id == creator_id:
            return creator
    return None


def _to_response(result: GrowthResult, *, video: Video, creator: Creator | None, time_zone: str) -> dict[str, Any]:
    """Build the normalized Roadmap 3.4 response dict from a GrowthResult and its owning video/creator."""
    return {
        "timeZone": time_zone,
        "reportDate": result.report_date,
        "comparisonDate": result.comparison_date,
        "period": result.period,
        "status": result.status,
        "lastUpdatedAt": result.last_updated_at,
        "videoId": result.video_id,
        "title": video.title,
        "creatorId": video.creator_id,
        "channelName": creator.display_name if creator else None,
        "organization": creator.organization if creator else None,
        "branch": creator.branch if creator else None,
        "groupKey": creator.group_key if creator else None,
        "channelType": creator.channel_type if creator else None,
        "lifecycleStage": creator.lifecycle_stage if creator else None,
        "themeColor": creator.theme_color if creator else None,
        "latestViewCount": result.latest.view_count,
        "comparisonViewCount": result.comparison.view_count,
        "growth": result.growth,
        "growthPercent": result.growth_percent,
    }
