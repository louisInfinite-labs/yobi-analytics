"""Focused tests for history_ranking.IncrementalRankingMerger — the streaming,
bounded-accumulator replacement for holding every shard's own partial in
memory at once before calling merge_partial_rankings/merge_creator_period_partials.
"""

from datetime import date

import pytest

from history_ranking import (
    ALL_PERIOD,
    IncrementalRankingMerger,
    creator_period_partials,
    merge_creator_period_partials,
    merge_partial_rankings,
    top_n_by_scope,
)
from history_store import HistoryRow

REPORT_DATE = date(2026, 9, 9)


def _row(video_id, count, creator_id="c1"):
    return HistoryRow(
        video_id=video_id,
        creator_id=creator_id,
        view_count=count,
        observed_at="2026-09-09T18:00:00+09:00",
        availability_status="available",
    )


def _shard_bundles(
    rows_per_shard: list[list[HistoryRow]], *, scope_limit: int = 100, creator_limit: int = 10, discovered=None
):
    """Build each shard's own (scope_rankings, creator_partials) pair, exactly
    the way history_worker.collect_history_shard does today — one shard's own
    top_n_by_scope/creator_period_partials call over that shard's own rows."""
    bundles = []
    for rows in rows_per_shard:
        scope = top_n_by_scope(
            rows, {1: [], 7: [], 30: []}, report_date=REPORT_DATE, discovered_date_by_video=discovered, limit=scope_limit
        )
        creator = creator_period_partials(
            rows, {1: [], 7: [], 30: []}, report_date=REPORT_DATE, discovered_date_by_video=discovered, limit=creator_limit
        )
        bundles.append((scope, creator))
    return bundles


def test_incremental_scope_ranking_matches_the_batch_merge_result():
    """The streaming merger must produce byte-for-byte the same scope Top-N a
    single merge_partial_rankings([...all shards' partials...]) call would."""
    shards = [
        [_row("a1", 500, "c1"), _row("a2", 300, "c1")],
        [_row("b1", 900, "c1"), _row("b2", 100, "c1")],
        [_row("c1v", 50, "c1")],
    ]
    # No real anchors below (top_n_by_scope only ever ranks 1d/7d/30d, never
    # "all") -- discovered "today" so each video's missing anchor resolves to
    # the new-video baseline (value = its own view_count), not an incomplete gap.
    discovered = {row.video_id: REPORT_DATE for shard in shards for row in shard}
    bundles = _shard_bundles(shards, scope_limit=2, discovered=discovered)

    batch_result = merge_partial_rankings([scope for scope, _ in bundles], limit=2)

    merger = IncrementalRankingMerger(scope_limit=2, creator_limit=10)
    for scope, creator in bundles:
        merger.add_shard(scope, creator)
    incremental_result = merger.scope_rankings()

    assert incremental_result == batch_result
    assert [e.video_id for e in incremental_result[("creator", "c1")]["1d"]] == ["b1", "a1"]


def test_incremental_creator_partials_match_the_batch_merge_result():
    """Same equivalence proof for the creator-period aggregates: sums, counts,
    and Top-N candidates must match merge_creator_period_partials exactly."""
    shards = [
        [_row("a1", 500, "c1"), _row("a2", 300, "c2")],
        [_row("b1", 900, "c1"), _row("b2", 100, "c2")],
        [_row("c1v", 50, "c1")],
    ]
    bundles = _shard_bundles(shards, creator_limit=2)

    batch_result = merge_creator_period_partials([creator for _, creator in bundles], limit=2)

    merger = IncrementalRankingMerger(scope_limit=100, creator_limit=2)
    for scope, creator in bundles:
        merger.add_shard(scope, creator)
    incremental_result = merger.creator_partials()

    assert incremental_result == batch_result
    assert incremental_result["c1"][ALL_PERIOD].view_sum == 500 + 900 + 50
    assert incremental_result["c1"][ALL_PERIOD].catalog_video_count == 3
    assert [c.video_id for c in incremental_result["c1"][ALL_PERIOD].top_candidates] == ["b1", "a1"]
    assert incremental_result["c2"][ALL_PERIOD].view_sum == 300 + 100


def test_add_shard_never_lets_a_key_grow_past_its_limit_even_transiently():
    """Proxy for "never retain all shards' full contributions at once": after
    every single add_shard call (not just at the end), each accumulator key
    must already be trimmed back down to its bound -- proving the merge never
    holds more than one shard's own contribution on top of the running bound,
    never O(shard_count) worth of raw entries."""
    merger = IncrementalRankingMerger(scope_limit=3, creator_limit=3)
    for shard_index in range(16):
        rows = [_row(f"s{shard_index}_v{i}", 1000 * shard_index + i, "c1") for i in range(50)]
        scope = top_n_by_scope(rows, {1: [], 7: [], 30: []}, report_date=REPORT_DATE, limit=3)
        creator = creator_period_partials(rows, {1: [], 7: [], 30: []}, report_date=REPORT_DATE, limit=3)

        merger.add_shard(scope, creator)

        for candidates in merger._scope_candidates.values():
            assert len(candidates) <= 3
        for candidates in merger._creator_candidates.values():
            assert len(candidates) <= 3

    # After all 16 shards (16 * 50 = 800 videos total for creator c1), the
    # final Top-3 must correctly be the 3 highest-value videos overall --
    # proving boundedness didn't come at the cost of correctness.
    result = merger.creator_partials()
    assert [c.video_id for c in result["c1"][ALL_PERIOD].top_candidates] == ["s15_v49", "s15_v48", "s15_v47"]
    assert result["c1"][ALL_PERIOD].catalog_video_count == 16 * 50


def test_incremental_ranking_merger_rejects_a_non_positive_limit():
    with pytest.raises(ValueError):
        IncrementalRankingMerger(scope_limit=0)
    with pytest.raises(ValueError):
        IncrementalRankingMerger(creator_limit=-1)
