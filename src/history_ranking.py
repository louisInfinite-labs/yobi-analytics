"""Exact-anchor, bounded Top-N ranking over freshly collected history rows."""

from __future__ import annotations

import heapq
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Mapping

from history_store import EXACT_ANCHOR_DAYS, HistoryRow, HistoryStore

ScopeKey = tuple[str, str]


@dataclass(frozen=True)
class CreatorDimensions:
    """Small master-data projection needed to assign ranking scopes."""

    organization: str | None = None
    branch: str | None = None


@dataclass(frozen=True)
class RankedGrowth:
    """One bounded ranking result derived from an exact historical anchor."""

    rank: int
    video_id: str
    creator_id: str
    period: str
    view_count: int
    anchor_view_count: int
    gain: int
    observed_at: str


def load_exact_anchor_rows(
    store: HistoryStore, *, report_date: date, shard: int
) -> dict[int, list[HistoryRow]]:
    """Read exactly D-1, D-7 and D-30 for one shard, never nearby dates."""
    return {
        days: store.read_daily_shard(report_date - timedelta(days=days), shard)
        for days in EXACT_ANCHOR_DAYS
    }


def exact_gains(
    today_rows: list[HistoryRow],
    anchor_rows: Mapping[int, list[HistoryRow]],
) -> dict[str, dict[int, int | None]]:
    """Calculate exact gains; a missing anchor remains unavailable (None)."""
    anchor_counts = {
        days: {row.video_id: row.view_count for row in anchor_rows.get(days, [])}
        for days in EXACT_ANCHOR_DAYS
    }
    return {
        row.video_id: {
            days: (
                row.view_count - anchor_counts[days][row.video_id]
                if row.video_id in anchor_counts[days]
                else None
            )
            for days in EXACT_ANCHOR_DAYS
        }
        for row in today_rows
    }


def top_n_by_scope(
    today_rows: list[HistoryRow],
    anchor_rows: Mapping[int, list[HistoryRow]],
    *,
    dimensions_by_creator: Mapping[str, CreatorDimensions] | None = None,
    limit: int = 100,
) -> dict[ScopeKey, dict[str, list[RankedGrowth]]]:
    """Consider every collected row while retaining only Top-N per scope/window.

    Today's counts are consumed directly from the in-memory rows. Only the
    three exact historical anchors are supplied from storage, so history age
    never widens the logical read window.
    """
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
        raise ValueError(f"limit must be a positive integer, got {limit!r}")
    dimensions_by_creator = dimensions_by_creator or {}
    gains = exact_gains(today_rows, anchor_rows)
    heaps: dict[tuple[ScopeKey, int], list[tuple[int, int, HistoryRow, int]]] = {}

    # Sorting gives deterministic tie-breaking without retaining all results.
    for sequence, row in enumerate(sorted(today_rows, key=lambda item: item.video_id)):
        scopes = _scopes_for(row, dimensions_by_creator.get(row.creator_id))
        for days in EXACT_ANCHOR_DAYS:
            gain = gains[row.video_id][days]
            if gain is None:
                continue
            for scope in scopes:
                heap = heaps.setdefault((scope, days), [])
                candidate = (gain, -sequence, row, gain)
                if len(heap) < limit:
                    heapq.heappush(heap, candidate)
                elif candidate[:2] > heap[0][:2]:
                    heapq.heapreplace(heap, candidate)

    result: dict[ScopeKey, dict[str, list[RankedGrowth]]] = {}
    for (scope, days), heap in heaps.items():
        ordered = sorted(heap, key=lambda item: (-item[0], item[2].video_id))
        period = f"{days}d"
        result.setdefault(scope, {})[period] = [
            RankedGrowth(
                rank=rank,
                video_id=row.video_id,
                creator_id=row.creator_id,
                period=period,
                view_count=row.view_count,
                anchor_view_count=row.view_count - gain,
                gain=gain,
                observed_at=row.observed_at,
            )
            for rank, (_, _, row, gain) in enumerate(ordered, start=1)
        ]
    return result


def merge_partial_rankings(
    partials: list[dict[ScopeKey, dict[str, list[RankedGrowth]]]],
    *,
    limit: int = 100,
) -> dict[ScopeKey, dict[str, list[RankedGrowth]]]:
    """Merge per-shard Top-N results without materializing all video growth."""
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
        raise ValueError(f"limit must be a positive integer, got {limit!r}")
    grouped: dict[tuple[ScopeKey, str], list[RankedGrowth]] = {}
    for partial in partials:
        for scope, periods in partial.items():
            for period, entries in periods.items():
                grouped.setdefault((scope, period), []).extend(entries)

    merged: dict[ScopeKey, dict[str, list[RankedGrowth]]] = {}
    for (scope, period), entries in grouped.items():
        winners = heapq.nsmallest(limit, entries, key=lambda entry: (-entry.gain, entry.video_id))
        merged.setdefault(scope, {})[period] = [
            RankedGrowth(
                rank=rank,
                video_id=entry.video_id,
                creator_id=entry.creator_id,
                period=entry.period,
                view_count=entry.view_count,
                anchor_view_count=entry.anchor_view_count,
                gain=entry.gain,
                observed_at=entry.observed_at,
            )
            for rank, entry in enumerate(winners, start=1)
        ]
    return merged


def _scopes_for(row: HistoryRow, dimensions: CreatorDimensions | None) -> list[ScopeKey]:
    scopes: list[ScopeKey] = [("global", "global"), ("creator", row.creator_id)]
    if dimensions is not None:
        if dimensions.organization:
            scopes.append(("organization", dimensions.organization))
        if dimensions.branch:
            scopes.append(("branch", dimensions.branch))
    return scopes
