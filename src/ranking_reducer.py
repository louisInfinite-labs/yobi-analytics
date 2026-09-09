"""Merge shard-local Top-N results and persist small TrendingCache payloads."""

from __future__ import annotations

import os
from datetime import date, datetime
from typing import Any, Callable
from zoneinfo import ZoneInfo

from creator_master import load_creators
from history_ranking import RankedGrowth, merge_partial_rankings
from history_store import HISTORY_SHARD_COUNT
from ranking_partial_store import S3PartialRankingStore

_TIME_ZONE = "Asia/Tokyo"
_RANKING_TYPE = {"1d": "daily_trending", "7d": "7d_trending", "30d": "30d_trending"}


def persist_rankings(
    rankings,
    *,
    report_date: date,
    get_video: Callable[[str], Any],
    put_cached_trending: Callable[..., None],
    computed_at: str,
) -> int:
    """Persist only bounded final results, enriched from master data."""
    from read_api import trending_cache_key

    creators = {creator.creator_id: creator for creator in load_creators()}
    video_ids = {
        entry.video_id
        for periods in rankings.values()
        for entries in periods.values()
        for entry in entries
    }
    videos = {video_id: get_video(video_id) for video_id in video_ids}
    writes = 0
    for (scope_type, scope_value), periods in rankings.items():
        for period, entries in periods.items():
            payload = {
                "timeZone": _TIME_ZONE,
                "reportDate": report_date.isoformat(),
                "comparisonDate": _comparison_date(report_date, period).isoformat(),
                "period": period,
                "rankingType": _RANKING_TYPE[period],
                "lastUpdatedAt": min(
                    (entry.observed_at for entry in entries), default=None
                ),
                **_scope_field(scope_type, scope_value),
                "results": [
                    _cache_row(entry, videos.get(entry.video_id), creators)
                    for entry in entries
                ],
            }
            key = trending_cache_key(
                scope_type=scope_type,
                scope_value=scope_value,
                period=period,
                ranking_type=_RANKING_TYPE[period],
                report_date=report_date,
            )
            put_cached_trending(key, payload, computed_at=computed_at)
            writes += 1
    return writes


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Merge all successful shard partials after the Step Functions Map."""
    from dynamodb_store import get_video, put_cached_trending

    now = datetime.now(ZoneInfo(_TIME_ZONE))
    report_date = _collection_date(event, now)
    store = S3PartialRankingStore(os.environ["YOBI_HISTORY_BUCKET"])
    partials = [store.read(report_date, shard) for shard in range(HISTORY_SHARD_COUNT)]
    rankings = merge_partial_rankings(partials)
    writes = persist_rankings(
        rankings,
        report_date=report_date,
        get_video=get_video,
        put_cached_trending=put_cached_trending,
        computed_at=now.isoformat(),
    )
    return {"date": report_date.isoformat(), "cacheWrites": writes}


def _collection_date(event: dict[str, Any], now: datetime) -> date:
    if event.get("date"):
        return date.fromisoformat(event["date"])
    if event.get("startedAt"):
        started_at = datetime.fromisoformat(event["startedAt"].replace("Z", "+00:00"))
        return started_at.astimezone(ZoneInfo(_TIME_ZONE)).date()
    return now.date()


def _comparison_date(report_date: date, period: str) -> date:
    from datetime import timedelta

    return report_date - timedelta(days=int(period[:-1]))


def _scope_field(scope_type: str, scope_value: str) -> dict[str, str]:
    return {
        "creator": {"creatorId": scope_value},
        "organization": {"organization": scope_value},
        "branch": {"branch": scope_value},
        "global": {"scope": "global"},
    }[scope_type]


def _cache_row(entry: RankedGrowth, video: Any, creators: dict[str, Any]) -> dict[str, Any]:
    creator = creators.get(entry.creator_id)
    growth_percent = (
        entry.gain / entry.anchor_view_count * 100
        if entry.anchor_view_count > 0
        else None
    )
    return {
        "rank": entry.rank,
        "videoId": entry.video_id,
        "value": entry.gain,
        "title": video.title if video else None,
        "creatorId": entry.creator_id,
        "channelName": creator.display_name if creator else None,
        "organization": creator.organization if creator else None,
        "branch": creator.branch if creator else None,
        "groupKey": creator.group_key if creator else None,
        "channelType": creator.channel_type if creator else None,
        "lifecycleStage": creator.lifecycle_stage if creator else None,
        "latestViewCount": entry.view_count,
        "lastUpdatedAt": entry.observed_at,
        "growth": entry.gain,
        "growthPercent": growth_percent,
        "status": "ok",
    }
