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
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from tracking.creator_master import Creator, load_creators
from analytics.subscriber_ranking import GROWTH_PERIODS, VALID_SUBSCRIBER_ORGANIZATIONS
from stores.subscriber_ranking_store import S3SubscriberRankingStore
from analytics.video_ranking import TOPIC_SCOPE_ALL as VIDEO_RANKING_TOPIC_ALL
from analytics.video_ranking import VALID_METRICS as VALID_VIDEO_RANKING_METRICS
from analytics.video_ranking import VALID_TOPIC_SCOPES as VALID_VIDEO_RANKING_TOPICS
from analytics.video_ranking import rank_video_rows
from stores.video_ranking_store import S3VideoRankingStore
from tracking.video_master import Video
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

    store = S3SubscriberRankingStore.from_environment()
    result = None
    if store is not None:
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
    total (lifetime view count) or 1d/7d/30d growth, optionally filtered to
    one topic, all derived in memory from the ONE persisted canonical row
    set for a creator/report date (Phase C storage correction: one row per
    video, never four separately ranked/duplicated row sets). Mirrors
    `GET /creators/{creatorId}/videos/ranking?metric=7d&topic=valorant`.

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
    live query, no per-video DynamoDB enrichment, no write-on-request. Topic
    filtering, metric selection, and ranking/sorting are all performed here,
    at read time, over the one persisted canonical row set — see
    analytics.video_ranking.rank_video_rows.
    """
    creator_id = parse_creator_id(query.get("creatorId"))
    metric = parse_video_ranking_metric(query.get("metric"))
    topic = parse_video_ranking_topic(query.get("topic"))
    limit = parse_limit(query.get("limit")) or MAX_LIMIT
    report_dates = _leaderboard_report_dates(query.get("reportDate"))

    creator = _find_creator(creator_id)
    if creator is None:
        raise ClientError(f"No creator found for creatorId {creator_id!r}")

    store = S3VideoRankingStore.from_environment()
    result = None
    if store is not None:
        for candidate_date in report_dates:
            result = store.read_result(candidate_date, creator_id)
            if result is not None:
                break
    if result is None:
        raise RankingNotReadyError(
            f"Video ranking for creatorId={creator_id!r} metric={metric!r} topic={topic!r} "
            f"reportDate={report_dates[0].isoformat()!r} is not yet computed"
        )

    rows = rank_video_rows(result["videos"], metric=metric, topic=topic)[:limit]

    return {
        "reportDate": result["reportDate"],
        "generatedAt": result["generatedAt"],
        "creatorId": creator_id,
        "metric": metric,
        "topic": topic,
        "rows": rows,
    }


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
