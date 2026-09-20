"""Read-only compatibility check: uploaded S3 history vs. the real production
ranking/reducer code (Task T2.9).

For each candidate reportDate, this calls the UNMODIFIED production
functions -- history_ranking.top_n_by_scope, history_ranking.
creator_period_partials, history_ranking.IncrementalRankingMerger, and
ranking_reducer.persist_rankings / persist_creator_and_organization_rankings
-- against rows read from the real S3HistoryStore over the newly uploaded
s3://yobi-analytics-history/history/daily/ objects. The only substitution is
`put_cached_trending`: a local stub that records the payload each call would
have written instead of calling dynamodb_store.put_cached_trending, so the
full reducer payload-construction path is exercised without ever writing
YobiTrendingCache.

Deliberately bypasses history_worker.collect_history_shard (the Lambda-level
orchestration function): that function also depends on the live tracking
manifest (S3TrackingManifestStore) for discovered_date_by_video, which is
mutable *current* production state unrelated to whether the *uploaded
historical Parquet* is reducer-compatible. Calling top_n_by_scope/
creator_period_partials directly with discovered_date_by_video=None exercises
a real, unmodified code path (the same default those functions use when a
caller has no manifest data) and keeps this test scoped to exactly what T2.9
asks about: the S3 history data itself.

Never writes anywhere: no S3 PutObject, no DynamoDB, no Lambda, no Step
Functions. Every AWS call here is GetObject against yobi-analytics-history.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from creator_master import load_creators
from history_ranking import (
    CreatorDimensions,
    IncrementalRankingMerger,
    creator_period_partials,
    load_exact_anchor_rows,
    top_n_by_scope,
)
from history_store import EXACT_ANCHOR_DAYS, HISTORY_SHARD_COUNT, S3HistoryStore
from ranking_reducer import WruBudget, persist_creator_and_organization_rankings, persist_rankings

HISTORY_BUCKET = "yobi-analytics-history"

# Uploaded range (T2.7E/T2.8): 2026-08-30..2026-09-13 inclusive.
UPLOADED_START = date(2026, 8, 30)
UPLOADED_END = date(2026, 9, 13)
MEASURE_ONLY_DATE = date(2026, 9, 14)  # confirmed partial, never uploaded

# Two deliberately different candidates:
#  - 2026-09-13 (latest uploaded date): D-1=09-12 and D-7=09-06 both exist
#    within the uploaded range -- the richest single-date anchor coverage.
#  - 2026-09-01: D-1=08-31 exists, but D-7=08-25 does NOT (collection itself
#    only starts 08-30) -- exercises the "real gap, not zero" branch for D-7
#    using genuine data, not a contrived date.
# D-30 is absent for both: with only 15 uploaded days, no reportDate in the
# uploaded range can ever have a D-30 anchor inside it.
CANDIDATE_REPORT_DATES = [date(2026, 9, 13), date(2026, 9, 1)]


class _RecordingCachePut:
    """Stand-in for dynamodb_store.put_cached_trending: records exactly what
    the real reducer would have written, writes nothing anywhere."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def __call__(self, key: str, payload: dict, *, computed_at: str) -> None:
        self.calls.append({"key": key, "payload": payload, "computedAt": computed_at})


def _get_video_stub(_video_id: str) -> Any:
    """persist_rankings enriches each ranked video with title via get_video();
    that's Video Master enrichment, unrelated to history/reducer compatibility
    -- stubbed to None (persist_rankings' _cache_row already handles a None
    video gracefully, see ranking_reducer._cache_row)."""
    return None


@dataclass
class AnchorAvailability:
    report_date: str
    anchor_dates: dict[int, str]
    anchor_rows_present: dict[int, bool]  # any shard had >=1 row for that anchor date


@dataclass
class ReportDateResult:
    report_date: str
    anchor_dates: dict[int, str]
    s3_get_object_calls: int
    today_row_count: int
    anchor_row_counts: dict[int, int]
    gain_stats: dict[str, dict[str, int]]  # period -> {present, missing_gap, missing_new_baseline}
    sample_gains: list[dict[str, Any]]
    reducer_cache_writes_simulated: int
    errors: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


class _CountingS3HistoryStore(S3HistoryStore):
    """Same real S3HistoryStore, with a call counter -- so this script can
    report exactly how many S3 GetObject calls each reportDate cost, without
    touching S3HistoryStore's own production code."""

    def __init__(self, bucket_name: str) -> None:
        super().__init__(bucket_name)
        self.get_object_calls = 0

    def read_daily_shard(self, collection_date, shard):  # type: ignore[override]
        self.get_object_calls += 1
        return super().read_daily_shard(collection_date, shard)


def validate_report_date(store: _CountingS3HistoryStore, report_date: date, dimensions_by_creator) -> ReportDateResult:
    anchor_dates = {days: (report_date - timedelta(days=days)).isoformat() for days in EXACT_ANCHOR_DAYS}
    errors: list[str] = []
    merger = IncrementalRankingMerger()
    total_today_rows = 0
    anchor_row_counts = {days: 0 for days in EXACT_ANCHOR_DAYS}
    gain_stats = {
        f"{days}d": {"present": 0, "missing_gap": 0, "missing_new_baseline": 0} for days in EXACT_ANCHOR_DAYS
    }
    sample_gains: list[dict[str, Any]] = []

    calls_before = store.get_object_calls
    for shard in range(HISTORY_SHARD_COUNT):
        today_rows = store.read_daily_shard(report_date, shard)
        anchors = load_exact_anchor_rows(store, report_date=report_date, shard=shard)
        total_today_rows += len(today_rows)
        for days, rows in anchors.items():
            anchor_row_counts[days] += len(rows)

        try:
            rankings = top_n_by_scope(
                today_rows, anchors, report_date=report_date, dimensions_by_creator=dimensions_by_creator
            )
            partials = creator_period_partials(today_rows, anchors, report_date=report_date)
        except Exception as exc:  # noqa: BLE001 -- any incompatibility IS the thing being tested for
            errors.append(f"shard {shard:02d}: reducer computation raised {type(exc).__name__}: {exc}")
            continue
        merger.add_shard(rankings, partials)

        anchor_counts_by_video = {
            days: {row.video_id: row.view_count for row in anchors.get(days, [])} for days in EXACT_ANCHOR_DAYS
        }
        for row in today_rows:
            for days in EXACT_ANCHOR_DAYS:
                period = f"{days}d"
                if row.video_id in anchor_counts_by_video[days]:
                    gain_stats[period]["present"] += 1
                    if len(sample_gains) < 20 and shard == 0:
                        sample_gains.append(
                            {
                                "shard": shard,
                                "videoId": row.video_id,
                                "period": period,
                                "latest": row.view_count,
                                "anchor": anchor_counts_by_video[days][row.video_id],
                                "gain": row.view_count - anchor_counts_by_video[days][row.video_id],
                            }
                        )
                else:
                    # No manifest/discovered_date supplied (see module docstring) ->
                    # UNKNOWN_DISCOVERED_DATE=date.min -> always the conservative
                    # "real gap" branch, never the "new video" 0-baseline branch.
                    gain_stats[period]["missing_gap"] += 1

    calls_after = store.get_object_calls

    scope_rankings = merger.scope_rankings()
    creator_partials_merged = merger.creator_partials()

    cache_sink = _RecordingCachePut()
    wru_budget = WruBudget()
    writes = 0
    try:
        writes += persist_rankings(
            scope_rankings,
            report_date=report_date,
            creators={c.creator_id: c for c in load_creators()},
            get_video=_get_video_stub,
            put_cached_trending=cache_sink,
            computed_at="1970-01-01T00:00:00+00:00",
            wru_budget=wru_budget,
        )
        writes += persist_creator_and_organization_rankings(
            creator_partials_merged,
            report_date=report_date,
            dimensions_by_creator=dimensions_by_creator,
            put_cached_trending=cache_sink,
            computed_at="1970-01-01T00:00:00+00:00",
            wru_budget=wru_budget,
        )
    except Exception as exc:  # noqa: BLE001
        errors.append(f"reducer persist-path raised {type(exc).__name__}: {exc}")

    return ReportDateResult(
        report_date=report_date.isoformat(),
        anchor_dates=anchor_dates,
        s3_get_object_calls=calls_after - calls_before,
        today_row_count=total_today_rows,
        anchor_row_counts=anchor_row_counts,
        gain_stats=gain_stats,
        sample_gains=sample_gains,
        reducer_cache_writes_simulated=len(cache_sink.calls),
        errors=errors,
    )


def main() -> int:
    store = _CountingS3HistoryStore(HISTORY_BUCKET)
    dimensions_by_creator = {
        c.creator_id: CreatorDimensions(organization=c.organization, branch=c.branch) for c in load_creators()
    }

    print("=== T2.9: history/reducer compatibility validation (read-only) ===")
    print(f"Uploaded S3 range: {UPLOADED_START.isoformat()} .. {UPLOADED_END.isoformat()}")
    print(f"Measure-only date (confirmed absent from S3): {MEASURE_ONLY_DATE.isoformat()}\n")

    results: list[ReportDateResult] = []
    for report_date in CANDIDATE_REPORT_DATES:
        print(f"--- reportDate={report_date.isoformat()} ---")
        result = validate_report_date(store, report_date, dimensions_by_creator)
        results.append(result)
        print(f"  anchor dates: {result.anchor_dates}")
        print(f"  S3 GetObject calls: {result.s3_get_object_calls}")
        print(f"  today row count (all 16 shards): {result.today_row_count}")
        for days in EXACT_ANCHOR_DAYS:
            print(f"  D-{days} anchor row count (all 16 shards): {result.anchor_row_counts[days]}")
        for period, stats in result.gain_stats.items():
            print(f"  {period} gain coverage: present={stats['present']} missing(real gap)={stats['missing_gap']}")
        print(f"  simulated reducer cache writes (not persisted): {result.reducer_cache_writes_simulated}")
        if result.errors:
            print("  ERRORS:")
            for e in result.errors:
                print(f"    - {e}")
        print()

    out_path = Path("history_reducer_compat_report.json")
    out_path.write_text(
        json.dumps(
            [
                {
                    "reportDate": r.report_date,
                    "anchorDates": r.anchor_dates,
                    "s3GetObjectCalls": r.s3_get_object_calls,
                    "todayRowCount": r.today_row_count,
                    "anchorRowCounts": r.anchor_row_counts,
                    "gainStats": r.gain_stats,
                    "sampleGains": r.sample_gains,
                    "reducerCacheWritesSimulated": r.reducer_cache_writes_simulated,
                    "errors": r.errors,
                }
                for r in results
            ],
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"Local report written: {out_path.resolve()}")

    overall_ok = all(r.ok for r in results)
    print(f"\nOVERALL: {'PASS' if overall_ok else 'FAIL'}")
    return 0 if overall_ok else 1


if __name__ == "__main__":
    sys.exit(main())
