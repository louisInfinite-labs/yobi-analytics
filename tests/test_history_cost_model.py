from history_cost_model import (
    CollectionWorkload,
    RankingScopeCounts,
    estimate_legacy_dynamodb_history,
    estimate_sharded_s3_history,
    estimate_windows,
    reduction_percent,
)
from history_store import HISTORY_SHARD_COUNT
from youtube_client import MAX_IDS_PER_REQUEST


def test_sharded_s3_history_storage_counts_do_not_grow_with_history_window_width():
    scopes = RankingScopeCounts(creators=100, organizations=2, branches=5)
    per_day = []

    for days in (30, 60, 90, 180):
        estimate = estimate_sharded_s3_history(
            CollectionWorkload(video_count=126_000, day_count=days, ranking_scopes=scopes)
        )
        per_day.append(
            (
                estimate.s3_gets // days,
                estimate.s3_puts // days,
                estimate.dynamodb_writes // days,
            )
        )

    assert per_day == [(80, 48, 324)] * 4


def test_new_architecture_removes_per_video_daily_dynamodb_history_writes():
    scopes = RankingScopeCounts(creators=100, organizations=2, branches=5)
    workload = CollectionWorkload(video_count=126_000, day_count=30, ranking_scopes=scopes)

    legacy = estimate_legacy_dynamodb_history(workload)
    redesigned = estimate_sharded_s3_history(workload)

    assert legacy.youtube_api_requests == redesigned.youtube_api_requests
    assert legacy.youtube_api_requests == (126_000 // MAX_IDS_PER_REQUEST) * 30
    assert legacy.dynamodb_writes == 7_569_750
    assert redesigned.dynamodb_writes == 9_720
    assert redesigned.s3_puts == HISTORY_SHARD_COUNT * 3 * 30
    assert reduction_percent(legacy.storage_writes, redesigned.storage_writes) > 99.8


def test_creator_and_global_ranking_reads_are_top_n_bounded_in_new_architecture():
    scopes = RankingScopeCounts(creators=100, organizations=2, branches=5)
    workload = CollectionWorkload(video_count=126_000, day_count=30, ranking_scopes=scopes, top_n=100)

    legacy = estimate_legacy_dynamodb_history(workload)
    redesigned = estimate_sharded_s3_history(workload)

    assert legacy.dynamodb_reads == 90_720_000
    assert redesigned.dynamodb_reads == 972_000
    assert redesigned.s3_gets == 2_400
    assert reduction_percent(legacy.storage_reads, redesigned.storage_reads) > 98.9


def test_common_recollection_windows_are_available_for_claude_code_review():
    estimates = estimate_windows(
        video_count=126_000,
        creator_count=100,
        organization_count=2,
        branch_count=5,
    )

    assert set(estimates) == {30, 60, 90, 180}
    assert estimates[180]["legacy_dynamodb"].youtube_api_requests == estimates[180]["sharded_s3"].youtube_api_requests
    assert estimates[180]["sharded_s3"].s3_gets == 14_400
    assert estimates[180]["sharded_s3"].s3_puts == 8_640
    assert estimates[180]["sharded_s3"].dynamodb_writes == 58_320
