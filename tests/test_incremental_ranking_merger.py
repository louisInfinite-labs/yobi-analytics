"""Focused tests for history_ranking.IncrementalRankingMerger — the streaming,
bounded-accumulator replacement for holding every shard's own partial in
memory at once before calling merge_partial_rankings.

R8B (AWS Cost Recovery): this merger used to also fold each shard's
creator_partials into a second accumulator (creator_partials()) — removed
along with creator_period_partials/creatorSummary, once nothing production
still consumed a per-creator/per-period aggregate. See history_ranking.py's
own R8B note on IncrementalRankingMerger for the full explanation.
"""

from datetime import date

import pytest

from analytics.history_ranking import IncrementalRankingMerger, merge_partial_rankings, top_n_by_scope
from stores.history_store import HistoryRow

REPORT_DATE = date(2026, 9, 9)


def _row(video_id, count, creator_id="c1"):
    return HistoryRow(
        video_id=video_id,
        creator_id=creator_id,
        view_count=count,
        observed_at="2026-09-09T18:00:00+09:00",
        availability_status="available",
    )


def _shard_rankings(
    rows_per_shard: list[list[HistoryRow]], *, scope_limit: int = 100, discovered=None
):
    """Build each shard's own scope_rankings, exactly the way history_worker.
    collect_history_shard does today — one shard's own top_n_by_scope call
    over that shard's own rows."""
    return [
        top_n_by_scope(
            rows, {1: [], 7: [], 30: []}, report_date=REPORT_DATE, discovered_date_by_video=discovered, limit=scope_limit
        )
        for rows in rows_per_shard
    ]


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
    bundles = _shard_rankings(shards, scope_limit=2, discovered=discovered)

    batch_result = merge_partial_rankings(bundles, limit=2)

    merger = IncrementalRankingMerger(scope_limit=2)
    for scope in bundles:
        merger.add_shard(scope)
    incremental_result = merger.scope_rankings()

    assert incremental_result == batch_result
    assert [e.video_id for e in incremental_result[("creator", "c1")]["1d"]] == ["b1", "a1"]


def test_add_shard_never_lets_a_key_grow_past_its_limit_even_transiently():
    """Proxy for "never retain all shards' full contributions at once": after
    every single add_shard call (not just at the end), each accumulator key
    must already be trimmed back down to its bound -- proving the merge never
    holds more than one shard's own contribution on top of the running bound,
    never O(shard_count) worth of raw entries."""
    merger = IncrementalRankingMerger(scope_limit=3)
    for shard_index in range(16):
        rows = [_row(f"s{shard_index}_v{i}", 1000 * shard_index + i, "c1") for i in range(50)]
        discovered = {row.video_id: REPORT_DATE for row in rows}
        scope = top_n_by_scope(
            rows,
            {1: [], 7: [], 30: []},
            report_date=REPORT_DATE,
            discovered_date_by_video=discovered,
            limit=3,
        )

        merger.add_shard(scope)

        for candidates in merger._scope_candidates.values():
            assert len(candidates) <= 3

    # After all 16 shards (16 * 50 = 800 videos total for creator c1), the
    # final Top-3 must correctly be the 3 highest-value videos overall --
    # proving boundedness didn't come at the cost of correctness. "7d" (not
    # "all", which top_n_by_scope never produces -- only creator_period_
    # partials did) since every row above was discovered "today", giving it
    # the new-video zero-baseline (value = its own view_count) on every
    # exact-anchor period alike.
    result = merger.scope_rankings()
    assert [e.video_id for e in result[("creator", "c1")]["7d"]] == ["s15_v49", "s15_v48", "s15_v47"]


def test_incremental_ranking_merger_rejects_a_non_positive_limit():
    with pytest.raises(ValueError):
        IncrementalRankingMerger(scope_limit=0)
