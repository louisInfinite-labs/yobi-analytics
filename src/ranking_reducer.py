"""Merge shard-local Top-N results and persist small TrendingCache payloads."""

from __future__ import annotations

import json
import math
import os
import time
from datetime import date, datetime
from typing import Any, Callable
from zoneinfo import ZoneInfo

import execution_lock
from creator_master import load_creators
from history_ranking import (
    CreatorDimensions,
    CreatorLeaderboardEntry,
    CreatorPeriodPartial,
    IncrementalRankingMerger,
    RankedGrowth,
    organization_creator_leaderboards,
)
from history_store import HISTORY_SHARD_COUNT
from ranking_partial_store import S3PartialRankingStore
from trending_cache_keys import (
    creator_summary_cache_key,
    organization_leaderboard_cache_key,
    trending_cache_key,
)

_TIME_ZONE = "Asia/Tokyo"
_RANKING_TYPE = {"1d": "daily_trending", "7d": "7d_trending", "30d": "30d_trending"}

# YobiTrendingCache's own on_demand_throughput.max_write_request_units = 100
# (terraform/dynamodb.tf) is a cap on the *table*, not per caller. Pacing to
# a target below that real cap (not the cap itself) leaves headroom for the
# pacing estimate's own imprecision (actual network latency, GC pauses,
# etc.) and for any other concurrent writer to this table. This round does
# not change the Terraform-declared 100 -- only how this reducer's own
# writes are paced under it.
TARGET_WRU_PER_SECOND = 80


class WruBudget:
    """Paces a sequence of DynamoDB writes to a shared target WRU/second rate.

    One instance must be shared across *every* write a single reducer
    invocation makes — the existing scope-ranking cache (persist_rankings)
    and the new creator/organization cache (persist_creator_and_
    organization_rankings) both write the same YobiTrendingCache table, and
    its throughput cap applies to the table as a whole. Two independent
    budgets (one per cache "kind") could each individually stay under the
    target and still blow past the real per-table cap together — this is
    why lambda_handler constructs exactly one WruBudget and passes it into
    both persist_* calls, rather than each call site making its own.

    charge() computes WRU the same way DynamoDB itself does for a standard
    write — ceil(item_bytes / 1024), a minimum of 1 KB-unit per item — and
    sleeps first if issuing that many more WRU right now would put the
    cumulative rate over `target_wru_per_second` since this budget was
    created. Batching writes into fewer HTTP calls (e.g. BatchWriteItem)
    would not change any of this: DynamoDB still bills the same total WRU
    for the same total bytes regardless of how many API calls carry them,
    so a caller batching writes must still call charge() once per logical
    item and keep obeying the same shared budget — batching only ever
    reduces call *count*, never the WRU this budget paces against.

    `clock`/`sleeper` are injectable so a test can pace against a fake
    clock and record (rather than actually perform) the sleep — real usage
    always defaults to wall-clock time.monotonic/time.sleep.

    KNOWN GAP, deliberately not addressed here: this budget only paces the
    writes made by *this one* reducer invocation's own process. It has no
    visibility into any other concurrent process writing to the same
    table — two ranking_reducer invocations somehow running at once (e.g.
    an operator-triggered manual rerun overlapping the scheduled one) would
    each independently pace themselves to 80 WRU/s and could together
    still issue up to ~160 WRU/s against a table capped at 100. Closing
    that requires an execution-level lock/mutual-exclusion mechanism
    across invocations (e.g. a DynamoDB conditional claim keyed by
    report_date, mirroring the same kind of gap already documented for
    concurrent history_worker executions in HistoryStore.shard_exists) —
    deliberately out of scope for this round; this budget only solves the
    single-invocation pacing problem.
    """

    def __init__(self, *, target_wru_per_second: float = TARGET_WRU_PER_SECOND, clock=time.monotonic, sleeper=time.sleep):
        if target_wru_per_second <= 0:
            raise ValueError(f"target_wru_per_second must be positive, got {target_wru_per_second!r}")
        self._target = target_wru_per_second
        self._clock = clock
        self._sleep = sleeper
        self._start = clock()
        self.total_wru = 0

    def charge(self, item_bytes: int) -> int:
        """Account for one write of `item_bytes` bytes, sleeping first if
        needed to keep the cumulative rate at or under the target. Returns
        the WRU charged for this write."""
        wru = math.ceil(item_bytes / 1024)
        projected_total = self.total_wru + wru
        ideal_elapsed = projected_total / self._target
        actual_elapsed = self._clock() - self._start
        if actual_elapsed < ideal_elapsed:
            self._sleep(ideal_elapsed - actual_elapsed)
        self.total_wru = projected_total
        return wru


def _dynamodb_item_bytes(*, cache_key: str, payload: dict, computed_at: str) -> int:
    """The real DynamoDB item size dynamodb_store.put_cached_trending will
    write — not just the payload's own JSON size.

    dynamodb_store.put_cached_trending's actual wire format is
    `Item={"cacheKey": cache_key, "payload": json.dumps(payload),
    "computedAt": computed_at}` — three String attributes. DynamoDB's own
    item-size rule (AWS docs) is the sum of every attribute *name's* bytes
    plus every attribute *value's* bytes, for every attribute in the item —
    so undercounting to just the "payload" attribute's value (as an
    earlier version of this function did) missed the "cacheKey"/
    "computedAt" attributes entirely (both their names and values) and the
    "payload" attribute's own name. All three attribute values are
    encoded UTF-8 before measuring, since that's the actual wire encoding
    DynamoDB bills against — a non-ASCII character (e.g. a Japanese
    channel name inside payload) can be 2-4 bytes in UTF-8 even though it
    is one Python character (one code point) in `len(payload_json)`.
    """
    payload_json = json.dumps(payload)
    attributes = {"cacheKey": cache_key, "payload": payload_json, "computedAt": computed_at}
    return sum(len(name.encode("utf-8")) + len(value.encode("utf-8")) for name, value in attributes.items())


def _paced_put(
    put_cached_trending: Callable[..., None], wru_budget: "WruBudget", key: str, payload: dict, *, computed_at: str
) -> None:
    """Charge wru_budget for this exact item's real DynamoDB size, then write it.

    See _dynamodb_item_bytes for why this measures the whole item (cacheKey
    + payload + computedAt attribute names and values), not just the
    payload's own JSON size, so the WRU charged here matches what DynamoDB
    will actually bill for this item.
    """
    item_bytes = _dynamodb_item_bytes(cache_key=key, payload=payload, computed_at=computed_at)
    wru_budget.charge(item_bytes)
    put_cached_trending(key, payload, computed_at=computed_at)


def persist_rankings(
    rankings,
    *,
    report_date: date,
    creators: dict[str, Any],
    get_video: Callable[[str], Any],
    put_cached_trending: Callable[..., None],
    computed_at: str,
    wru_budget: WruBudget,
) -> int:
    """Persist only bounded final results, enriched from master data.

    `creators` (creatorId -> Creator) is supplied by the caller rather than
    loaded here — lambda_handler loads Creator Master exactly once per
    invocation and reuses that same result for this enrichment and for
    building organization membership, rather than each call site loading
    it separately.

    `wru_budget` must be the *same* WruBudget instance passed to
    persist_creator_and_organization_rankings in the same invocation — see
    WruBudget's own docstring for why a second, independent budget here
    would defeat the whole point of pacing against one table-wide cap.
    """
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
            _paced_put(put_cached_trending, wru_budget, key, payload, computed_at=computed_at)
            writes += 1
    return writes


def persist_creator_and_organization_rankings(
    creator_partials: dict[str, dict[str, CreatorPeriodPartial]],
    *,
    report_date: date,
    dimensions_by_creator: dict[str, CreatorDimensions],
    put_cached_trending: Callable[..., None],
    computed_at: str,
    wru_budget: WruBudget,
) -> int:
    """Persist one summary item per (creatorId, period) and one leaderboard
    item per (organization, period) into the same YobiTrendingCache table,
    under a namespace (_CREATOR_SUMMARY_PREFIX/_ORG_LEADERBOARD_PREFIX)
    distinct from persist_rankings' own scope-ranking keys.

    Deliberately reads no storage at all beyond what the caller already
    computed: `creator_partials` is already the fully-merged, exact result
    of IncrementalRankingMerger.creator_partials() (every shard folded in),
    and `dimensions_by_creator` is expected to come from one already-loaded
    creator_master.load_creators() batch (a bundled local JSON file, not a
    DynamoDB table — see lambda_handler's own call site). No per-video or
    per-creator Video Master/Creator Master read happens in this function,
    unlike persist_rankings' own get_video(video_id) enrichment — these
    items intentionally carry only videoId/creatorId (not title/
    channelName), since that enrichment would require exactly the kind of
    per-video read this round must not add.

    `wru_budget` must be the *same* WruBudget instance passed to
    persist_rankings in the same invocation.
    """
    writes = 0
    for creator_id, periods in creator_partials.items():
        for period, agg in periods.items():
            payload = {
                "creatorId": creator_id,
                "period": period,
                "reportDate": report_date.isoformat(),
                "viewSum": agg.view_sum,
                "catalogVideoCount": agg.catalog_video_count,
                "eligibleVideoCount": agg.eligible_video_count,
                "isComplete": agg.is_complete,
                "topVideo": _ranked_growth_cache_row(agg.top_candidates[0]) if agg.top_candidates else None,
                "top10": [_ranked_growth_cache_row(entry) for entry in agg.top_candidates],
            }
            key = creator_summary_cache_key(creator_id=creator_id, period=period, report_date=report_date)
            _paced_put(put_cached_trending, wru_budget, key, payload, computed_at=computed_at)
            writes += 1

    leaderboards = organization_creator_leaderboards(creator_partials, dimensions_by_creator=dimensions_by_creator)
    for organization, periods in leaderboards.items():
        for period, board in periods.items():
            payload = {
                "organization": organization,
                "period": period,
                "reportDate": report_date.isoformat(),
                "memberCount": board.member_count,
                "completeMemberCount": board.complete_member_count,
                "catalogVideoCount": board.catalog_video_count,
                "eligibleVideoCount": board.eligible_video_count,
                "isComplete": board.is_complete,
                "byTotalViews": [_leaderboard_entry_cache_row(entry) for entry in board.by_total_views],
                "byTopVideo": [_leaderboard_entry_cache_row(entry) for entry in board.by_top_video],
            }
            key = organization_leaderboard_cache_key(organization=organization, period=period, report_date=report_date)
            _paced_put(put_cached_trending, wru_budget, key, payload, computed_at=computed_at)
            writes += 1
    return writes


def _ranked_growth_cache_row(entry: RankedGrowth) -> dict[str, Any]:
    """A minimal (no title/channelName enrichment — see
    persist_creator_and_organization_rankings' own docstring for why) cache
    row for one video inside a creator summary's topVideo/top10."""
    return {
        "rank": entry.rank,
        "videoId": entry.video_id,
        "value": entry.gain,
        "latestViewCount": entry.view_count,
        "lastUpdatedAt": entry.observed_at,
    }


def _leaderboard_entry_cache_row(entry: CreatorLeaderboardEntry) -> dict[str, Any]:
    return {
        "rank": entry.rank,
        "creatorId": entry.creator_id,
        "value": entry.value,
        "videoId": entry.video_id,
        "catalogVideoCount": entry.catalog_video_count,
        "eligibleVideoCount": entry.eligible_video_count,
        "isComplete": entry.is_complete,
    }


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Merge all successful shard partials after the Step Functions Map.

    Also doubles as terraform/history.tf's `MarkExecutionComplete`
    (`markCompleteForDate`) and `MarkExecutionFailed` (`markFailedForDate`)
    states — see `_mark_execution_complete`/`_mark_execution_failed` for why
    those are handled by this same Lambda rather than new ones.

    Reads each shard exactly once (one S3 GetObject via read_bundle, not a
    separate read()+read_creator_partials() pair) and folds it straight
    into IncrementalRankingMerger's bounded running accumulators, so this
    never holds all HISTORY_SHARD_COUNT shards' own (potentially several-MB
    each) payloads in memory simultaneously — only whichever one shard's
    bundle is currently being folded in, plus the bounded merge state.

    load_creators() is called exactly once here (a bundled local JSON file
    read, not a DynamoDB table — creator_master.py's own module docstring)
    and the same result is reused for both persist_rankings' scope-ranking
    cache row enrichment and this round's dimensions_by_creator — neither
    persist_rankings nor persist_creator_and_organization_rankings loads
    Creator Master itself. So this whole invocation costs zero additional
    DynamoDB reads for organization membership, and exactly one local-file
    Creator Master read total (not one per call site).

    Exactly one WruBudget is created and shared across both persist_*
    calls below — see WruBudget's own docstring for why two independent
    budgets (one per cache "kind") would defeat the point of pacing
    against YobiTrendingCache's one table-wide throughput cap.

    `reportDate`/`ownerToken` arrive explicitly in the event (forwarded from
    AcquireExecutionLock's own output via ReduceRankings' Parameters) —
    this function never derives its own "today", the same reasoning as
    history_worker_handler.lambda_handler's shard branch.
    """
    if "markCompleteForDate" in event:
        return _mark_execution_complete(event)
    if "markFailedForDate" in event:
        return _mark_execution_failed(event)

    from dynamodb_store import get_video, put_cached_trending

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
    store = S3PartialRankingStore(os.environ["YOBI_HISTORY_BUCKET"])
    merger = IncrementalRankingMerger()
    for shard in range(HISTORY_SHARD_COUNT):
        scope_rankings, creator_partials = store.read_bundle(report_date, shard)
        merger.add_shard(scope_rankings, creator_partials)
    rankings = merger.scope_rankings()

    all_creators = load_creators()
    creators_by_id = {creator.creator_id: creator for creator in all_creators}
    dimensions_by_creator = {
        creator.creator_id: CreatorDimensions(organization=creator.organization, branch=creator.branch)
        for creator in all_creators
    }

    wru_budget = WruBudget(target_wru_per_second=TARGET_WRU_PER_SECOND)
    writes = persist_rankings(
        rankings,
        report_date=report_date,
        creators=creators_by_id,
        get_video=get_video,
        put_cached_trending=put_cached_trending,
        computed_at=now.isoformat(),
        wru_budget=wru_budget,
    )
    writes += persist_creator_and_organization_rankings(
        merger.creator_partials(),
        report_date=report_date,
        dimensions_by_creator=dimensions_by_creator,
        put_cached_trending=put_cached_trending,
        wru_budget=wru_budget,
        computed_at=now.isoformat(),
    )
    return {"date": report_date.isoformat(), "reportDate": report_date.isoformat(), "ownerToken": owner_token, "cacheWrites": writes}


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
