"""Read API request handling (Roadmap 3.4/4.1): validate a query, compute
growth, subscriber leaderboard, or video ranking, normalize a response.

Pure request-handling logic, wired to real storage — but with no AWS Lambda
or API Gateway dependency of its own, matching lambda_handler.py's pattern
(Roadmap 2.2): this module is the part that's fully testable locally, and an
actual Lambda entry point/API Gateway route in front of it is a deployment
step, not additional logic. `get_video_growth` mirrors a single-video growth
lookup.

R9 (org-trending retirement): `get_creator_trending`/`get_organization_
trending` (the old cross-creator/org-wide "trending" product, `GET
/creators/{creatorId}/trending`/`GET /organizations/{organization}/trending`)
and their supporting helpers (`_cached_trending`/`_cached_or_archived`,
`parse_organization`/`parse_ranking_type`, the already-dead `_compute_growth_
results`/`_load_videos_for_creators`/`_trending_response`/`_ranked_entry_to_
dict`/`_aggregate_last_updated_at`, `TrendingNotReadyError`) were removed
here once their production frontend consumer was migrated to the two
surviving ranking products (`get_subscriber_leaderboard`, `get_video_
ranking`) and the routes themselves were retired from api_handler.py/
terraform/api_gateway.tf.

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
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from api.holodex_client import holodex_get
from api.holodex_normalization import normalize_holodex_archived_streams_response, normalize_holodex_live_response
from tracking.creator_master import Creator, is_current_member_eligible, is_live_status_polling_eligible, load_creators
from analytics.subscriber_ranking import GROWTH_PERIODS, VALID_SUBSCRIBER_ORGANIZATIONS
from stores.subscriber_ranking_store import S3SubscriberRankingStore
from analytics.video_ranking import CONTENT_TYPE_SCOPE_ALL as VIDEO_RANKING_CONTENT_TYPE_ALL
from analytics.video_ranking import LIVE_STATUS_SCOPE_ALL, VALID_LIVE_STATUS_SCOPES, row_matches_live_status
from analytics.video_ranking import TOPIC_SCOPE_ALL as VIDEO_RANKING_TOPIC_ALL
from analytics.video_ranking import VALID_CONTENT_TYPE_SCOPES as VALID_VIDEO_RANKING_CONTENT_TYPES
from analytics.video_ranking import VALID_METRICS as VALID_VIDEO_RANKING_METRICS
from analytics.video_ranking import VALID_TOPIC_SCOPES as VALID_VIDEO_RANKING_TOPICS
from analytics.video_ranking import rank_video_rows
from stores.video_ranking_store import S3VideoRankingStore
from tracking.video_master import VALID_LIVE_STATUSES, Video
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
    from stores.dynamodb_store import get_snapshot, get_video
else:
    from stores.snapshot_store import get_snapshot
    from tracking.video_master import get_video

# The scheduled collection/ranking pipeline (history_worker.py/
# ranking_reducer.py) only ever computes/persists results for this time
# zone's own day boundary -- an omitted reportDate (get_subscriber_
# leaderboard/get_video_ranking) resolves "today" against this zone.
CANONICAL_CACHE_TIME_ZONE = "Asia/Tokyo"


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


class ScopeNotFoundError(ClientError):
    """Raised when a requested creatorId doesn't resolve to a real, current-member
    creator -- get_recent_streams checks this against Creator Master
    (is_current_member_eligible) before ever calling Holodex, so an unknown or
    ineligible creatorId gets a clean 404 instead of an empty result
    indistinguishable from "this real creator just has no archives right now."
    """


class RankingNotReadyError(Exception):
    """Raised by a cache-only endpoint (get_subscriber_leaderboard/get_video_
    ranking) on a genuine result miss for an otherwise valid, existing
    scope/period/reportDate.

    Deliberately not a ClientError subclass: the request is well-formed and
    the scope is real — the server just hasn't computed today's ranking for
    it yet (or this reportDate is outside the pipeline's own retention).
    Never a signal to fall back to live computation — these endpoints have
    no live fallback at all. api_handler.py maps this to a 503 with a
    machine-readable "code": "RANKING_NOT_READY".
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


# R5: the subscriber leaderboard's own metric enum, distinct from
# parse_period's video-ranking 1d/7d/30d (no shared validator) -- "total"
# has no video-ranking analog at all.
SUBSCRIBER_METRIC_TOTAL = "total"
_VALID_SUBSCRIBER_METRICS = (SUBSCRIBER_METRIC_TOTAL,) + GROWTH_PERIODS


def parse_subscriber_metric(raw: Any) -> str:
    """Validate a required metric query parameter for the subscriber
    leaderboard: exactly one of "total"/"1d"/"7d"/"30d" -- the literal R4
    canonical-result key, so no separate mapping/translation table is
    needed between the query value and which section of the persisted
    result to read.
    """
    if not isinstance(raw, str) or raw not in _VALID_SUBSCRIBER_METRICS:
        raise ClientError(f"metric must be one of {sorted(_VALID_SUBSCRIBER_METRICS)}, got {raw!r}")
    return raw


# "all" is not one of R2's own VALID_SUBSCRIBER_ORGANIZATIONS ("vspo"/
# "hololive" -- real, data-driven organization values) -- it is this read
# API's own filter keyword for "no organization filter", made an explicit,
# spellable value here since R5's own contract names it (ALL/VSPO/Hololive)
# as one of exactly three supported values, not "absent vs present".
SUBSCRIBER_ORGANIZATION_ALL = "all"


def parse_subscriber_organization(raw: Any) -> str:
    """Validate an optional organization filter for the subscriber
    leaderboard: "all" (default; case-insensitive) or one of R2's own
    VALID_SUBSCRIBER_ORGANIZATIONS ("vspo"/"hololive") -- never a silently
    coerced or invented third value. Case-insensitive because this is a
    closed set of exactly three spellable values, the same reasoning
    parse_period already applies to its own fixed enum.
    """
    if raw is None or raw == "":
        return SUBSCRIBER_ORGANIZATION_ALL
    if not isinstance(raw, str):
        raise ClientError(f"organization must be a string, got {raw!r}")
    normalized = raw.strip().lower()
    if normalized == SUBSCRIBER_ORGANIZATION_ALL or normalized in VALID_SUBSCRIBER_ORGANIZATIONS:
        return normalized
    raise ClientError(
        f"organization must be one of {SUBSCRIBER_ORGANIZATION_ALL!r} or "
        f"{sorted(VALID_SUBSCRIBER_ORGANIZATIONS)}, got {raw!r}"
    )


def parse_video_ranking_metric(raw: Any) -> str:
    """Validate a required metric query parameter for the per-creator video
    ranking: exactly one of "total"/"1d"/"7d"/"30d" -- mirrors
    parse_subscriber_metric's own reasoning (the literal canonical-result
    key, no separate mapping table needed)."""
    if not isinstance(raw, str) or raw not in VALID_VIDEO_RANKING_METRICS:
        raise ClientError(f"metric must be one of {sorted(VALID_VIDEO_RANKING_METRICS)}, got {raw!r}")
    return raw


def parse_video_ranking_topic(raw: Any) -> str:
    """Validate an optional topic filter for the per-creator video ranking:
    "all" (default; case-insensitive) or one of the canonical topic ids
    (tracking.video_topics.TOPIC_IDS) -- mirrors parse_subscriber_
    organization's own closed-enum reasoning."""
    if raw is None or raw == "":
        return VIDEO_RANKING_TOPIC_ALL
    if not isinstance(raw, str):
        raise ClientError(f"topic must be a string, got {raw!r}")
    normalized = raw.strip().lower()
    if normalized in VALID_VIDEO_RANKING_TOPICS:
        return normalized
    raise ClientError(f"topic must be one of {sorted(VALID_VIDEO_RANKING_TOPICS)}, got {raw!r}")


def parse_video_ranking_content_type(raw: Any) -> str:
    """Validate an optional contentType filter for the per-creator video
    ranking: "all" (default; case-insensitive) or one of the canonical
    content-type ids (tracking.video_master.VALID_CONTENT_TYPES) -- mirrors
    parse_video_ranking_topic's own closed-enum reasoning. A separate
    parameter from `topic`: delivery format (live archive vs. upload) is an
    independent dimension from game/genre, never folded into the same enum."""
    if raw is None or raw == "":
        return VIDEO_RANKING_CONTENT_TYPE_ALL
    if not isinstance(raw, str):
        raise ClientError(f"contentType must be a string, got {raw!r}")
    normalized = raw.strip().lower()
    if normalized in VALID_VIDEO_RANKING_CONTENT_TYPES:
        return normalized
    raise ClientError(f"contentType must be one of {sorted(VALID_VIDEO_RANKING_CONTENT_TYPES)}, got {raw!r}")


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


def _today_in_canonical_time_zone() -> date:
    """Today's date in the cache's own canonical time zone (Asia/Tokyo) —
    the same "now in Asia/Tokyo" convention execution_lock.
    canonicalize_report_date falls back to when a daily execution's own
    input carries no explicit `date`, reused here for a reportDate query
    parameter that was simply omitted."""
    return datetime.now(ZoneInfo(CANONICAL_CACHE_TIME_ZONE)).date()


def get_subscriber_leaderboard(query: dict[str, Any]) -> dict[str, Any]:
    """Read-only view over the R4 subscriber-leaderboard S3 result (R5):
    ALL/VSPO/Hololive organization filter x Total Subscribers/1d/7d/30d
    growth metric, all derived in memory from the ONE persisted canonical
    result for a report date — never a second/duplicated per-organization
    or per-metric object (R4's own explicit scope; see
    stores.subscriber_ranking_store).

    `query` needs `metric`; `organization` and `reportDate` are optional.
    Mirrors `GET /subscribers/leaderboard?metric=7d&organization=vspo`.

    An explicit reportDate is an exact-date lookup only, no fallback: if
    that one date has no persisted result, this raises RankingNotReadyError
    regardless of what any other date holds (R5's own scope — never a
    nearest-date fallback for a historical request).

    An omitted reportDate means "the latest available result", reusing
    _leaderboard_report_dates/LATEST_REPORT_LOOKBACK_DAYS exactly as-is —
    not a new mechanism (see that constant's own comment for why an omitted
    date needs a lookback at all). This was previously reasoned unnecessary
    here on the theory that R4's own ranking-result build "runs early in the
    day"; that reasoning was wrong. R3/R4's subscriber snapshot+ranking hook
    runs inside the daily_history Step Functions execution's
    AcquireExecutionLock branch, and that whole execution only ever starts
    once per day at 18:00 Asia/Tokyo (terraform/eventbridge.tf's
    aws_scheduler_schedule.daily_collection, cron(0 18 * * ? *)). So for the
    entire day before that day's execution runs, "today"'s subscriber-
    ranking object genuinely does not exist yet — the same pre-collection
    window an omitted reportDate always has to handle. The response's own
    `reportDate` below is always the actual
    persisted result's date (R4's own reportDate field), never the
    request's default/omitted date, so a caller can always tell which day's
    result it actually got.

    A missing result for every candidate date is RankingNotReadyError (503,
    code="RANKING_NOT_READY") — a well-formed request for a real, supported
    metric/organization that just hasn't been computed/persisted yet, the
    exact same shape every other cache-only endpoint in this module already
    uses for "not yet computed", never a fabricated empty leaderboard.

    expectedCreatorCount/observedCreatorCount/missingCreatorCount are
    returned exactly as R4 computed them (against the full roster) — not
    recomputed per organization filter. R4's own persisted result carries
    only one, whole-roster completeness measurement; deriving an
    organization-scoped variant would be a new calculation this endpoint
    does not have the data to perform safely (it would require re-deriving
    which roster creators belong to the filtered organization and cross-
    referencing D0's raw rows, information R4's own result does not carry)
    and is not part of R5's stated response contract.
    """
    metric = parse_subscriber_metric(query.get("metric"))
    organization = parse_subscriber_organization(query.get("organization"))
    report_dates = _leaderboard_report_dates(query.get("reportDate"))

    store = S3SubscriberRankingStore.from_environment_or_default()
    result = None
    for candidate_date in report_dates:
        result = store.read_result(candidate_date)
        if result is not None:
            break
    if result is None:
        raise RankingNotReadyError(
            f"Subscriber leaderboard for metric={metric!r} organization={organization!r} "
            f"reportDate={report_dates[0].isoformat()!r} is not yet computed"
        )

    section = result[metric]
    rows = section["rows"]
    ineligible = section["ineligible"]
    if organization != SUBSCRIBER_ORGANIZATION_ALL:
        rows = _filter_and_rerank_subscriber_rows(rows, organization)
        ineligible = _filter_subscriber_ineligible(ineligible, organization)

    return {
        "reportDate": result["reportDate"],
        "generatedAt": result["generatedAt"],
        "organization": organization,
        "metric": metric,
        "expectedCreatorCount": result["expectedCreatorCount"],
        "observedCreatorCount": result["observedCreatorCount"],
        "missingCreatorCount": result["missingCreatorCount"],
        "rows": rows,
        "ineligible": ineligible,
    }


def _filter_and_rerank_subscriber_rows(rows: list[dict[str, Any]], organization: str) -> list[dict[str, Any]]:
    """The JSON-dict analog of analytics.subscriber_ranking.filter_by_organization,
    applied to an already-persisted R4 result's rows instead of an in-memory
    dataclass list: filtering an already-sorted-by-key sequence preserves
    that same relative order for the retained subsequence (R2's own sorted-
    subsequence proof), so this only ever re-numbers rank starting from 1 —
    never re-sorts by any other field, and never re-derives percentageGrowth
    or any other value."""
    filtered = [row for row in rows if row.get("organization") == organization]
    return [{**row, "rank": rank} for rank, row in enumerate(filtered, start=1)]


def _filter_subscriber_ineligible(ineligible: dict[str, str], organization: str) -> dict[str, str]:
    """Filter an R4 result's ineligible diagnostics to one organization, using
    the authoritative Creator Master registry (_find_creator) to look up
    each ineligible creatorId's real organization — never guessed from the
    creatorId string or its own ineligibility reason. A creatorId Creator
    Master doesn't recognize at all (e.g. one R2 itself already reported as
    creator_not_in_roster) is excluded from every organization-filtered
    view: there is no authoritative organization to attribute it to, so it
    must never leak into a VSPO/Hololive-filtered response (it still
    appears under organization="all", the unfiltered view)."""
    filtered: dict[str, str] = {}
    for creator_id, reason in ineligible.items():
        creator = _find_creator(creator_id)
        if creator is not None and creator.organization == organization:
            filtered[creator_id] = reason
    return filtered


def get_video_ranking(query: dict[str, Any]) -> dict[str, Any]:
    """Read-only view over the video-ranking Phase C per-creator S3 result:
    total (lifetime view count) or 1d/7d/30d growth, optionally filtered by
    topic (game/genre) and/or contentType (live archive vs. upload -- an
    independent dimension from topic), all derived in memory from the ONE
    persisted canonical row set for a creator/report date (Phase C storage
    correction: one row per video, never four separately ranked/duplicated
    row sets). Mirrors
    `GET /creators/{creatorId}/videos/ranking?metric=7d&topic=valorant&contentType=live`.

    Videos never rank across creators (video-ranking's own core product
    rule): this only ever reads the one S3 object already scoped to
    `creatorId` (stores.video_ranking_store keys by creator), never another
    creator's own result.

    An explicit reportDate is an exact-date lookup only, no fallback — same
    contract as get_subscriber_leaderboard. An omitted reportDate reuses
    that same function's own bounded latest-result lookback
    (_leaderboard_report_dates/LATEST_REPORT_LOOKBACK_DAYS), not a second
    mechanism.

    A missing result for every candidate date is RankingNotReadyError (503,
    code="RANKING_NOT_READY") — the same shape every other cache-only
    endpoint in this module already uses for "not yet computed".

    Reads the S3 result only: no VideoMaster Scan, no per-creator-catalog
    live query, no per-video DynamoDB enrichment, no write-on-request. Query params:
    metric (total|1d|7d|30d), topic, contentType and liveStatus (same values as
    GET /creators/{creatorId}/videos/recent), limit (max 100). Always ONE creator's own
    videos, filtered (topic -> contentType -> liveStatus) BEFORE ranking and limit. Topic
    filtering, metric selection, and ranking/sorting are all performed here,
    at read time, over the one persisted canonical row set — see
    analytics.video_ranking.rank_video_rows.
    """
    creator_id = parse_creator_id(query.get("creatorId"))
    metric = parse_video_ranking_metric(query.get("metric"))
    topic = parse_video_ranking_topic(query.get("topic"))
    content_type = parse_video_ranking_content_type(query.get("contentType"))
    live_status = parse_recent_creator_videos_live_status(query.get("liveStatus"))
    limit = parse_limit(query.get("limit")) or MAX_LIMIT
    report_dates = _leaderboard_report_dates(query.get("reportDate"))

    creator = _find_creator(creator_id)
    if creator is None:
        raise ClientError(f"No creator found for creatorId {creator_id!r}")

    store = S3VideoRankingStore.from_environment_or_default()
    result = None
    for candidate_date in report_dates:
        result = store.read_result(candidate_date, creator_id)
        if result is not None:
            break
    if result is None:
        raise RankingNotReadyError(
            f"Video ranking for creatorId={creator_id!r} metric={metric!r} topic={topic!r} "
            f"contentType={content_type!r} liveStatus={live_status!r} "
            f"reportDate={report_dates[0].isoformat()!r} is not yet computed"
        )

    # creator -> topic -> contentType -> liveStatus -> rank -> limit (rank_video_rows filters first, then ranks).
    creator_rows = [row for row in result["videos"] if row.get("creatorId") == creator_id]
    rows = rank_video_rows(creator_rows, metric=metric, topic=topic, content_type=content_type, live_status=live_status)[:limit]

    return {
        "reportDate": result["reportDate"],
        "generatedAt": result["generatedAt"],
        "creatorId": creator_id,
        "metric": metric,
        "topic": topic,
        "contentType": content_type,
        "liveStatus": live_status,
        "rows": rows,
    }


# GET /creators/{creatorId}/videos/recent's own limit -- deliberately its own
# constant, not parse_limit/MAX_LIMIT (that pair backs /videos/ranking's page
# sizing, up to 100 rows of a metric-ranked list) and not RECENT_STREAMS_
# DEFAULT_LIMIT/RECENT_STREAMS_MAX_LIMIT (that pair is GET /recent-streams'
# own Holodex-sourced constant, an unrelated data source). Same product need
# as /recent-streams though (Home's "Latest Live" archive row never needs
# more than ~5 slots), so the same small bound.
RECENT_CREATOR_VIDEOS_DEFAULT_LIMIT = 4
RECENT_CREATOR_VIDEOS_MAX_LIMIT = 20


def parse_recent_creator_videos_limit(raw: Any) -> int:
    """Validate an optional limit query parameter for GET /creators/{creatorId}/videos/recent:
    a positive integer at most RECENT_CREATOR_VIDEOS_MAX_LIMIT, defaulting to
    RECENT_CREATOR_VIDEOS_DEFAULT_LIMIT when absent -- mirrors parse_recent_streams_limit's
    own reasoning for the equivalent Holodex-sourced endpoint."""
    if raw is None or raw == "":
        return RECENT_CREATOR_VIDEOS_DEFAULT_LIMIT
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise ClientError(f"limit must be a positive integer, got {raw!r}") from None
    if isinstance(raw, bool) or value <= 0:
        raise ClientError(f"limit must be a positive integer, got {raw!r}")
    if value > RECENT_CREATOR_VIDEOS_MAX_LIMIT:
        raise ClientError(f"limit must be at most {RECENT_CREATOR_VIDEOS_MAX_LIMIT}, got {value!r}")
    return value


# Same "all" + closed-enum shape as contentType/topic, but a further
# breakdown WITHIN contentType="live" only -- see tracking.video_master.
# VALID_LIVE_STATUSES. Deliberately its own filter, independent of
# contentType and composable with it (contentType=live&liveStatus=completed
# is exactly Home's own "archives only, never the active/upcoming stream"
# need) -- never folded into VALID_VIDEO_RANKING_CONTENT_TYPES.
VALID_RECENT_CREATOR_VIDEOS_LIVE_STATUSES = VALID_LIVE_STATUS_SCOPES  # shared with get_video_ranking

# GET /creators/{creatorId}/videos/recent's own sort order (Home Oshi Videos 最新上架 / 最舊上架).
RECENT_CREATOR_VIDEOS_SORT_NEWEST = "newest"
RECENT_CREATOR_VIDEOS_SORT_OLDEST = "oldest"
VALID_RECENT_CREATOR_VIDEOS_SORTS = frozenset({RECENT_CREATOR_VIDEOS_SORT_NEWEST, RECENT_CREATOR_VIDEOS_SORT_OLDEST})


def parse_recent_creator_videos_sort(raw: Any) -> str:
    """Validate the optional sort parameter: "newest" (default) or "oldest", case-insensitive."""
    if raw is None or raw == "":
        return RECENT_CREATOR_VIDEOS_SORT_NEWEST
    if not isinstance(raw, str):
        raise ClientError(f"sort must be a string, got {raw!r}")
    normalized = raw.strip().lower()
    if normalized in VALID_RECENT_CREATOR_VIDEOS_SORTS:
        return normalized
    raise ClientError(f"sort must be one of {sorted(VALID_RECENT_CREATOR_VIDEOS_SORTS)}, got {raw!r}")


def parse_recent_creator_videos_live_status(raw: Any) -> str:
    """Validate an optional liveStatus filter for GET /creators/{creatorId}/videos/recent:
    "all" (default; case-insensitive) or one of "upcoming"/"live"/"completed"
    (tracking.video_master.VALID_LIVE_STATUSES) -- mirrors parse_video_ranking_
    content_type's own closed-enum reasoning."""
    if raw is None or raw == "":
        return LIVE_STATUS_SCOPE_ALL
    if not isinstance(raw, str):
        raise ClientError(f"liveStatus must be a string, got {raw!r}")
    normalized = raw.strip().lower()
    if normalized in VALID_RECENT_CREATOR_VIDEOS_LIVE_STATUSES:
        return normalized
    raise ClientError(
        f"liveStatus must be one of {sorted(VALID_RECENT_CREATOR_VIDEOS_LIVE_STATUSES)}, got {raw!r}"
    )


def get_recent_creator_videos(query: dict[str, Any]) -> dict[str, Any]:
    """`GET /creators/{creatorId}/videos/recent`: one creator's own videos,
    newest-published first (or oldest first with `sort=oldest`), optionally filtered by
    `topic`, contentType and liveStatus -- the Home Oshi Videos archive source. Query
    params: topic (all|apex|chatting|minecraft|other|sf6|singing|valorant), contentType
    (all|live|upload), liveStatus (all|archived|upcoming|live|completed; "archived" drops
    only still-upcoming/live-now streams), sort (newest|oldest), limit, offset. Filter
    order is creator -> topic -> contentType -> liveStatus -> sort -> offset/limit over the
    creator's whole persisted catalog, and "oldest" is a true ascending sort of that
    filtered set, never a reversed newest page. The
    counterpart to get_video_ranking (metric-ranked) over the exact same
    persisted S3 video-ranking result, for a caller that wants recency
    order instead of a ranking (Home's "Latest Live" archive row: contentType=
    live, newest first -- get_video_ranking has no sort mode for this at all,
    only metric-based ranking, and mixing a non-ranked "latest" mode into
    that endpoint would blur what a "rank" on a response row even means).

    Reads the S3 result only: no VideoMaster Scan, no per-creator-catalog
    live query, no per-video DynamoDB enrichment, no Holodex/YouTube call --
    identical read path and cost profile to get_video_ranking, since both
    read the exact same one-object-per-creator-per-report-date S3 result
    (stores.video_ranking_store keys by creator+date, never further
    partitioned by contentType/topic). This means one full GetObject of the
    creator's whole current catalog for that date either way -- filtering
    and pagination both happen in memory afterward, the same bounded-to-one-
    creator, single-request cost get_video_ranking already has today, not a
    new or more expensive pattern.

    contentType defaults to "all" (VIDEO_RANKING_CONTENT_TYPE_ALL), the same
    closed enum and parser get_video_ranking uses -- a specific filter (e.g.
    "live") excludes "upload" and a row with no persisted contentType at all
    (legacy/unclassified), never treating "unknown" as a match.

    liveStatus (also defaults to "all") is a SEPARATE, independent filter --
    contentType="live" alone includes upcoming/live/completed all together
    (it only reflects liveStreamingDetails presence, not lifecycle stage),
    so Home's own archive-only need (never duplicating the creator's current
    active/upcoming stream, which the Holodex-backed live path already owns)
    must additionally pass liveStatus="completed". Composable with
    contentType, never a replacement for it: contentType=live&liveStatus=
    completed together are what an archive-only caller sends.

    Ordering: publishedAt descending (ISO 8601 strings sort correctly as
    plain strings), videoId ascending as a deterministic tie-break for equal
    timestamps -- achieved by sorting twice and relying on Python's stable
    sort (ascending by videoId first, then descending by publishedAt), the
    same "assign order deterministically, never leave ties to insertion
    order" spirit as get_video_ranking's own (-metric, videoId) sort keys. A
    row with no publishedAt at all (should not happen for a real video, but
    never trusted blindly) sorts last, never fabricated as newest.

    hasMore is computed from the actual filtered+sorted set, not from the
    returned page's own length (get_recent_streams' own hasMore works
    differently because Holodex itself paginates upstream; here the whole
    per-creator result is already in memory, so hasMore = there is at least
    one more row after this page, computed directly rather than guessed from
    len(page) >= limit, which would be wrong whenever limit doesn't evenly
    divide the true remaining count).
    """
    creator_id = parse_creator_id(query.get("creatorId"))
    content_type = parse_video_ranking_content_type(query.get("contentType"))
    live_status = parse_recent_creator_videos_live_status(query.get("liveStatus"))
    topic = parse_video_ranking_topic(query.get("topic"))
    sort = parse_recent_creator_videos_sort(query.get("sort"))
    limit = parse_recent_creator_videos_limit(query.get("limit"))
    offset = parse_offset(query.get("offset"))
    report_dates = _leaderboard_report_dates(query.get("reportDate"))

    creator = _find_creator(creator_id)
    if creator is None:
        raise ClientError(f"No creator found for creatorId {creator_id!r}")

    store = S3VideoRankingStore.from_environment_or_default()
    result = None
    for candidate_date in report_dates:
        result = store.read_result(candidate_date, creator_id)
        if result is not None:
            break
    if result is None:
        raise RankingNotReadyError(
            f"Recent videos for creatorId={creator_id!r} topic={topic!r} contentType={content_type!r} "
            f"liveStatus={live_status!r} reportDate={report_dates[0].isoformat()!r} is not yet computed"
        )

    # Filter order is creator -> topic -> contentType -> liveStatus -> sort -> offset/limit, all over the
    # creator's WHOLE persisted catalog, so a matching video is never lost to an earlier truncation.
    rows = [row for row in result["videos"] if row.get("creatorId") == creator_id]
    if topic != VIDEO_RANKING_TOPIC_ALL:
        rows = [row for row in rows if row.get("topic") == topic]
    if content_type != VIDEO_RANKING_CONTENT_TYPE_ALL:
        rows = [row for row in rows if row.get("contentType") == content_type]
    if live_status != LIVE_STATUS_SCOPE_ALL:
        rows = [row for row in rows if row_matches_live_status(row, live_status)]
    by_video_id = sorted(rows, key=lambda row: row["videoId"])
    dated = [row for row in by_video_id if row.get("publishedAt")]
    undated = [row for row in by_video_id if not row.get("publishedAt")]
    # Two stable sorts (videoId ascending first) so equal timestamps order deterministically. "oldest"
    # is a true ascending sort of the full filtered set -- never a reversed newest page. A row with no
    # publishedAt sorts last in BOTH directions, never as the "oldest".
    if sort == RECENT_CREATOR_VIDEOS_SORT_OLDEST:
        ordered = sorted(dated, key=lambda row: row["publishedAt"]) + undated
    else:
        ordered = sorted(dated, key=lambda row: row["publishedAt"], reverse=True) + undated

    page = ordered[offset : offset + limit]
    videos = [
        {
            "videoId": row["videoId"],
            "creatorId": row["creatorId"],
            "topic": row["topic"],
            "contentType": row.get("contentType"),
            "liveStatus": row.get("liveStatus"),
            "currentViewCount": row["currentViewCount"],
            "title": row.get("title"),
            "thumbnailUrl": row.get("thumbnailUrl"),
            "publishedAt": row.get("publishedAt"),
            "discoveredAt": row.get("discoveredAt"),
        }
        for row in page
    ]

    return {
        "reportDate": result["reportDate"],
        "generatedAt": result["generatedAt"],
        "creatorId": creator_id,
        "topic": topic,
        "contentType": content_type,
        "liveStatus": live_status,
        "sort": sort,
        "videos": videos,
        "hasMore": offset + limit < len(ordered),
    }


# GET /creators/{creatorId}/oshi-status -- Home's Oshi Status panel read model.
# One bounded response built from the SAME per-creator S3 video-ranking result
# get_video_ranking/get_recent_creator_videos already read (one GetObject, no
# Scan, no Holodex/YouTube call, nothing persisted per request). It supplies
# what no existing endpoint does: channel-level VIEW GROWTH (derived from the
# persisted anchor view counts, never the raw anchors), plus the latest upload,
# the newest uploads/completed streams and exact since-last-visit counts in the
# same read, plus the creator's current subscriber count from the existing daily
# subscriber-leaderboard result. The current live/upcoming stream stays
# GET /live-streams' job.
OSHI_STATUS_RECENT_DEFAULT_LIMIT = 6
OSHI_STATUS_RECENT_MAX_LIMIT = 10
OSHI_STATUS_MAX_LOOKBACK_DAYS = 30
_OSHI_STATUS_MAX_TIMESTAMP_LENGTH = 40
_OSHI_STATUS_KIND_UPLOAD = "upload"
_OSHI_STATUS_KIND_LIVESTREAM = "livestream"


def parse_oshi_status_recent_limit(raw: Any) -> int:
    """Validate the optional recentLimit parameter: a positive integer at most OSHI_STATUS_RECENT_MAX_LIMIT (default 6)."""
    if raw is None or raw == "":
        return OSHI_STATUS_RECENT_DEFAULT_LIMIT
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise ClientError(f"recentLimit must be a positive integer, got {raw!r}") from None
    if isinstance(raw, bool) or value <= 0:
        raise ClientError(f"recentLimit must be a positive integer, got {raw!r}")
    if value > OSHI_STATUS_RECENT_MAX_LIMIT:
        raise ClientError(f"recentLimit must be at most {OSHI_STATUS_RECENT_MAX_LIMIT}, got {value!r}")
    return value


def _parse_utc_timestamp(raw: Any) -> datetime | None:
    """An ISO 8601 timestamp WITH a UTC offset (or Z) as an aware UTC datetime, else None.

    A naive timestamp is rejected: "since" and every publishedAt compared against
    it must mean one absolute instant, never a guessed time zone.
    """
    if not isinstance(raw, str) or not raw or len(raw) > _OSHI_STATUS_MAX_TIMESTAMP_LENGTH:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc)


def parse_oshi_status_since(raw: Any, *, now: datetime) -> tuple[datetime, bool] | None:
    """Validate the optional `since` (the client's own last-visit time) and bound it.

    Returns None when absent, else (effective_since, clamped): older than
    OSHI_STATUS_MAX_LOOKBACK_DAYS is clamped to that bound (clamped=True), and a
    time after `now` (client clock skew) is treated as `now` so it yields zero
    new items instead of an error. Malformed or offset-less input is a ClientError.
    """
    if raw is None or raw == "":
        return None
    since = _parse_utc_timestamp(raw)
    if since is None:
        raise ClientError("since must be an ISO 8601 timestamp with a UTC offset, e.g. 2026-09-30T12:00:00Z")
    earliest = now - timedelta(days=OSHI_STATUS_MAX_LOOKBACK_DAYS)
    if since < earliest:
        return earliest, True
    return min(since, now), False


def _oshi_status_kind(row: dict[str, Any]) -> str | None:
    """An upload, or a COMPLETED livestream archive; anything else (upcoming/live/unclassified) is not a timeline item."""
    if row.get("contentType") == "upload":
        return _OSHI_STATUS_KIND_UPLOAD
    if row.get("contentType") == "live" and row.get("liveStatus") == "completed":
        return _OSHI_STATUS_KIND_LIVESTREAM
    return None


def _view_growth(row: dict[str, Any], period: str) -> int | None:
    """Views gained over `period` (1d/7d/30d) from the persisted anchor, floored at 0; None when that anchor is a genuine gap.

    The floor matches the history worker's own rule that a rare downward view-count
    correction from YouTube is not growth.
    """
    anchor = row.get(f"anchor{period}ViewCount")
    current = row.get("currentViewCount")
    if anchor is None or not isinstance(current, int) or not isinstance(anchor, int):
        return None
    return max(current - anchor, 0)


def _creator_subscriber_count(creator_id: str, report_dates: list[date]) -> int | None:
    """One creator's CURRENT subscriber count from the persisted whole-roster subscriber-ranking result, else None.

    Reuses the daily subscriber-leaderboard S3 object (stores.subscriber_ranking_store:
    one small JSON per report date, already produced by the daily pipeline), so this
    costs no collection, no YouTube call and no DynamoDB read -- only that one
    GetObject, and only the `total` section's current count is read (no growth rows,
    no history). The newest available result decides: a creator absent from its
    `total.rows` (hidden count, collection gap, or not in the roster) is None, never an
    older day's number or a fabricated 0. Any read problem is also None -- the count is
    an optional header detail and must not take down the rest of the Oshi Status read.
    """
    store = S3SubscriberRankingStore.from_environment_or_default()
    for candidate_date in report_dates:
        try:
            result = store.read_result(candidate_date)
        except Exception as exc:  # noqa: BLE001 - optional field: degrade to null, log only the type
            print(f"Warning: subscriber result unreadable for Oshi Status ({type(exc).__name__}); subscriberCount=null")
            return None
        if result is None:
            continue
        rows = (result.get("total") or {}).get("rows") or []
        for row in rows:
            if row.get("creatorId") == creator_id:
                count = row.get("subscriberCount")
                return count if isinstance(count, int) and not isinstance(count, bool) else None
        return None
    return None


def get_oshi_status(query: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
    """`GET /creators/{creatorId}/oshi-status`: Home's Oshi Status panel read model for one creator.

    Reads the per-creator S3 video-ranking result only (same read path and cost as
    get_recent_creator_videos: one GetObject, filtering in memory, no Scan, no
    Holodex/YouTube call, no write; plus one small GetObject of the existing daily
    subscriber-leaderboard result for the subscriber count). Returns only bounded,
    UI-required data:

    - subscriberCount: the creator's current subscriber count (integer), or null when
      it is unavailable -- hidden, missing from the newest subscriber result, no
      subscriber result yet, or unreadable. Never fabricated, never a history series.
      See _creator_subscriber_count.
    - latestVideo: the newest UPLOAD (contentType="upload") with its videoId, title,
      thumbnailUrl, publishedAt and currentViewCount, or null when the creator has
      none classified yet.
    - growth: channel-level view growth over 1d/7d/30d -- the sum of each tracked
      video's growth (see _view_growth) with how many videos contributed. This is
      the "all of a creator's tracked videos" delta, derived from the persisted
      anchors; the anchors themselves and any daily history are never returned.
    - recent: the newest uploads and completed livestream archives, newest first
      (videoId ascending tie-break), at most recentLimit (default 6, max 10), each
      tagged kind="upload"|"livestream".
    - thisWeek: always -- newUploads/newStreams published in the 7 days up to now
      (the panel's fixed "This week" window; exclusive lower bound, like `since`).
    - sinceLastVisit: only when `since` is given -- exact newUploads/newStreams
      counts of items published after `since` (exclusive) up to now (inclusive).
      `since` is the client's own stored last-visit time: nothing is stored
      server-side per user. It is bounded to OSHI_STATUS_MAX_LOOKBACK_DAYS
      (clamped=True when it had to be).

    Accuracy caveats (inherent to the collection cost architecture, not bugs here):
    channel growth is approximate -- a non-due video's view count is carried forward
    from its last real observation (up to ~15 days for a Cold video), so its growth
    appears in a lump when it is next observed; and a livestream's publishedAt is YouTube's
    snippet.publishedAt (when the broadcast was created/scheduled), not when it
    ended, so a stream scheduled before the client's `since` but finished after it
    is not counted in newStreams.

    Not included: the current live/upcoming stream (GET /live-streams). Per-video
    growth and milestone events are out of V1 scope. Videos not yet
    classified (contentType missing) are not counted anywhere until a collection
    run classifies them. Future-dated rows and rows with an unparseable
    publishedAt are skipped; duplicate videoIds are counted once.

    A missing S3 result for every candidate reportDate is RankingNotReadyError
    (503, "RANKING_NOT_READY"), the same "not yet computed, no live fallback"
    contract as the sibling endpoints.
    """
    creator_id = parse_creator_id(query.get("creatorId"))
    recent_limit = parse_oshi_status_recent_limit(query.get("recentLimit"))
    now = now or datetime.now(timezone.utc)
    since = parse_oshi_status_since(query.get("since"), now=now)
    report_dates = _leaderboard_report_dates(query.get("reportDate"))

    if _find_creator(creator_id) is None:
        raise ClientError(f"No creator found for creatorId {creator_id!r}")

    store = S3VideoRankingStore.from_environment_or_default()
    result = None
    for candidate_date in report_dates:
        result = store.read_result(candidate_date, creator_id)
        if result is not None:
            break
    if result is None:
        raise RankingNotReadyError(
            f"Oshi status for creatorId={creator_id!r} reportDate={report_dates[0].isoformat()!r} is not yet computed"
        )

    periods = ("1d", "7d", "30d")
    growth_totals = {period: [0, 0] for period in periods}
    timeline: list[tuple[datetime, str, str, dict[str, Any]]] = []
    seen: set[str] = set()
    for row in result["videos"]:
        video_id = row.get("videoId")
        if row.get("creatorId") != creator_id or not isinstance(video_id, str) or video_id in seen:
            continue
        seen.add(video_id)
        for period in periods:
            gained = _view_growth(row, period)
            if gained is not None:
                growth_totals[period][0] += gained
                growth_totals[period][1] += 1
        kind = _oshi_status_kind(row)
        published = _parse_utc_timestamp(row.get("publishedAt"))
        if kind is None or published is None or published > now:
            continue
        timeline.append((published, video_id, kind, row))

    # Two stable sorts: videoId ascending first, then publishedAt descending, so equal timestamps
    # always come out in the same order.
    timeline.sort(key=lambda entry: entry[1])
    timeline.sort(key=lambda entry: entry[0], reverse=True)

    latest = next((entry for entry in timeline if entry[2] == _OSHI_STATUS_KIND_UPLOAD), None)
    latest_video = None
    if latest is not None:
        _published, video_id, _kind, row = latest
        latest_video = {
            "videoId": video_id,
            "title": row.get("title"),
            "thumbnailUrl": row.get("thumbnailUrl"),
            "publishedAt": row.get("publishedAt"),
            "currentViewCount": row.get("currentViewCount"),
        }

    since_last_visit = None
    if since is not None:
        effective_since, clamped = since
        since_last_visit = {
            "since": effective_since.isoformat(),
            "clamped": clamped,
            "newUploads": sum(1 for p, _v, k, _r in timeline if k == _OSHI_STATUS_KIND_UPLOAD and p > effective_since),
            "newStreams": sum(1 for p, _v, k, _r in timeline if k == _OSHI_STATUS_KIND_LIVESTREAM and p > effective_since),
        }

    week_start = now - timedelta(days=7)
    return {
        "reportDate": result["reportDate"],
        "generatedAt": result["generatedAt"],
        "creatorId": creator_id,
        "subscriberCount": _creator_subscriber_count(creator_id, report_dates),
        "latestVideo": latest_video,
        "thisWeek": {
            "newUploads": sum(1 for p, _v, k, _r in timeline if k == _OSHI_STATUS_KIND_UPLOAD and p > week_start),
            "newStreams": sum(1 for p, _v, k, _r in timeline if k == _OSHI_STATUS_KIND_LIVESTREAM and p > week_start),
        },
        "growth": {
            period: {"absoluteGrowth": growth_totals[period][0], "videoCount": growth_totals[period][1]}
            for period in periods
        },
        "recent": [
            {
                "videoId": video_id,
                "kind": kind,
                "title": row.get("title"),
                "thumbnailUrl": row.get("thumbnailUrl"),
                "publishedAt": row.get("publishedAt"),
                "currentViewCount": row.get("currentViewCount"),
            }
            for _published, video_id, kind, row in timeline[:recent_limit]
        ],
        "sinceLastVisit": since_last_visit,
    }


# Yobi's own approved Holodex Live/Upcoming lookahead window: 7 days, not
# Holodex's own 48-hour /live default (docs.holodex.net) -- a product
# decision made ahead of this integration, confirmed with the user.
#
# Enforced locally (see _is_within_lookahead below), not sent to Holodex as a
# request parameter: /users/live -- the endpoint this function actually
# calls, see its docstring -- does not document max_upcoming_hours, and a
# live probe against the real API (2026-09-29, using the already-configured
# Secrets Manager key) confirmed it has no effect there: an identical request
# with and without max_upcoming_hours=168 returned byte-identical results,
# including upcoming entries scheduled over 700 days out. /users/live simply
# returns everything upcoming for the requested channels with no time-window
# truncation of its own, which is exactly what makes local enforcement safe
# here -- nothing within the 7-day window is ever missing from the response.
_HOLODEX_MAX_UPCOMING_HOURS = 24 * 7


def _is_within_lookahead(scheduled_start: str | None, *, now: datetime) -> bool:
    """Whether an "upcoming" stream's scheduled_start falls within Yobi's lookahead window.

    scheduled_start is already an absolute, offset-aware UTC ISO-8601 string
    when present (holodex_normalization._parse_utc_timestamp's contract) --
    re-parsing it here can only fail if that contract is somehow violated,
    which is treated the same as a missing timestamp: excluded rather than
    raised, matching normalize_holodex_stream's own "degrade the item, never
    take down the batch" posture for anything Holodex-sourced. An "upcoming"
    item this project cannot confirm is due within the window must not be
    shown as if it were -- silently guessing a default would misrepresent it.
    """
    if scheduled_start is None:
        return False
    try:
        scheduled_at = datetime.fromisoformat(scheduled_start)
    except ValueError:
        return False
    return scheduled_at <= now + timedelta(hours=_HOLODEX_MAX_UPCOMING_HOURS)


def get_live_streams(_query: dict[str, Any] | None = None) -> dict[str, Any]:
    """`GET /live-streams`: current live/upcoming streams for Yobi's supported creators, sourced from Holodex.

    One aggregate Holodex `/users/live` request for every live-roster-eligible
    creator's channel at once (`channels=<comma-separated ids>`) — never one
    request per creator. `/users/live`, not `/live`: Holodex only documents
    the `channels` (plural, comma-separated) filter for `/users/live` --
    `/live` documents just `channel_id` (singular). A live probe against the
    real API (2026-09-29) confirmed this isn't pedantic: the same `channels=`
    request against `/live` returned 806 distinct channels across 1,272 items
    (i.e. `/live` silently ignores an undocumented `channels` filter and
    returns platform-wide results), while `/users/live` returned exactly this
    project's own 97 requested channels (79 with current activity). `/live`'s
    result staying correct at all currently depends entirely on this
    function's own defensive channel_index filter below rather than on
    Holodex actually scoping the request -- and that same local filter cannot
    recover an eligible stream that never made it into `/live`'s response in
    the first place if its (undocumented, platform-wide) result was ever
    truncated. `/users/live` is genuinely channel-scoped instead, so no such
    risk applies. Holodex is queried directly here rather than through any
    persisted store (DynamoDB/S3/cache): this is read-path integration only,
    matching TrendingNotReadyError's "no live fallback" precedent in reverse
    -- here Holodex itself *is* the live source, with no persistence layer in
    front of it yet.

    Which channels are asked about is Creator Master's own
    is_live_status_polling_eligible (tracking/creator_master.py): displayed,
    current (active or pre_debut) channels of ANY type -- members, and group/
    staff channels such as vspo_official -- with a well-formed YouTube channel
    id. Graduated creators are never requested (they stay visible in Live
    Status through the frontend roster and fall back to OFFLINE), so showing
    them costs no Holodex quota. A normalized stream whose channel isn't in
    that polled set (Holodex returning something unrequested, e.g. a collab
    guest) is dropped defensively, the same "never guess" posture
    normalize_holodex_stream itself already takes per-field.

    An "upcoming" stream is additionally kept only when _is_within_lookahead
    says its scheduled_start is within _HOLODEX_MAX_UPCOMING_HOURS from now
    -- see that function's own docstring for why this must be enforced
    locally rather than requested from Holodex. A "live" stream is always
    kept regardless of scheduled_start; it's already happening.

    Raises HolodexAPIError/HolodexNormalizationError/MissingHolodexApiKeyError
    on any Holodex failure rather than returning a fabricated empty result --
    api_handler.py's dispatch maps these to 503, the same "external
    dependency temporarily unavailable" treatment as TrendingNotReadyError.
    """
    eligible_creators = [creator for creator in load_creators() if is_live_status_polling_eligible(creator)]
    channel_index = {creator.youtube_channel_id: creator for creator in eligible_creators}
    if not channel_index:
        return {"streams": []}

    raw_payload = holodex_get("/users/live", {"channels": ",".join(channel_index)})
    normalized_streams = normalize_holodex_live_response(raw_payload)

    now = datetime.now(timezone.utc)
    streams = []
    for stream in normalized_streams:
        creator = channel_index.get(stream.youtube_channel_id)
        if creator is None:
            continue
        if stream.status == "upcoming" and not _is_within_lookahead(stream.scheduled_start, now=now):
            continue
        streams.append(
            {
                "videoId": stream.video_id,
                "creatorId": creator.creator_id,
                "channelName": stream.channel_name or creator.display_name,
                "title": stream.title,
                "status": stream.status,
                "scheduledStart": stream.scheduled_start,
                "actualStart": stream.actual_start,
                "thumbnailUrl": stream.thumbnail_url,
            }
        )
    return {"streams": streams}


# GET /recent-streams' own limit -- deliberately its own constant, not
# MAX_LIMIT/parse_limit above (that pair backs the /trending family's
# page sizing, up to 100 rows of already-cheap cached data). A `Latest Live`
# archive row only ever needed up to ~5 slots even before this endpoint
# existed (recentVideosSelection.ts's selectLivestreamSlots, frontend) --
# 20 is a small, safe upper bound comfortably above that real need, not an
# invitation to page deep into one creator's full upload history through a
# request-time Holodex call.
RECENT_STREAMS_DEFAULT_LIMIT = 4
RECENT_STREAMS_MAX_LIMIT = 20


def parse_recent_streams_limit(raw: Any) -> int:
    """Validate an optional limit query parameter for GET /recent-streams:
    a positive integer at most RECENT_STREAMS_MAX_LIMIT, defaulting to
    RECENT_STREAMS_DEFAULT_LIMIT when absent (unlike parse_limit above,
    whose absence means "caller decides", this endpoint always sends some
    limit to Holodex)."""
    if raw is None or raw == "":
        return RECENT_STREAMS_DEFAULT_LIMIT
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise ClientError(f"limit must be a positive integer, got {raw!r}") from None
    if isinstance(raw, bool) or value <= 0:
        raise ClientError(f"limit must be a positive integer, got {raw!r}")
    if value > RECENT_STREAMS_MAX_LIMIT:
        raise ClientError(f"limit must be at most {RECENT_STREAMS_MAX_LIMIT}, got {value!r}")
    return value


def parse_offset(raw: Any) -> int:
    """Validate an optional offset query parameter: a non-negative integer, defaulting to 0."""
    if raw is None or raw == "":
        return 0
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise ClientError(f"offset must be a non-negative integer, got {raw!r}") from None
    if isinstance(raw, bool) or value < 0:
        raise ClientError(f"offset must be a non-negative integer, got {raw!r}")
    return value


def get_recent_streams(query: dict[str, Any]) -> dict[str, Any]:
    """`GET /recent-streams`: one creator's most recent ENDED livestreams (archives
    only), paginated, sourced from Holodex -- the counterpart to get_live_streams
    above, which owns current live/upcoming instead. Together:

      /live-streams   -> current LIVE / UPCOMING, every eligible creator, no pagination
      /recent-streams -> one creator's ended archives, paginated, no live/upcoming

    Never merges the two -- a caller that wants both (the frontend's "Latest
    Live" row) combines them client-side, the same way it already combines
    live-now + archives locally (recentVideosSelection.ts's
    selectLivestreamSlots, unchanged by this endpoint).

    creatorId is resolved and eligibility-checked against Creator Master
    (is_current_member_eligible -- this endpoint's own member-only rule, unchanged
    by the Live Status roster work) *before* ever calling Holodex, so an unknown
    or ineligible creatorId gets a clean 404 (ScopeNotFoundError) rather than an
    empty result indistinguishable from "this real creator just has no archives."

    Holodex request: GET /videos?channel_id=<real channel>&type=stream&
    status=past&sort=available_at&order=desc&limit=<limit>&offset=<offset> --
    exactly the query semantics the frontend's own now-retired
    fetchArchivedStreamsFromHolodex used for its archive page (never
    live/upcoming; that request stays entirely inside get_live_streams).

    hasMore is derived from the raw Holodex page count against `limit`
    (`len(raw_payload) >= limit`), so normalization and channel filtering
    do not affect pagination. It is independent of /live-streams, which
    this endpoint never touches.

    Raises HolodexAPIError/HolodexNormalizationError/MissingHolodexApiKeyError
    on any Holodex failure -- api_handler.py's existing dispatch already maps
    these to a safe 503 (HOLODEX_UNAVAILABLE), the identical handling
    get_live_streams' own callers already go through; no separate error
    path is added for this endpoint.
    """
    creator_id = parse_creator_id(query.get("creatorId"))
    limit = parse_recent_streams_limit(query.get("limit"))
    offset = parse_offset(query.get("offset"))

    creator = _find_creator(creator_id)
    if creator is None or not is_current_member_eligible(creator):
        raise ScopeNotFoundError(f"No creator found for creatorId {creator_id!r}")

    raw_payload = holodex_get(
        "/videos",
        {
            "channel_id": creator.youtube_channel_id,
            "type": "stream",
            "status": "past",
            "sort": "available_at",
            "order": "desc",
            "limit": str(limit),
            "offset": str(offset),
        },
    )
    archived = normalize_holodex_archived_streams_response(raw_payload)

    streams = [
        {
            "videoId": item.video_id,
            "creatorId": creator.creator_id,
            "channelName": item.channel_name or creator.display_name,
            "title": item.title,
            "thumbnailUrl": item.thumbnail_url,
            "publishedAt": item.published_at,
        }
        for item in archived
        if item.youtube_channel_id == creator.youtube_channel_id
    ]
    return {"creatorId": creator.creator_id, "streams": streams, "hasMore": len(raw_payload) >= limit}


# The daily pipeline finishes around 18:00 JST, so an omitted reportDate would
# otherwise miss until then; it serves the newest report found in this window.
LATEST_REPORT_LOOKBACK_DAYS = 3


def _leaderboard_report_dates(raw_report_date: Any) -> list[date]:
    if raw_report_date:
        return [parse_report_date(raw_report_date)]
    today = _today_in_canonical_time_zone()
    return [today - timedelta(days=offset) for offset in range(LATEST_REPORT_LOOKBACK_DAYS)]


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
