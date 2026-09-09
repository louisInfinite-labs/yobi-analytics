"""Lambda entry point for one deterministic daily history shard."""

from __future__ import annotations

import os
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

from config import get_api_key
from creator_master import load_creators
from history_ranking import CreatorDimensions
from history_store import S3HistoryStore
from history_worker import collect_history_shard
from ranking_partial_store import S3PartialRankingStore
from tracking_manifest import S3TrackingManifestStore
from youtube_client import build_youtube_client

COLLECTION_TIMEZONE = ZoneInfo("Asia/Tokyo")


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Collect one shard and persist its history plus bounded reducer input."""
    now = datetime.now(COLLECTION_TIMEZONE)
    collection_date = _collection_date(event, now)
    shard = int(event["shard"])
    bucket_name = os.environ["YOBI_HISTORY_BUCKET"]
    history_store = S3HistoryStore(bucket_name)
    manifest_store = S3TrackingManifestStore(bucket_name)
    dimensions = {
        creator.creator_id: CreatorDimensions(
            organization=creator.organization,
            branch=creator.branch,
        )
        for creator in load_creators()
    }
    result = collect_history_shard(
        youtube=build_youtube_client(get_api_key()),
        manifest_store=manifest_store,
        history_store=history_store,
        collection_date=collection_date,
        shard=shard,
        dimensions_by_creator=dimensions,
        observed_at=now.isoformat(),
    )
    partial_key = S3PartialRankingStore(bucket_name).write(
        collection_date, shard, result.rankings
    )
    return {
        "date": collection_date.isoformat(),
        "shard": shard,
        "requestedCount": result.requested_count,
        "collectedCount": result.collected_count,
        "skippedCount": len(result.skipped),
        "historyKey": result.history_key,
        "partialRankingKey": partial_key,
    }


def _collection_date(event: dict[str, Any], now: datetime) -> date:
    if event.get("date"):
        return date.fromisoformat(event["date"])
    if event.get("startedAt"):
        started_at = datetime.fromisoformat(event["startedAt"].replace("Z", "+00:00"))
        return started_at.astimezone(COLLECTION_TIMEZONE).date()
    return now.date()
