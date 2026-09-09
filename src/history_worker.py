"""One independently retryable daily collection-shard worker."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Mapping

from history_ranking import CreatorDimensions, RankedGrowth, ScopeKey, load_exact_anchor_rows, top_n_by_scope
from history_store import HistoryRow, HistoryStore, shard_for_video
from tracking_manifest import TrackingManifestStore
from youtube_client import get_video_statistics


@dataclass(frozen=True)
class ShardCollectionResult:
    """In-memory outcome for one shard; no other shard is rolled back."""

    collection_date: date
    shard: int
    requested_count: int
    collected_count: int
    skipped: dict[str, str]
    history_key: str
    rows: list[HistoryRow]
    rankings: dict[ScopeKey, dict[str, list[RankedGrowth]]]


def collect_history_shard(
    *,
    youtube,
    collection_date: date,
    observed_at: str,
    shard: int,
    manifest_store: TrackingManifestStore,
    history_store: HistoryStore,
    dimensions_by_creator: Mapping[str, CreatorDimensions] | None = None,
    top_n: int = 100,
) -> ShardCollectionResult:
    """Collect and persist exactly one manifest shard.

    Retrying calls this function with the failed shard only. Its deterministic
    PutObject key is replaced idempotently; no scan/delete rollback exists.
    Today's rows remain in memory for ranking and are never read back from S3.
    """
    entries = [entry for entry in manifest_store.read_shard(shard) if entry.active]
    wrong_shard = [entry.video_id for entry in entries if shard_for_video(entry.video_id) != shard]
    if wrong_shard:
        raise ValueError(f"Manifest shard {shard:02d} contains misplaced videos: {sorted(wrong_shard)}")

    creator_by_video = {entry.video_id: entry.creator_id for entry in entries}
    video_ids = sorted(creator_by_video)
    videos, skipped = get_video_statistics(youtube, video_ids)
    rows = [
        HistoryRow(
            video_id=video["videoId"],
            creator_id=creator_by_video[video["videoId"]],
            view_count=video["viewCount"],
            observed_at=observed_at,
            availability_status="available",
        )
        for video in videos
    ]
    history_key = history_store.write_daily_shard(collection_date, shard, rows)
    anchors = load_exact_anchor_rows(history_store, report_date=collection_date, shard=shard)
    rankings = top_n_by_scope(
        rows,
        anchors,
        dimensions_by_creator=dimensions_by_creator,
        limit=top_n,
    )
    return ShardCollectionResult(
        collection_date=collection_date,
        shard=shard,
        requested_count=len(video_ids),
        collected_count=len(rows),
        skipped=skipped,
        history_key=history_key,
        rows=rows,
        rankings=rankings,
    )
