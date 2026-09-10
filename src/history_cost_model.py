"""Local operation-count model for the history storage redesign.

The model intentionally estimates request/read/write counts rather than cloud
currency. Provider prices and free tiers change; these counts are stable enough
to compare the old DynamoDB-history shape with the new S3-sharded shape before
deployment.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import ceil

from history_store import EXACT_ANCHOR_DAYS, HISTORY_SHARD_COUNT
from youtube_client import MAX_IDS_PER_REQUEST

PERIODS_PER_RANKING_RUN = len(EXACT_ANCHOR_DAYS)


@dataclass(frozen=True)
class RankingScopeCounts:
    """How many final Top-N ranking scopes the dashboard needs."""

    creators: int
    organizations: int
    branches: int
    include_global: bool = True

    @property
    def total(self) -> int:
        return self.creators + self.organizations + self.branches + (1 if self.include_global else 0)

    @property
    def scope_families(self) -> int:
        """Global/creator/org/branch families that each cover the catalog once."""
        return 1 + int(self.creators > 0) + int(self.organizations > 0) + int(self.branches > 0)


@dataclass(frozen=True)
class CollectionWorkload:
    """One local simulation workload."""

    video_count: int
    day_count: int
    ranking_scopes: RankingScopeCounts
    top_n: int = 100
    shard_count: int = HISTORY_SHARD_COUNT
    youtube_batch_size: int = MAX_IDS_PER_REQUEST

    def __post_init__(self) -> None:
        if self.video_count < 0:
            raise ValueError("video_count must be non-negative")
        if self.day_count < 1:
            raise ValueError("day_count must be positive")
        if self.top_n < 1:
            raise ValueError("top_n must be positive")
        if self.shard_count < 1:
            raise ValueError("shard_count must be positive")
        if self.youtube_batch_size < 1:
            raise ValueError("youtube_batch_size must be positive")


@dataclass(frozen=True)
class OperationEstimate:
    """Request/read/write count estimate for one architecture."""

    youtube_api_requests: int
    dynamodb_reads: int
    dynamodb_writes: int
    s3_gets: int
    s3_puts: int
    trending_cache_writes: int

    @property
    def storage_reads(self) -> int:
        return self.dynamodb_reads + self.s3_gets

    @property
    def storage_writes(self) -> int:
        return self.dynamodb_writes + self.s3_puts


def estimate_legacy_dynamodb_history(workload: CollectionWorkload) -> OperationEstimate:
    """Estimate the retired per-video-per-day DynamoDB history design.

    Assumptions match the behavior Phase 1 is removing:
    every observed video becomes one permanent YobiSnapshots item, daily
    scheduler state rewrites touch VideoMaster, and ranking reads two snapshot
    items per video for every period/scope family it computes.
    """
    youtube_requests = _youtube_requests(workload)
    snapshot_writes = workload.video_count * workload.day_count
    run_summary_writes = workload.day_count
    scheduler_rewrites = workload.video_count * workload.day_count
    cache_writes = _trending_cache_writes(workload)
    ranking_snapshot_reads = (
        workload.video_count
        * 2
        * PERIODS_PER_RANKING_RUN
        * workload.ranking_scopes.scope_families
        * workload.day_count
    )
    return OperationEstimate(
        youtube_api_requests=youtube_requests,
        dynamodb_reads=ranking_snapshot_reads,
        dynamodb_writes=snapshot_writes + run_summary_writes + scheduler_rewrites + cache_writes,
        s3_gets=0,
        s3_puts=0,
        trending_cache_writes=cache_writes,
    )


def estimate_sharded_s3_history(workload: CollectionWorkload, *, publish_manifest_daily: bool = True) -> OperationEstimate:
    """Estimate the Phase 1 sharded S3 Parquet design.

    Today's rows are kept in memory. Each day reads only fixed anchors
    (D-1/D-7/D-30) per shard, writes one history object and one bounded partial
    ranking object per shard, then the reducer writes only final Top-N cache
    entries and reads at most the unique videos that appear in those final lists.
    """
    youtube_requests = _youtube_requests(workload)
    cache_writes = _trending_cache_writes(workload)
    manifest_puts = workload.shard_count if publish_manifest_daily else 0
    s3_puts_per_day = workload.shard_count + workload.shard_count + manifest_puts
    s3_gets_per_day = workload.shard_count + workload.shard_count * PERIODS_PER_RANKING_RUN + workload.shard_count
    max_top_result_video_reads = min(
        workload.video_count,
        workload.ranking_scopes.total * PERIODS_PER_RANKING_RUN * workload.top_n,
    )
    return OperationEstimate(
        youtube_api_requests=youtube_requests,
        dynamodb_reads=max_top_result_video_reads * workload.day_count,
        dynamodb_writes=cache_writes,
        s3_gets=s3_gets_per_day * workload.day_count,
        s3_puts=s3_puts_per_day * workload.day_count,
        trending_cache_writes=cache_writes,
    )


def estimate_windows(
    *,
    video_count: int,
    creator_count: int,
    organization_count: int,
    branch_count: int,
    windows: tuple[int, ...] = (30, 60, 90, 180),
    top_n: int = 100,
) -> dict[int, dict[str, OperationEstimate]]:
    """Compare old and new operation counts for common history lengths."""
    scopes = RankingScopeCounts(
        creators=creator_count,
        organizations=organization_count,
        branches=branch_count,
    )
    estimates = {}
    for day_count in windows:
        workload = CollectionWorkload(
            video_count=video_count,
            day_count=day_count,
            ranking_scopes=scopes,
            top_n=top_n,
        )
        estimates[day_count] = {
            "legacy_dynamodb": estimate_legacy_dynamodb_history(workload),
            "sharded_s3": estimate_sharded_s3_history(workload),
        }
    return estimates


def reduction_percent(old: int, new: int) -> float:
    if old == 0:
        return 0.0
    return (old - new) / old * 100


def _youtube_requests(workload: CollectionWorkload) -> int:
    return ceil(workload.video_count / workload.youtube_batch_size) * workload.day_count


def _trending_cache_writes(workload: CollectionWorkload) -> int:
    return workload.ranking_scopes.total * PERIODS_PER_RANKING_RUN * workload.day_count
