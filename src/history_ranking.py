"""Exact-anchor, bounded Top-N ranking over freshly collected history rows."""

from __future__ import annotations

import heapq
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Mapping

from history_store import EXACT_ANCHOR_DAYS, HistoryRow, HistoryStore

ScopeKey = tuple[str, str]

# The fallback discovered_date for a video _period_value has no real
# discovery-date evidence for (an old manifest entry with no discovered_at,
# or a caller that doesn't track it at all). Deliberately date.min, not
# view_growth_analytics.COLLECTION_START_DATE: COLLECTION_START_DATE
# (2026-08-29) is not guaranteed to be <= every anchor_date this module
# ever computes — during this pipeline's own first 30 days of operation, a
# 30d anchor_date (report_date - 30) can fall *before* COLLECTION_START_DATE,
# which would make an unknown-discovery video satisfy
# "discovered_date > anchor_date" and get misclassified as a new video
# purely because its discovery date wasn't recorded, exactly the "assume
# new because a field is missing" outcome this rule must never produce.
# date.min has no such failure window — it is <= any real calendar date,
# so an unknown discovered_date always resolves to the conservative
# "existing video, real gap" (None) branch, never "new" (baseline 0).
UNKNOWN_DISCOVERED_DATE = date.min


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


def _period_value(
    *,
    latest_view_count: int,
    anchor_view_count: int | None,
    anchor_date: date,
    discovered_date: date,
) -> int | None:
    """The one shared new-video-baseline rule every period computation in this
    module applies when a specific anchor snapshot is missing (Roadmap 5.x).

    - A real anchor snapshot always wins: latest - anchor. Never touches
      `discovered_date` at all in this case.
    - No anchor, but the video wasn't discovered/tracked until after this
      anchor's own date: the window in question opened after the video
      already had zero history by definition — its baseline for that
      window truly is 0, a genuine fact about a video that didn't exist
      yet, not a fabricated value. This is what lets a video collected for
      only 1-2 days still enter the 7d/30d ranking with its full
      accumulated view count counted as that period's value.
    - No anchor, and the video was already being tracked on or before this
      anchor's date: a real collection gap, not "new" — returns None
      (incomplete) so a caller never silently substitutes 0 or the latest
      count for data that should exist but doesn't.
    """
    if anchor_view_count is not None:
        return latest_view_count - anchor_view_count
    if discovered_date > anchor_date:
        return latest_view_count
    return None


def exact_gains(
    today_rows: list[HistoryRow],
    anchor_rows: Mapping[int, list[HistoryRow]],
    *,
    report_date: date,
    discovered_date_by_video: Mapping[str, date] | None = None,
) -> dict[str, dict[int, int | None]]:
    """Calculate exact gains against each anchor, applying _period_value's shared
    new-video-baseline rule when a specific anchor snapshot is missing.

    `discovered_date_by_video` is deliberately conservative when a video is
    absent from it (an old manifest entry with no recorded discovered_at,
    or a caller that doesn't track it at all): it falls back to
    UNKNOWN_DISCOVERED_DATE (date.min) — never "unknown, so assume new". A
    missing anchor for such a video is always treated as a real gap
    (None), exactly matching this function's pre-existing behavior for any
    caller that doesn't pass discovered_date_by_video at all.
    """
    discovered_date_by_video = discovered_date_by_video or {}
    anchor_counts = {
        days: {row.video_id: row.view_count for row in anchor_rows.get(days, [])}
        for days in EXACT_ANCHOR_DAYS
    }
    anchor_dates = {days: report_date - timedelta(days=days) for days in EXACT_ANCHOR_DAYS}
    return {
        row.video_id: {
            days: _period_value(
                latest_view_count=row.view_count,
                anchor_view_count=anchor_counts[days].get(row.video_id),
                anchor_date=anchor_dates[days],
                discovered_date=discovered_date_by_video.get(row.video_id, UNKNOWN_DISCOVERED_DATE),
            )
            for days in EXACT_ANCHOR_DAYS
        }
        for row in today_rows
    }


def top_n_by_scope(
    today_rows: list[HistoryRow],
    anchor_rows: Mapping[int, list[HistoryRow]],
    *,
    report_date: date,
    discovered_date_by_video: Mapping[str, date] | None = None,
    dimensions_by_creator: Mapping[str, CreatorDimensions] | None = None,
    limit: int = 100,
) -> dict[ScopeKey, dict[str, list[RankedGrowth]]]:
    """Consider every collected row while retaining only Top-N per scope/window.

    Today's counts are consumed directly from the in-memory rows. Only the
    three exact historical anchors are supplied from storage, so history age
    never widens the logical read window. A video with no anchor for a
    given window is still ranked in it (value = its full latest view count)
    when `discovered_date_by_video` shows it wasn't tracked yet as of that
    anchor's date — see exact_gains/_period_value for the shared rule.
    """
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
        raise ValueError(f"limit must be a positive integer, got {limit!r}")
    dimensions_by_creator = dimensions_by_creator or {}
    gains = exact_gains(today_rows, anchor_rows, report_date=report_date, discovered_date_by_video=discovered_date_by_video)
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


ALL_PERIOD = "all"
# 1d/7d/30d = exact gain vs that anchor (None if the anchor is missing);
# "all" = the video's own latest collected view_count, which needs no
# historical anchor and is therefore never None.
PERIODS = tuple(f"{days}d" for days in EXACT_ANCHOR_DAYS) + (ALL_PERIOD,)

CREATOR_TOP_N = 10


def period_values(
    today_rows: list[HistoryRow],
    anchor_rows: Mapping[int, list[HistoryRow]],
    *,
    report_date: date,
    discovered_date_by_video: Mapping[str, date] | None = None,
) -> dict[str, dict[str, int | None]]:
    """video_id -> {period: value}, covering every period in PERIODS (1d/7d/30d/all).

    A thin superset of exact_gains: reuses it unchanged for 1d/7d/30d
    (same shared new-video-baseline rule, see _period_value) and adds
    "all" = the row's own view_count, which needs no anchor and is never
    None. Kept separate from exact_gains/top_n_by_scope (which only ever
    handle 1d/7d/30d) since "all" has no matching entry in
    EXACT_ANCHOR_DAYS for that function's own anchor-reading loop.
    """
    gains = exact_gains(today_rows, anchor_rows, report_date=report_date, discovered_date_by_video=discovered_date_by_video)
    return {
        row.video_id: {
            **{f"{days}d": gains[row.video_id][days] for days in EXACT_ANCHOR_DAYS},
            ALL_PERIOD: row.view_count,
        }
        for row in today_rows
    }


@dataclass(frozen=True)
class CreatorPeriodPartial:
    """One creator's contribution to one period — from a single shard's own
    subset of that creator's videos, or already merged across every shard.

    `view_sum` is the sum over only the *eligible* videos (those with a
    real anchor, or a defensible new-video baseline — see _period_value);
    it's meaningless to add an incomplete (None) video's unknown value.
    `catalog_video_count` is every video this creator had in the input
    rows, regardless of eligibility; `eligible_video_count` is the subset
    that actually got a value for this period. `is_complete` tells a
    caller whether those two numbers matched — false means at least one of
    this creator's videos has a real collection gap for this period, not
    that the creator has no data at all. Neither count is ever bounded: a
    creator with 2,000+ videos still has every one of them counted here
    across however many shards it takes — the background worker computing
    this must never borrow the read API's own MAX_LIVE_FALLBACK_VIDEOS
    live-fallback guard (read_api.py), which bounds an unrelated on-demand
    computation, not this scheduled one. `top_candidates` is the only
    bounded field (at most `limit` entries, highest value first, so
    `top_candidates[0]` is this partial's own highest-value video) —
    retaining every video's own RankedGrowth across all shards centrally,
    just to find the true Top-10, is exactly the "126,000 sorted results
    in memory" this avoids.
    """

    creator_id: str
    period: str
    view_sum: int
    catalog_video_count: int
    eligible_video_count: int
    top_candidates: list[RankedGrowth]

    @property
    def is_complete(self) -> bool:
        return self.eligible_video_count == self.catalog_video_count


def creator_period_partials(
    today_rows: list[HistoryRow],
    anchor_rows: Mapping[int, list[HistoryRow]],
    *,
    report_date: date,
    discovered_date_by_video: Mapping[str, date] | None = None,
    limit: int = CREATOR_TOP_N,
) -> dict[str, dict[str, CreatorPeriodPartial]]:
    """Bounded per-creator, per-period partial aggregate from one shard's rows.

    Mirrors top_n_by_scope's own shape (bounded heap per key, deterministic
    tie-break by video_id) but keyed by creator_id alone (not creator/org/
    branch/global scope) and additionally tracking the exact, unbounded sum
    and catalog/eligible counts alongside the bounded Top-N candidate heap.
    """
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
        raise ValueError(f"limit must be a positive integer, got {limit!r}")
    values = period_values(today_rows, anchor_rows, report_date=report_date, discovered_date_by_video=discovered_date_by_video)
    heaps: dict[tuple[str, str], list[tuple[int, int, HistoryRow, int]]] = {}
    sums: dict[tuple[str, str], int] = {}
    catalog_counts: dict[tuple[str, str], int] = {}
    eligible_counts: dict[tuple[str, str], int] = {}

    for sequence, row in enumerate(sorted(today_rows, key=lambda item: item.video_id)):
        for period in PERIODS:
            key = (row.creator_id, period)
            catalog_counts[key] = catalog_counts.get(key, 0) + 1
            value = values[row.video_id][period]
            if value is None:
                continue
            sums[key] = sums.get(key, 0) + value
            eligible_counts[key] = eligible_counts.get(key, 0) + 1
            heap = heaps.setdefault(key, [])
            candidate = (value, -sequence, row, value)
            if len(heap) < limit:
                heapq.heappush(heap, candidate)
            elif candidate[:2] > heap[0][:2]:
                heapq.heapreplace(heap, candidate)

    result: dict[str, dict[str, CreatorPeriodPartial]] = {}
    for (creator_id, period), catalog_count in catalog_counts.items():
        heap = heaps.get((creator_id, period), [])
        ordered = sorted(heap, key=lambda item: (-item[0], item[2].video_id))
        top_candidates = [
            RankedGrowth(
                rank=rank,
                video_id=row.video_id,
                creator_id=row.creator_id,
                period=period,
                view_count=row.view_count,
                anchor_view_count=row.view_count - value,
                gain=value,
                observed_at=row.observed_at,
            )
            for rank, (_, _, row, value) in enumerate(ordered, start=1)
        ]
        result.setdefault(creator_id, {})[period] = CreatorPeriodPartial(
            creator_id=creator_id,
            period=period,
            view_sum=sums.get((creator_id, period), 0),
            catalog_video_count=catalog_count,
            eligible_video_count=eligible_counts.get((creator_id, period), 0),
            top_candidates=top_candidates,
        )
    return result


def merge_creator_period_partials(
    partials: list[dict[str, dict[str, CreatorPeriodPartial]]],
    *,
    limit: int = CREATOR_TOP_N,
) -> dict[str, dict[str, CreatorPeriodPartial]]:
    """Merge every shard's bounded per-creator partial into each creator's
    final, exact total and final Top-N.

    view_sum/catalog_video_count/eligible_video_count are plain sums across
    every shard's own partial (already exact per shard, so summing them is
    exact overall — never truncated). Only the Top-N candidate lists are
    merged and re-trimmed; the reducer never materializes more than
    `limit` RankedGrowth rows per (creator, period) at a time, the same
    discipline merge_partial_rankings already applies at the video-ranking
    level.
    """
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
        raise ValueError(f"limit must be a positive integer, got {limit!r}")
    sums: dict[tuple[str, str], int] = {}
    catalog_counts: dict[tuple[str, str], int] = {}
    eligible_counts: dict[tuple[str, str], int] = {}
    candidates: dict[tuple[str, str], list[RankedGrowth]] = {}
    for partial in partials:
        for creator_id, periods in partial.items():
            for period, agg in periods.items():
                key = (creator_id, period)
                sums[key] = sums.get(key, 0) + agg.view_sum
                catalog_counts[key] = catalog_counts.get(key, 0) + agg.catalog_video_count
                eligible_counts[key] = eligible_counts.get(key, 0) + agg.eligible_video_count
                candidates.setdefault(key, []).extend(agg.top_candidates)

    merged: dict[str, dict[str, CreatorPeriodPartial]] = {}
    for (creator_id, period), entries in candidates.items():
        winners = heapq.nsmallest(limit, entries, key=lambda entry: (-entry.gain, entry.video_id))
        top_candidates = [
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
        merged.setdefault(creator_id, {})[period] = CreatorPeriodPartial(
            creator_id=creator_id,
            period=period,
            view_sum=sums[(creator_id, period)],
            catalog_video_count=catalog_counts[(creator_id, period)],
            eligible_video_count=eligible_counts[(creator_id, period)],
            top_candidates=top_candidates,
        )
    return merged


class IncrementalRankingMerger:
    """Folds one shard's scope-ranking + creator-partial output into bounded
    running accumulators at a time, instead of a reducer holding every
    shard's own partial in memory simultaneously before merging any of them
    (the way merge_partial_rankings/merge_creator_period_partials require,
    since both take the *whole* `partials` list up front).

    `add_shard` is called once per shard, in any order, and its argument
    (typically straight from ranking_partial_store.S3PartialRankingStore.
    read_bundle) can be discarded immediately afterward — nothing from it
    is retained beyond what's already folded into the bounded accumulator.
    scope_rankings()/creator_partials() (called once, after every shard has
    been folded in) produce byte-for-byte the same result
    merge_partial_rankings/merge_creator_period_partials would from the
    same shards' full batch — see the class-level proof below.

    Why this produces the identical result as the batch merge: at every
    step, each (scope, period) or (creator, period) key's accumulator holds
    at most `limit` entries — already the true top-`limit` of everything
    folded in *so far*. Folding in one more shard's own (already <= limit)
    contribution and re-selecting the top-`limit` of (current accumulator
    + new contribution) can only ever discard an entry once at least
    `limit` other entries already outrank it among everything seen so far
    — and every later shard only ever adds more competing entries, never
    removes any accumulator member without an equal-or-better replacement.
    So nothing discarded at any step could ever have been part of the true
    global top-`limit` computed from every shard's entries at once. This is
    the standard streaming top-k accumulation argument, not specific to
    this codebase.
    """

    def __init__(self, *, scope_limit: int = 100, creator_limit: int = CREATOR_TOP_N):
        if isinstance(scope_limit, bool) or not isinstance(scope_limit, int) or scope_limit < 1:
            raise ValueError(f"scope_limit must be a positive integer, got {scope_limit!r}")
        if isinstance(creator_limit, bool) or not isinstance(creator_limit, int) or creator_limit < 1:
            raise ValueError(f"creator_limit must be a positive integer, got {creator_limit!r}")
        self._scope_limit = scope_limit
        self._creator_limit = creator_limit
        self._scope_candidates: dict[tuple[ScopeKey, str], list[RankedGrowth]] = {}
        self._creator_view_sums: dict[tuple[str, str], int] = {}
        self._creator_catalog_counts: dict[tuple[str, str], int] = {}
        self._creator_eligible_counts: dict[tuple[str, str], int] = {}
        self._creator_candidates: dict[tuple[str, str], list[RankedGrowth]] = {}

    def add_shard(
        self,
        scope_rankings: dict[ScopeKey, dict[str, list[RankedGrowth]]],
        creator_partials: dict[str, dict[str, CreatorPeriodPartial]],
    ) -> None:
        """Fold one shard's already-bounded contribution into the running merge.

        Both arguments are exactly one shard's own output (e.g.
        top_n_by_scope's and creator_period_partials' own return values, or
        one read_bundle() call) — this never re-derives anything from raw
        HistoryRows, only combines already-bounded per-shard results.
        """
        for scope, periods in scope_rankings.items():
            for period, entries in periods.items():
                key = (scope, period)
                combined = self._scope_candidates.get(key, []) + entries
                self._scope_candidates[key] = heapq.nsmallest(
                    self._scope_limit, combined, key=lambda entry: (-entry.gain, entry.video_id)
                )

        for creator_id, periods in creator_partials.items():
            for period, agg in periods.items():
                key = (creator_id, period)
                self._creator_view_sums[key] = self._creator_view_sums.get(key, 0) + agg.view_sum
                self._creator_catalog_counts[key] = self._creator_catalog_counts.get(key, 0) + agg.catalog_video_count
                self._creator_eligible_counts[key] = (
                    self._creator_eligible_counts.get(key, 0) + agg.eligible_video_count
                )
                combined = self._creator_candidates.get(key, []) + agg.top_candidates
                self._creator_candidates[key] = heapq.nsmallest(
                    self._creator_limit, combined, key=lambda entry: (-entry.gain, entry.video_id)
                )

    def scope_rankings(self) -> dict[ScopeKey, dict[str, list[RankedGrowth]]]:
        """Finalize the merged, ranked scope (video) Top-N — same shape/contract
        merge_partial_rankings' own output has."""
        merged: dict[ScopeKey, dict[str, list[RankedGrowth]]] = {}
        for (scope, period), entries in self._scope_candidates.items():
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
                for rank, entry in enumerate(entries, start=1)
            ]
        return merged

    def creator_partials(self) -> dict[str, dict[str, CreatorPeriodPartial]]:
        """Finalize the merged, exact per-creator/per-period aggregates — same
        shape/contract merge_creator_period_partials' own output has."""
        merged: dict[str, dict[str, CreatorPeriodPartial]] = {}
        for key, catalog_count in self._creator_catalog_counts.items():
            creator_id, period = key
            entries = self._creator_candidates.get(key, [])
            top_candidates = [
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
                for rank, entry in enumerate(entries, start=1)
            ]
            merged.setdefault(creator_id, {})[period] = CreatorPeriodPartial(
                creator_id=creator_id,
                period=period,
                view_sum=self._creator_view_sums.get(key, 0),
                catalog_video_count=catalog_count,
                eligible_video_count=self._creator_eligible_counts.get(key, 0),
                top_candidates=top_candidates,
            )
        return merged


@dataclass(frozen=True)
class CreatorLeaderboardEntry:
    """One creator's position in an organization's member leaderboard.

    Carries the same creator's own coverage fields (catalog/eligible/
    complete) alongside its rank, so a future API/UI can explain *why* a
    member's number looks the way it does (e.g. still bootstrapping,
    genuinely incomplete that day) without a second lookup.
    """

    rank: int
    creator_id: str
    value: int
    catalog_video_count: int
    eligible_video_count: int
    is_complete: bool
    video_id: str | None = None  # only set for the "top single video" leaderboard


@dataclass(frozen=True)
class OrganizationPeriodLeaderboard:
    """One organization's two member leaderboards for one period, plus the
    org-wide coverage summary a future API/UI needs to explain them.

    `is_complete` is only true when *every* member creator that
    participates in this organization/period is itself complete — a single
    incomplete member (a real per-video gap, not a legitimately new video)
    is enough to keep the whole organization/period marked incomplete, per
    Roadmap 5.x's bootstrap-availability rule (see organization_creator_
    leaderboards' own docstring for why an old video's missing anchor must
    never be silently treated as complete just because the pipeline is
    still young).
    """

    organization: str
    period: str
    member_count: int
    complete_member_count: int
    catalog_video_count: int
    eligible_video_count: int
    by_total_views: list[CreatorLeaderboardEntry]
    by_top_video: list[CreatorLeaderboardEntry]

    @property
    def is_complete(self) -> bool:
        return self.complete_member_count == self.member_count


def organization_creator_leaderboards(
    creator_partials: dict[str, dict[str, CreatorPeriodPartial]],
    *,
    dimensions_by_creator: Mapping[str, CreatorDimensions],
) -> dict[str, dict[str, OrganizationPeriodLeaderboard]]:
    """Build each organization's two member leaderboards per period, from
    already-merged (final, exact) per-creator aggregates.

    Returns {organization: {period: OrganizationPeriodLeaderboard}}. Only
    ever reads creator-level totals (merge_creator_period_partials' own
    output) — never revisits per-video data, since a creator's total/
    top-video is already exact once every shard's partial has been merged.
    A creator absent from `dimensions_by_creator`, or with no organization,
    contributes to no organization's leaderboard (mirrors _scopes_for's own
    "no dimensions, no org/branch scope" rule). "byTopVideo" additionally
    skips a creator with no top_candidates for that period (nothing rankable
    that period), the same way a video with no gain is never ranked — such
    a creator still counts toward member_count/complete_member_count,
    just not toward that one ranked list.

    Bootstrap availability (Roadmap 5.x): a member creator's own
    CreatorPeriodPartial.is_complete already correctly distinguishes "this
    video is genuinely new, so a missing anchor is a defensible 0 baseline"
    from "this video already existed and a real anchor is missing" (see
    history_ranking._period_value) — the latter is what keeps a member,
    and therefore its whole organization/period, marked incomplete during
    this pipeline's own bootstrap window (no D-7 snapshot exists anywhere
    before Day 8, no D-30 before Day 31, regardless of how old any given
    video is). "all" needs no anchor at all, so it is always complete from
    Day 1. This function does not special-case any of that itself — it
    only aggregates whatever completeness each member's own partial
    already carries.
    """
    by_org: dict[str, dict[str, list[tuple[str, CreatorPeriodPartial]]]] = {}
    for creator_id, periods in creator_partials.items():
        dimensions = dimensions_by_creator.get(creator_id)
        if dimensions is None or not dimensions.organization:
            continue
        for period, agg in periods.items():
            by_org.setdefault(dimensions.organization, {}).setdefault(period, []).append((creator_id, agg))

    result: dict[str, dict[str, OrganizationPeriodLeaderboard]] = {}
    for organization, periods in by_org.items():
        for period, members in periods.items():
            by_total = sorted(members, key=lambda pair: (-pair[1].view_sum, pair[0]))
            by_top_video = sorted(
                (pair for pair in members if pair[1].top_candidates),
                key=lambda pair: (-pair[1].top_candidates[0].gain, pair[0]),
            )
            result.setdefault(organization, {})[period] = OrganizationPeriodLeaderboard(
                organization=organization,
                period=period,
                member_count=len(members),
                complete_member_count=sum(1 for _, agg in members if agg.is_complete),
                catalog_video_count=sum(agg.catalog_video_count for _, agg in members),
                eligible_video_count=sum(agg.eligible_video_count for _, agg in members),
                by_total_views=[
                    CreatorLeaderboardEntry(
                        rank=rank,
                        creator_id=creator_id,
                        value=agg.view_sum,
                        catalog_video_count=agg.catalog_video_count,
                        eligible_video_count=agg.eligible_video_count,
                        is_complete=agg.is_complete,
                    )
                    for rank, (creator_id, agg) in enumerate(by_total, start=1)
                ],
                by_top_video=[
                    CreatorLeaderboardEntry(
                        rank=rank,
                        creator_id=creator_id,
                        value=agg.top_candidates[0].gain,
                        catalog_video_count=agg.catalog_video_count,
                        eligible_video_count=agg.eligible_video_count,
                        is_complete=agg.is_complete,
                        video_id=agg.top_candidates[0].video_id,
                    )
                    for rank, (creator_id, agg) in enumerate(by_top_video, start=1)
                ],
            )
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
