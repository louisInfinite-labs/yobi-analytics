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
from datetime import date, datetime
from typing import Any

from creator_master import Creator, load_creators
from trending import (
    DAILY_TRENDING,
    RANKING_TYPES,
    SEVEN_DAY_TRENDING,
    THIRTY_DAY_TRENDING,
    RankedEntry,
    rank_videos,
)
from video_master import Video
from view_growth_analytics import (
    COLLECTION_START_DATE,
    PERIOD_DAYS,
    GrowthResult,
    InvalidTimeZoneError,
    calculate_growth,
    comparison_date,
    validate_time_zone,
)

if os.environ.get("YOBI_STORAGE_BACKEND") == "dynamodb":
    from dynamodb_store import get_snapshot, get_video, load_videos
else:
    from snapshot_store import get_snapshot
    from video_master import get_video, load_videos

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


def parse_video_id(raw: Any) -> str:
    """Validate a videoId query parameter is a non-empty string."""
    if not isinstance(raw, str) or not raw:
        raise ClientError("videoId is required and must be a non-empty string")
    return raw


def parse_creator_id(raw: Any) -> str:
    """Validate a creatorId query parameter is a non-empty string.

    Actual existence is checked against Creator Master by the caller (a
    syntactically valid but unknown creatorId is a separate ClientError),
    not hardcoded here.
    """
    if not isinstance(raw, str) or not raw:
        raise ClientError("creatorId is required and must be a non-empty string")
    return raw


def parse_organization(raw: Any) -> str:
    """Validate an organization query parameter is a non-empty string.

    Not validated against a hardcoded {"hololive", "vspo"} set (Roadmap
    1.3: organizations are data, not business logic) — an organization with
    no matching Creator Master records is rejected by the caller instead.
    """
    if not isinstance(raw, str) or not raw:
        raise ClientError("organization is required and must be a non-empty string")
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


def parse_limit(raw: Any) -> int | None:
    """Validate an optional limit query parameter is a positive integer, or None if absent."""
    if raw is None or raw == "":
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise ClientError(f"limit must be a positive integer, got {raw!r}") from None
    if isinstance(raw, bool) or value <= 0:
        raise ClientError(f"limit must be a positive integer, got {raw!r}")
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


def get_creator_trending(query: dict[str, Any]) -> dict[str, Any]:
    """Validate a trending query for one creator and return a ranked Roadmap 4.1/3.2 response.

    `query` needs at least `creatorId`, `reportDate`, `timeZone`, and
    `period`; `rankingType` and `limit` are optional. Mirrors
    `GET /creators/{creatorId}/trending?period=7d`.
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

    videos = [video for video in load_videos() if video.creator_id == creator_id]
    ranked = rank_videos(
        _compute_growth_results(videos, report_date=report_date, period=period), ranking_type, limit=limit
    )

    return _trending_response(
        ranked,
        scope={"creatorId": creator_id},
        report_date=report_date,
        period=period,
        ranking_type=ranking_type,
        time_zone=time_zone,
    )


def get_organization_trending(query: dict[str, Any]) -> dict[str, Any]:
    """Validate a trending query across one organization and return a ranked Roadmap 4.1/3.3 response.

    `query` needs at least `organization`, `reportDate`, `timeZone`, and
    `period`; `rankingType` and `limit` are optional. Mirrors
    `GET /organizations/{organization}/trending?period=1d`.
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

    videos = [video for video in load_videos() if video.creator_id in creator_ids]
    ranked = rank_videos(
        _compute_growth_results(videos, report_date=report_date, period=period), ranking_type, limit=limit
    )

    return _trending_response(
        ranked,
        scope={"organization": organization},
        report_date=report_date,
        period=period,
        ranking_type=ranking_type,
        time_zone=time_zone,
    )


# Bounds how many concurrent DynamoDB GetItem calls _compute_growth_results
# fans out for one trending request. Each video needs two independent
# snapshot lookups (report_date, comparison_date) with no ordering
# dependency between them — fetching sequentially for an organization with
# thousands of videos is what previously made a real production-scale
# trending request exceed API Gateway's fixed 29-second integration
# timeout; a bounded thread pool (I/O-bound network calls, not CPU-bound
# work, so the GIL is not a limiting factor here) brings that well under it
# without needing a schema change to Video Master.
_SNAPSHOT_FETCH_WORKERS = 20


def _compute_growth_results(videos: list[Video], *, report_date: date, period: str) -> list[GrowthResult]:
    """Compute one GrowthResult per video for the same (report_date, period) comparison window."""
    comp_date = comparison_date(report_date, period)

    def _fetch_snapshot_pair(video: Video) -> tuple[Any, Any]:
        return get_snapshot(video.video_id, report_date), get_snapshot(video.video_id, comp_date)

    with ThreadPoolExecutor(max_workers=_SNAPSHOT_FETCH_WORKERS) as executor:
        snapshot_pairs = list(executor.map(_fetch_snapshot_pair, videos))

    return [
        calculate_growth(
            video_id=video.video_id,
            report_date=report_date,
            period=period,
            latest_snapshot=latest_snapshot,
            comparison_snapshot=comparison_snapshot,
            earliest_available_date=_earliest_available_date_for(video),
        )
        for video, (latest_snapshot, comparison_snapshot) in zip(videos, snapshot_pairs)
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
        "latestViewCount": result.latest.view_count,
        "comparisonViewCount": result.comparison.view_count,
        "growth": result.growth,
        "growthPercent": result.growth_percent,
    }
