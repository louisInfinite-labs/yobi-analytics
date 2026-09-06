"""Daily trending precompute (2026-09-05 perf fix): runs once per collection
cycle so live GET /trending requests almost always serve a cheap cache read
instead of read_api.py's own bounded-but-still-real-time computation.

Why this exists: read_api.py's get_organization_trending, even after adding
the creatorId-index GSI, Cold exclusion, and a per-creator/per-request
candidate cap (all 2026-09-05), still has to do real work — enumerate an
organization's creators, fetch each one's top candidates, fetch two
snapshots per candidate — inside one API request. That's a real, bounded
amount of work now, but it is still work a public read endpoint has to do
synchronously. Precomputing it once a day, offline, and having the read
path serve a plain GetItem on a cache hit removes that work from the
request path entirely for the common case.

Reuses read_api.py's existing (already Roadmap-5-hardened) video-loading and
growth-computation helpers rather than duplicating that logic — this
module's only new responsibility is looping over every creator/organization
x period x ranking-type combination once and writing each result to
YobiTrendingCache via dynamodb_store.put_cached_trending, keyed by
read_api.trending_cache_key so a read-path cache lookup always agrees with
what was written here.

Runs inside the same collector Lambda invocation as main.py's own daily
collection (main.py calls run() at the end, best-effort — a precompute
failure never fails the collection run itself), so it needs no separate
schedule or deployment target. Local/JSON development never calls this: no
cache table exists there, and read_api.py's own get_cached_trending is None
in that backend, so a live request always computes directly regardless.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
from typing import Any

from creator_master import load_creators
from dynamodb_store import get_videos_by_creator, put_cached_trending
from read_api import (
    _CANONICAL_CACHE_TIME_ZONE,
    _PER_CREATOR_CANDIDATE_CAP,
    _SNAPSHOT_FETCH_WORKERS,
    MAX_LIMIT,
    _compute_growth_results,
    _rank_and_cap_candidates,
    _trending_response,
    trending_cache_key,
)
from trending import RANKING_TYPES, rank_videos

# Deliberately reimplements read_api._load_videos_for_creators's per-creator
# capping here (via _rank_and_cap_candidates directly) rather than calling
# that function itself: read_api._load_videos_for_creators calls whichever
# get_videos_by_creator read_api.py bound at *its own* module-import time
# (JSON-backed in local dev, DynamoDB-backed once YOBI_STORAGE_BACKEND=
# dynamodb is set before read_api is first imported) — this module always
# wants the real DynamoDB-backed get_videos_by_creator imported above,
# unconditionally, since trending_precompute only ever runs in that backend
# (main.py's own guard). Going through read_api's binding would silently
# do the wrong thing if some earlier import in the same process had already
# resolved read_api against the other backend.


def _load_videos_for_organization(creator_ids: set[str]) -> list[Any]:
    """Each creator's own top candidates (read_api._PER_CREATOR_CANDIDATE_CAP), combined for one organization."""
    videos = []
    for creator_id in creator_ids:
        creator_videos = [video for video in get_videos_by_creator(creator_id) if video.activity_state != "Cold"]
        videos.extend(_rank_and_cap_candidates(creator_videos, cap=_PER_CREATOR_CANDIDATE_CAP))
    return videos

# trending.py's own period->ranking-type map is private; rebuilt here so
# this module can decide, for each period, every ranking type valid for it
# — a period-trending type only ranks results computed for its own matching
# period (read_api.parse_ranking_type enforces the same rule on requests).
_PERIOD_TRENDING_TYPE_BY_PERIOD = {"1d": "daily_trending", "7d": "7d_trending", "30d": "30d_trending"}
_PERIODS = tuple(_PERIOD_TRENDING_TYPE_BY_PERIOD)


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
    """
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

    2026-09-06: splitting by period alone stopped being enough once the
    roster reached 112 creators averaging ~1,131 videos each — every
    creator-scope iteration calls get_videos_by_creator, which fetches up
    to 500 full Video objects *before* this module's own candidate cap
    (above) ever applies, and holding that many for 112 creators processed
    sequentially in one invocation is what was driving repeated
    Runtime.OutOfMemory/900s-timeout failures even for a single period
    (confirmed via CloudWatch: DynamoDB RCU consumption on both
    YobiVideoMaster and YobiSnapshots was near-zero for most of a failed
    invocation's wall-clock time, pointing at Python-side memory pressure,
    not a DynamoDB-side bottleneck). `batch_index`/`batch_count` split the
    creator-scope loop itself (see `_creators_for_batch`) across that many
    separate invocations/schedules, each holding only its own slice's
    Video objects at a time. Org-scope reads a bounded pool regardless of
    creator count (each creator's contribution is already capped at
    _PER_CREATOR_CANDIDATE_CAP before the org-wide _MAX_TRENDING_CANDIDATES
    ceiling), so it was never the source of the failures above and is
    deliberately NOT split — `include_org_scope` just lets the schedules
    for batch_index != 0 skip redoing it.

    Best-effort per scope: one creator/organization's failure (a transient
    DynamoDB error, say) is logged and skipped rather than aborting the
    whole run — most scopes still getting a fresh cache entry is strictly
    better than none of them getting one because of a single bad one.

    Shares one ThreadPoolExecutor across every _compute_growth_results call
    this run makes, rather than letting each call open and tear down its
    own: a fresh 100-worker pool per call — each worker lazily creating its
    own thread-local boto3 DynamoDB resource and connection pool
    (dynamodb_store._resource) — accumulated enough abandoned thread/
    connection state across ~342 calls to exhaust this Lambda's 1024MB on
    its own, independently of the timeout above. One shared pool bounds
    that resource creation by worker count for the whole run, not by call
    count.
    """
    computed_at = datetime.now().isoformat()
    all_creators = load_creators()
    batch_creators = _creators_for_batch(all_creators, batch_index=batch_index, batch_count=batch_count)
    organizations = sorted({creator.organization for creator in all_creators})
    scopes_written = 0
    scopes_failed = 0

    with ThreadPoolExecutor(max_workers=_SNAPSHOT_FETCH_WORKERS) as executor:
        for period in periods:
            ranking_types = _ranking_types_for_period(period)

            for creator in batch_creators:
                try:
                    # Capped the same way _load_videos_for_organization caps
                    # each creator's contribution below (MAX_LIMIT, not the
                    # full _MAX_TRENDING_CANDIDATES=500 _compute_growth_results
                    # would otherwise use by default) — a creator's own
                    # trending page never returns more than MAX_LIMIT results
                    # anyway (_cache_one ranks with limit=MAX_LIMIT), so
                    # fetching 5x that many snapshot pairs per creator was
                    # pure wasted DynamoDB I/O. With ~100 creators run
                    # sequentially in one precompute invocation, that was the
                    # dominant cost behind this job's repeated OOM/timeout
                    # failures (see run()'s own docstring).
                    creator_videos = [v for v in get_videos_by_creator(creator.creator_id) if v.activity_state != "Cold"]
                    videos = _rank_and_cap_candidates(creator_videos, cap=MAX_LIMIT)
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
