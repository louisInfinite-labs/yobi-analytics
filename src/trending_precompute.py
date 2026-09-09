"""Legacy DynamoDB trending precompute.

Kept as an explicit/manual compatibility path while the S3 architecture is
introduced. Its EventBridge schedules are retired: the daily Step Functions
workflow now computes exact shard-local rankings and a reducer writes the
normal TrendingCache entries.

Reuses read_api.py's existing (already Roadmap-5-hardened) video-loading and
growth-computation helpers rather than duplicating that logic — this
module's only new responsibility is looping over every creator/organization
x period x ranking-type combination once and writing each result to
YobiTrendingCache via dynamodb_store.put_cached_trending, keyed by
read_api.trending_cache_key so a read-path cache lookup always agrees with
what was written here.

Local/JSON development never calls this module.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
from typing import Any

from creator_master import load_creators
from dynamodb_store import get_videos_by_creator, put_cached_trending
from read_api import (
    _CANONICAL_CACHE_TIME_ZONE,
    MAX_LIMIT,
    _compute_growth_results,
    _trending_response,
    trending_cache_key,
)
from trending import RANKING_TYPES, rank_videos

# Deliberately loads through the DynamoDB binding here rather than calling
# read_api._load_videos_for_creators: that function calls whichever
# get_videos_by_creator read_api.py bound at *its own* module-import time
# (JSON-backed in local dev, DynamoDB-backed once YOBI_STORAGE_BACKEND=
# dynamodb is set before read_api is first imported) — this module always
# wants the real DynamoDB-backed get_videos_by_creator imported above,
# unconditionally, since trending_precompute only ever runs in that backend
# (main.py's own guard). Going through read_api's binding would silently
# do the wrong thing if some earlier import in the same process had already
# resolved read_api against the other backend.


def _load_videos_for_organization(creator_ids: set[str]) -> list[Any]:
    """Every tracked video for the organization's creators."""
    videos = []
    for creator_id in creator_ids:
        videos.extend(get_videos_by_creator(creator_id))
    return videos

# trending.py's own period->ranking-type map is private; rebuilt here so
# this module can decide, for each period, every ranking type valid for it
# — a period-trending type only ranks results computed for its own matching
# period (read_api.parse_ranking_type enforces the same rule on requests).
_PERIOD_TRENDING_TYPE_BY_PERIOD = {"1d": "daily_trending", "7d": "7d_trending", "30d": "30d_trending"}
_PERIODS = tuple(_PERIOD_TRENDING_TYPE_BY_PERIOD)

# Deliberately its own, much smaller constant instead of reusing
# read_api._SNAPSHOT_FETCH_WORKERS (100) — that value was tuned for a single
# live request racing a 60-second Lambda timeout. 2026-09-06: confirmed via a
# [mem-debug] instrumented invocation that this run's shared
# ThreadPoolExecutor alone (lazily creating a lock-per-thread boto3
# DynamoDB resource, dynamodb_store._resource, each with its own
# max_pool_connections=110) drove memory to ~934MB out of 1024MB after
# processing just the *first*, smallest creator's ≤100 candidates -- the
# executor's own thread/connection standup cost, not accumulation across
# many creators, is what was driving the repeated OOM. Precompute never
# needs 100-way concurrency; a much smaller pool still avoids paying for 100
# standing threads/connections for the whole run.
_PRECOMPUTE_EXECUTOR_WORKERS = 20


def _ranking_types_for_period(period: str) -> list[str]:
    """Every ranking type valid for this period: its own period-trending type plus the period-agnostic ones."""
    period_trending_type = _PERIOD_TRENDING_TYPE_BY_PERIOD[period]
    other_types = sorted(set(RANKING_TYPES) - set(_PERIOD_TRENDING_TYPE_BY_PERIOD.values()))
    return [period_trending_type, *other_types]


def _creators_for_batch(creators: list[Any], *, batch_index: int, batch_count: int) -> list[Any]:
    """Deterministically partition creators across `batch_count` invocations.

    Sorted by creator_id first so the assignment is stable across runs
    (creators.json's own ordering isn't a stable partition key — an
    unrelated reordering there must not reshuffle which batch a creator
    falls into and cause a period to skip/duplicate one). Slicing by
    `i % batch_count` rather than contiguous chunks spreads creators with
    similar catalog sizes evenly across batches instead of one batch
    accidentally getting all the largest back-catalogs.

    Validates its own bounds rather than trusting the caller — an
    EventBridge schedule's `input` is just a JSON literal in Terraform, so a
    typo'd `batchIndex`/`batchCount` reaching here would otherwise either
    silently select zero creators (batch_index out of range, still returns
    HTTP 200 with org-scope caches written and nothing to show for it) or
    raise an opaque ZeroDivisionError (batch_count=0) instead of a clear
    error naming what's actually wrong.
    """
    if batch_count < 1:
        raise ValueError(f"batch_count must be at least 1, got {batch_count}")
    if not 0 <= batch_index < batch_count:
        raise ValueError(f"batch_index must be within [0, {batch_count}), got {batch_index}")
    ordered = sorted(creators, key=lambda c: c.creator_id)
    return [creator for i, creator in enumerate(ordered) if i % batch_count == batch_index]


def run(
    report_date: date,
    periods: tuple[str, ...] = _PERIODS,
    *,
    batch_index: int = 0,
    batch_count: int = 1,
    include_org_scope: bool = True,
) -> dict[str, int]:
    """Compute and cache trending for a slice of creators, every organization, for each period in `periods`.

    `periods` defaults to all three (1d/7d/30d) but a caller may pass just
    one — 2026-09-05: running all three in a single invocation (342
    scope/ranking-type combinations) exceeded this Lambda's own 900-second
    timeout even after the executor fix below, so lambda_handler.py's
    precompute-mode dispatch now takes an event-level `period` and three
    separate EventBridge schedules each cover one period, spreading the
    same total work across three smaller windows instead of one long one.

    2026-09-06: period-splitting alone started failing again once the
    roster reached 112 creators — repeated Runtime.OutOfMemory/900s-timeout
    even for a single period. Initially suspected (and partly true, just
    not the actual cause): unbounded per-creator fetch size, and creator
    count itself accumulating memory across one invocation. Neither
    explained the evidence once instrumented — a [mem-debug] per-creator
    memory log showed usage already at ~934MB (of 1024MB) after processing
    just the *first*, smallest creator, and flat thereafter regardless of
    how many more creators followed. The real cause: this run's shared
    ThreadPoolExecutor was using read_api._SNAPSHOT_FETCH_WORKERS (100)
    workers — each lazily creating its own thread-local boto3 DynamoDB
    resource (dynamodb_store._resource, max_pool_connections=110 each) on
    first use, all ~100 of them standing up at once as soon as the first
    _compute_growth_results call dispatched work across the pool. That
    fixed startup cost, not accumulation across creators, was the actual
    failure — confirmed by dropping to _PRECOMPUTE_EXECUTOR_WORKERS (20)
    alone: memory stayed flat around 350-400MB for all 112 creators in one
    unbatched, unsplit run (240s, well under the 900s budget).

    `batch_index`/`batch_count` (splitting the creator-scope loop itself,
    see `_creators_for_batch`) and `include_org_scope` (org-scope reads a
    pool bounded independently of creator count, so was never part of the
    failure) are kept as real, tested capability for further headroom as
    the roster keeps growing, but the worker-count fix alone was enough to
    resolve the actual incident — as of this writing nothing schedules a
    batch_count > 1 run.

    Best-effort per scope: one creator/organization's failure (a transient
    DynamoDB error, say) is logged and skipped rather than aborting the
    whole run — most scopes still getting a fresh cache entry is strictly
    better than none of them getting one because of a single bad one.

    Shares one ThreadPoolExecutor (_PRECOMPUTE_EXECUTOR_WORKERS workers, see
    that constant's own comment for why it's much smaller than
    read_api._SNAPSHOT_FETCH_WORKERS) across every _compute_growth_results
    call this run makes, rather than letting each call open and tear down
    its own — each worker lazily creates its own thread-local boto3
    DynamoDB resource and connection pool (dynamodb_store._resource), so a
    fresh pool per call would keep recreating that state instead of reusing
    it for the whole run.
    """
    computed_at = datetime.now().isoformat()
    all_creators = load_creators()
    batch_creators = _creators_for_batch(all_creators, batch_index=batch_index, batch_count=batch_count)
    organizations = sorted({creator.organization for creator in all_creators})
    scopes_written = 0
    scopes_failed = 0

    with ThreadPoolExecutor(max_workers=_PRECOMPUTE_EXECUTOR_WORKERS) as executor:
        for period in periods:
            ranking_types = _ranking_types_for_period(period)

            for creator in batch_creators:
                try:
                    # Compatibility path only: every tracked video remains
                    # eligible; rank_videos bounds the final cache payload.
                    videos = get_videos_by_creator(creator.creator_id)
                    growth_results = _compute_growth_results(
                        videos, report_date=report_date, period=period, executor=executor
                    )
                    for ranking_type in ranking_types:
                        _cache_one(
                            scope_type="creator",
                            scope_value=creator.creator_id,
                            scope_field={"creatorId": creator.creator_id},
                            growth_results=growth_results,
                            report_date=report_date,
                            period=period,
                            ranking_type=ranking_type,
                            computed_at=computed_at,
                        )
                    scopes_written += 1
                except Exception as exc:  # noqa: BLE001 — one creator must never abort the whole precompute run
                    print(f"Warning: trending precompute failed for creator {creator.creator_id!r}: {exc}")
                    scopes_failed += 1

            if not include_org_scope:
                continue

            for organization in organizations:
                try:
                    creator_ids = {creator.creator_id for creator in all_creators if creator.organization == organization}
                    videos = _load_videos_for_organization(creator_ids)
                    growth_results = _compute_growth_results(
                        videos, report_date=report_date, period=period, executor=executor
                    )
                    for ranking_type in ranking_types:
                        _cache_one(
                            scope_type="org",
                            scope_value=organization,
                            scope_field={"organization": organization},
                            growth_results=growth_results,
                            report_date=report_date,
                            period=period,
                            ranking_type=ranking_type,
                            computed_at=computed_at,
                        )
                    scopes_written += 1
                except Exception as exc:  # noqa: BLE001
                    print(f"Warning: trending precompute failed for organization {organization!r}: {exc}")
                    scopes_failed += 1

    return {"scopes_written": scopes_written, "scopes_failed": scopes_failed}


def _cache_one(
    *,
    scope_type: str,
    scope_value: str,
    scope_field: dict[str, str],
    growth_results: list[Any],
    report_date: date,
    period: str,
    ranking_type: str,
    computed_at: str,
) -> None:
    """Rank one already-computed growth-result set by one ranking_type and cache it."""
    ranked = rank_videos(growth_results, ranking_type, limit=MAX_LIMIT)
    payload = _trending_response(
        ranked,
        scope=scope_field,
        report_date=report_date,
        period=period,
        ranking_type=ranking_type,
        time_zone=_CANONICAL_CACHE_TIME_ZONE,
    )
    key = trending_cache_key(
        scope_type=scope_type, scope_value=scope_value, period=period, ranking_type=ranking_type, report_date=report_date
    )
    put_cached_trending(key, payload, computed_at=computed_at)
