"""ReduceRankings/MarkExecutionComplete/MarkExecutionFailed Lambda: renews the
execution lock, builds and persists the per-creator video-ranking S3 result,
and marks the daily execution complete/failed.

R9 (org-trending retirement): this module used to also merge every shard's
bounded Top-N creator/org growth partial (IncrementalRankingMerger) and
persist it into YobiTrendingCache (persist_rankings/WruBudget/_paced_put/
_scope_field/_cache_row), the write side of the old cross-creator/org-wide
"trending" product (api.read_api.get_creator_trending/get_organization_
trending, now removed along with their two API routes). That whole pipeline
had zero remaining consumers once those two routes were retired -- see
analytics.history_ranking's own module docstring for where the shared
merge/ranking primitives it depended on went. This Lambda's only remaining
job per invocation is what's below: execution-lock bookkeeping (shared with
this same Lambda's markCompleteForDate/markFailedForDate branches) and video
ranking (Phase C), an independent, already-scoped-per-creator product this
retirement does not touch.
"""

from __future__ import annotations

import os
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from collection import execution_lock
from stores.history_store import EXACT_ANCHOR_DAYS, HISTORY_SHARD_COUNT, HistoryRow, S3HistoryStore
from analytics.video_ranking import build_creator_video_catalog
from analytics.video_ranking_result import build_video_ranking_result
from stores.video_ranking_store import S3VideoRankingStore, VideoRankingStoreError
from tracking.tracking_manifest import S3TrackingManifestStore, discovered_dates_by_video
from tracking.video_topics import OTHER_TOPIC, TOPIC_IDS

_TIME_ZONE = "Asia/Tokyo"


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Renew the execution lock and build/persist this report date's video
    ranking.

    Also doubles as terraform/history.tf's `MarkExecutionComplete`
    (`markCompleteForDate`) and `MarkExecutionFailed` (`markFailedForDate`)
    states — see `_mark_execution_complete`/`_mark_execution_failed` for why
    those are handled by this same Lambda rather than new ones.

    `reportDate`/`ownerToken` arrive explicitly in the event (forwarded from
    AcquireExecutionLock's own output via ReduceRankings' Parameters) —
    this function never derives its own "today", the same reasoning as
    history_worker_handler.lambda_handler's shard branch.
    """
    if "markCompleteForDate" in event:
        return _mark_execution_complete(event)
    if "markFailedForDate" in event:
        return _mark_execution_failed(event)

    now = datetime.now(ZoneInfo(_TIME_ZONE))
    report_date = date.fromisoformat(event["reportDate"])
    owner_token = event["ownerToken"]
    execution_lock.renew_execution_lock(
        report_date=report_date,
        owner_token=owner_token,
        now=now,
        lease_seconds=execution_lock.REDUCER_RENEW_LEASE_SECONDS,
        phase=execution_lock.PHASE_REDUCING,
    )
    _build_and_persist_video_rankings(report_date=report_date, generated_at=now.isoformat())
    return {"date": report_date.isoformat(), "reportDate": report_date.isoformat(), "ownerToken": owner_token}


def _build_and_persist_video_rankings(*, report_date: date, generated_at: str) -> None:
    """Video-ranking Phase C: build and persist one own-video ranking result
    per creator with at least one video observed today.

    Reads raw per-video history (all HISTORY_SHARD_COUNT shards, today plus
    the exact D-1/D-7/D-30 anchors) and the full tracking manifest (topic,
    discovered_at) fresh, here.

    A failure anywhere here is deliberately never allowed to propagate: this
    is a separate, additive concern from the execution-lock renewal this
    Lambda also performs, the same reasoning history_worker_handler.
    _collect_subscriber_snapshot_if_configured already applies to R3/R4 --
    a video-ranking-only problem must never fail the ReduceRankings task
    (which would also abort MarkExecutionComplete).
    """
    try:
        video_ranking_store = S3VideoRankingStore.from_environment()
        if video_ranking_store is None:
            return
        bucket_name = os.environ["YOBI_HISTORY_BUCKET"]
        history_store = S3HistoryStore(bucket_name)
        manifest_store = S3TrackingManifestStore(bucket_name)

        today_rows: list[HistoryRow] = []
        anchor_rows_by_days: dict[int, list[HistoryRow]] = {days: [] for days in EXACT_ANCHOR_DAYS}
        active_entries = []
        for shard in range(HISTORY_SHARD_COUNT):
            today_rows.extend(history_store.read_daily_shard(report_date, shard))
            for days in EXACT_ANCHOR_DAYS:
                anchor_rows_by_days[days].extend(
                    history_store.read_daily_shard(report_date - timedelta(days=days), shard)
                )
            active_entries.extend(entry for entry in manifest_store.read_shard(shard) if entry.active)

        topic_by_video = {
            entry.video_id: (entry.topic if entry.topic in TOPIC_IDS else OTHER_TOPIC) for entry in active_entries
        }
        # Metadata propagation (video-ranking, Phase C correction): title/
        # thumbnailUrl/publishedAt/discoveredAt are read straight from the
        # tracking manifest's own already-persisted values (ultimately Video
        # Master, populated at discovery time from the YouTube response
        # already paid for) -- never a per-video DynamoDB read here.
        title_by_video = {entry.video_id: entry.title for entry in active_entries if entry.title is not None}
        thumbnail_by_video = {
            entry.video_id: entry.thumbnail_url for entry in active_entries if entry.thumbnail_url is not None
        }
        published_at_by_video = {
            entry.video_id: entry.published_at for entry in active_entries if entry.published_at is not None
        }
        discovered_at_by_video = {
            entry.video_id: entry.discovered_at for entry in active_entries if entry.discovered_at is not None
        }
        discovered_date_by_video = discovered_dates_by_video(active_entries)

        rows_by_creator: dict[str, list[HistoryRow]] = {}
        for row in today_rows:
            rows_by_creator.setdefault(row.creator_id, []).append(row)

        for creator_id, creator_today_rows in rows_by_creator.items():
            catalog_rows = build_creator_video_catalog(
                creator_today_rows,
                anchor_rows_by_days,
                creator_id=creator_id,
                report_date=report_date,
                topic_by_video=topic_by_video,
                discovered_date_by_video=discovered_date_by_video,
                title_by_video=title_by_video,
                thumbnail_by_video=thumbnail_by_video,
                published_at_by_video=published_at_by_video,
                discovered_at_by_video=discovered_at_by_video,
            )
            result = build_video_ranking_result(
                report_date=report_date, creator_id=creator_id, generated_at=generated_at, rows=catalog_rows
            )
            if result is not None:
                video_ranking_store.write_result(report_date, creator_id, result)
    except VideoRankingStoreError as exc:
        print(f"Warning: video ranking S3 write failed for reportDate={report_date.isoformat()}: {exc}")
    except Exception as exc:  # noqa: BLE001 -- deliberate: see this function's own docstring
        print(f"Warning: video ranking build/persist failed unexpectedly for reportDate={report_date.isoformat()}: {exc}")


def _mark_execution_complete(event: dict[str, Any]) -> dict[str, Any]:
    """Handle terraform/history.tf's `MarkExecutionComplete` state, reusing
    this same Lambda rather than a new function — it already has the
    execution_lock/DynamoDB access this needs, and this state only runs
    right after this same Lambda's own ReduceRankings invocation succeeded.
    """
    report_date = date.fromisoformat(event["markCompleteForDate"])
    owner_token = event["ownerToken"]
    execution_lock.mark_execution_complete(
        report_date=report_date,
        owner_token=owner_token,
        now=datetime.now(ZoneInfo(_TIME_ZONE)),
    )
    return {"date": report_date.isoformat(), "status": execution_lock.STATUS_COMPLETE}


def _mark_execution_failed(event: dict[str, Any]) -> dict[str, Any]:
    """Handle terraform/history.tf's `MarkExecutionFailed` state (the Catch
    target for both CollectHistoryShards and ReduceRankings).

    If execution_lock.mark_execution_failed itself raises
    ExecutionLockLostError (this owner's lease was already reclaimed), that
    exception is deliberately left to propagate rather than swallowed here —
    terraform/history.tf's own Catch on the MarkExecutionFailed state routes
    either outcome (this succeeding, or this itself failing) to the same
    terminal Fail state, so the original pipeline failure that triggered
    this call is never masked by a secondary conditional-write error.
    """
    report_date = date.fromisoformat(event["markFailedForDate"])
    owner_token = event["ownerToken"]
    error_message = event.get("error") or "unknown error"
    execution_lock.mark_execution_failed(
        report_date=report_date,
        owner_token=owner_token,
        now=datetime.now(ZoneInfo(_TIME_ZONE)),
        error_message=str(error_message),
    )
    return {"date": report_date.isoformat(), "status": execution_lock.STATUS_FAILED}
