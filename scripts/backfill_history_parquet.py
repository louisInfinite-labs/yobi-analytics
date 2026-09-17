"""One-time local staging backfill: production YobiSnapshots -> Parquet daily history.

Transforms the 15 confirmed-complete YobiSnapshots dates (2026-08-30 through
2026-09-13 -- see Roadmap Task T2.7) into the exact same HistoryRow / shard /
Parquet format the new S3 history pipeline (history_store.py, history_worker.py)
produces going forward, and writes the result to a LOCAL staging directory
only. Nothing here ever calls S3HistoryStore or touches S3, and nothing here
writes to DynamoDB -- this script is read-only against production.

Reuses the production implementation directly rather than re-deriving it:
HistoryRow, shard_for_video, serialize_history_rows, and daily_history_key are
all imported from history_store.py unchanged, so staged output is produced by
the identical code path real collection uses -- not a parallel format that
merely resembles it.

2026-09-14 is a confirmed PARTIAL snapshot date (T2.7A): the daily_collection
Lambda timed out at 900s while writing YobiSnapshots, so YobiRunSummaries'
collectedCount=127,212 for that date is the *intended* count, not the
authoritative number of rows actually persisted. This script measures 09-14's
actual stored row count from the same single scan but deliberately never
stages it and never synthesizes the missing rows.

Collection continues daily in production, so YobiSnapshots and YobiRunSummaries
both legitimately contain dates after 09-14 (e.g. 09-15 onward) at scan time.
Those are counted and reported separately -- never staged, and never allowed
to abort or contaminate the approved 08-30..09-13 staging baseline.

Safety guards, all required because this reads a live table others still
write to hourly:

- STAGE_DATES is the fixed, explicit set of dates this run stages to Parquet.
  Only YobiRunSummaries rows for STAGE_DATES + MEASURE_ONLY_DATE are required
  to exist before scanning starts; anything else present is tolerated.
- YobiRunSummaries' collectedCount is read once before the scan and once
  after, for every required date. If any of them changed in between -- a
  concurrent collection run committed mid-backfill -- the whole result is
  invalid: this script cannot tell which rows it saw belonged to the "before"
  state and which arrived during the scan. See SourceCountChangedError.
- Forensic per-date raw Scan-returned counts are persisted to disk
  (scan_forensics.json, under the staging root) immediately after the single
  scan finishes -- before any reconciliation check that could raise runs, and
  even if the scan itself raises partway through. This is a direct fix for a
  2026-09-14 incident: the previous version of this script spooled all dates
  including 09-14, then let SourceCountMismatchError's raise flow straight
  into `finally: spool.cleanup()`, which deleted the raw spool -- including
  the 15 good dates' worth of already-scanned data -- before anyone could see
  what the scan had actually found. Never silently discard the only evidence
  again.

Elizabeth Rose Bloodflame and Gigi Murin (see scripts/backfill_video_master.py
for the channel-ID correction this follows) have zero YobiSnapshots rows for
any date in STAGE_DATES; their corrected channel IDs only entered
YobiVideoMaster after this range ended. This script performs no per-creator
special-casing at all: a video with no snapshot rows simply produces no
HistoryRow in any shard, for any date, exactly like every other video that
happened not to be collected on a given day. There is deliberately no code
path here that could synthesize a placeholder or interpolated row.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterator

import boto3
from botocore.exceptions import ClientError

from history_store import (
    HISTORY_SHARD_COUNT,
    HistoryRow,
    daily_history_key,
    serialize_history_rows,
    shard_for_video,
)
from snapshot_store import coerce_view_count

SNAPSHOTS_TABLE = "YobiSnapshots"
RUN_SUMMARIES_TABLE = "YobiRunSummaries"

FORENSICS_LOG_FILENAME = "scan_forensics.json"

# Approved complete-date baseline (T2.7E), confirmed complete by T2.7A. Not
# enforced as a blocking precondition -- test fixtures use tiny synthetic
# counts -- but cross-checked against the live pre-scan YobiRunSummaries
# values and reported if they've drifted (see run_backfill's baseline_drift).
APPROVED_COMPLETE_ROW_COUNTS: dict[str, int] = {
    "2026-08-30": 5_659,
    "2026-08-31": 35_528,
    "2026-09-01": 64_325,
    "2026-09-02": 64_362,
    "2026-09-03": 64_378,
    "2026-09-04": 65_132,
    "2026-09-05": 64_440,
    "2026-09-06": 70_084,
    "2026-09-07": 8_764,
    "2026-09-08": 69_978,
    "2026-09-09": 12_795,
    "2026-09-10": 25_825,
    "2026-09-11": 12_983,
    "2026-09-12": 24_801,
    "2026-09-13": 13_771,
}

STAGE_DATES: frozenset[str] = frozenset(APPROVED_COMPLETE_ROW_COUNTS)

MEASURE_ONLY_DATE = "2026-09-14"
MEASURE_ONLY_DATE_KNOWN_INTENDED_COUNT = 127_212  # T2.7A finding; not authoritative for actual stored rows

REQUIRED_RUN_SUMMARY_DATES: frozenset[str] = STAGE_DATES | {MEASURE_ONLY_DATE}


def stage_dates() -> frozenset[str]:
    """The fixed, explicit set of dates this backfill stages to Parquet."""
    return STAGE_DATES


class BackfillError(RuntimeError):
    """Base for every backfill-staging failure. May carry a `.forensics`
    attribute (a ScanForensics) when raised after the scan phase completed,
    so callers can still report raw per-date counts even on abort."""


class UnexpectedDateError(BackfillError):
    """Raised when YobiRunSummaries is missing a row for one of the dates
    this backfill requires (STAGE_DATES + MEASURE_ONLY_DATE). The run aborts
    before scanning starts. Dates *beyond* the required set (e.g. later
    collection days already in YobiRunSummaries/YobiSnapshots) are expected
    and tolerated, not an error -- see ScanForensics.other_counts."""


class SourceCountChangedError(BackfillError):
    """Raised when a required date's YobiRunSummaries collectedCount differs
    between the pre-scan and post-scan reads: a concurrent collection or
    repair run committed while this script was scanning. The staged output
    cannot be trusted to reflect a single consistent snapshot of the source
    table, so it must be treated as invalid rather than silently accepted."""


class SourceCountMismatchError(BackfillError):
    """Raised when the number of rows this script actually scanned for a
    STAGE_DATES date does not match that date's approved YobiRunSummaries
    collectedCount, even though the count did not change between the pre-
    and post-scan reads. Indicates a scan or bucketing bug, not a race --
    must not be silently accepted. Deliberately never raised for
    MEASURE_ONLY_DATE, where a mismatch is the expected, already-diagnosed
    condition (T2.7A) this script measures rather than treats as failure."""


class DuplicateVideoError(BackfillError):
    """Raised when the same videoId appears twice within one date's shard.
    Structurally should be impossible (videoId+snapshotDate is YobiSnapshots'
    own primary key), so this is a last-line integrity check, not the
    primary guarantee."""


class ShardMismatchError(BackfillError):
    """Raised when a row staged under (date, shard) does not actually belong
    to that shard per shard_for_video -- a bucketing bug, never expected."""


def _history_row_from_snapshot_item(item: dict[str, Any]) -> tuple[str, HistoryRow]:
    """Convert one raw YobiSnapshots item (as returned by boto3's resource
    Table.scan(), Decimal-typed) into (snapshotDate, HistoryRow).

    availabilityStatus is always "available": a YobiSnapshots row only ever
    exists for a video that was actually observed that day (skipped videos
    never got a snapshot item -- see snapshot_store.SnapshotRunSummary), so
    its mere presence is the only fact this transform needs.
    """
    video_id = item["videoId"]
    snapshot_date = item["snapshotDate"]
    row = HistoryRow(
        video_id=video_id,
        creator_id=item["creatorId"],
        view_count=coerce_view_count(item["viewCount"], video_id=video_id),
        observed_at=item["observedAt"],
        availability_status="available",
    )
    return snapshot_date, row


def read_run_summary_collected_counts(table) -> dict[str, int]:
    """Scan YobiRunSummaries (tiny -- one row per collection date) and return
    {snapshotDate: collectedCount}. Cheap enough to call twice (once before,
    once after the real YobiSnapshots scan) to detect concurrent writes."""
    counts: dict[str, int] = {}
    scan_kwargs: dict[str, Any] = {}
    while True:
        response = table.scan(**scan_kwargs)
        for item in response.get("Items", []):
            counts[item["snapshotDate"]] = int(item["collectedCount"])
        if "LastEvaluatedKey" not in response:
            break
        scan_kwargs["ExclusiveStartKey"] = response["LastEvaluatedKey"]
    return counts


class RawSpool:
    """Bounded-memory intermediate storage: one newline-delimited-JSON file per
    (date, shard), written incrementally as the single YobiSnapshots scan
    progresses so the full production table is never held in memory at once.

    Deliberately pre-creates all shard files up front for every staged date --
    including ones that end up with zero rows -- so "16 shard files exist" per
    date holds even for a shard nobody happened to be collected into that day,
    matching production's own all-16-shards-written convention. Only ever
    created for STAGE_DATES: MEASURE_ONLY_DATE and any other observed date are
    counted in memory (ScanForensics) but never spooled or staged.
    """

    def __init__(self, root: Path, dates: frozenset[str]) -> None:
        self.root = root
        self._handles: dict[tuple[str, int], Any] = {}
        for collection_date in dates:
            date_dir = root / f"date={collection_date}"
            date_dir.mkdir(parents=True, exist_ok=True)
            for shard in range(HISTORY_SHARD_COUNT):
                path = date_dir / f"shard={shard:02d}.jsonl"
                self._handles[(collection_date, shard)] = open(path, "w", encoding="utf-8")

    def write(self, collection_date: str, shard: int, row: HistoryRow) -> None:
        handle = self._handles[(collection_date, shard)]
        handle.write(
            json.dumps(
                {
                    "videoId": row.video_id,
                    "creatorId": row.creator_id,
                    "viewCount": row.view_count,
                    "observedAt": row.observed_at,
                }
            )
        )
        handle.write("\n")

    def path_for(self, collection_date: str, shard: int) -> Path:
        return self.root / f"date={collection_date}" / f"shard={shard:02d}.jsonl"

    def close_all(self) -> None:
        for handle in self._handles.values():
            handle.close()

    def cleanup(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)


@dataclass
class ScanForensics:
    """Raw per-date Scan-returned counts from the single YobiSnapshots scan,
    bucketed by what this backfill does with each date. Built up in place by
    scan_snapshots_into_spool as items arrive, so a caller retains whatever
    was counted so far even if the scan itself raises partway through
    (network error, throttling) -- see run_backfill.
    """

    stage_counts: dict[str, int]
    measured_count: int = 0
    other_counts: dict[str, int] = field(default_factory=dict)

    @property
    def total_scanned(self) -> int:
        return sum(self.stage_counts.values()) + self.measured_count + sum(self.other_counts.values())


def scan_snapshots_into_spool(
    table, spool: RawSpool, dates: frozenset[str], forensics: ScanForensics
) -> None:
    """The single paginated Scan of YobiSnapshots. Every item is routed by its
    snapshotDate: STAGE_DATES rows are bucketed into their (date, shard) spool
    file and counted; MEASURE_ONLY_DATE rows are counted only (never staged);
    every other date's rows are counted separately (never staged, never
    raised on) so a later production date can never contaminate the approved
    staging baseline or abort this run. Mutates `forensics` in place.
    """
    scan_kwargs: dict[str, Any] = {}
    while True:
        response = table.scan(**scan_kwargs)
        for item in response.get("Items", []):
            snapshot_date, row = _history_row_from_snapshot_item(item)
            if snapshot_date in dates:
                shard = shard_for_video(row.video_id)
                spool.write(snapshot_date, shard, row)
                forensics.stage_counts[snapshot_date] += 1
            elif snapshot_date == MEASURE_ONLY_DATE:
                forensics.measured_count += 1
            else:
                forensics.other_counts[snapshot_date] = forensics.other_counts.get(snapshot_date, 0) + 1
        if "LastEvaluatedKey" not in response:
            break
        scan_kwargs["ExclusiveStartKey"] = response["LastEvaluatedKey"]


def _write_forensics_log(staging_root: Path, forensics: ScanForensics, pre_scan_counts: dict[str, int]) -> Path:
    """Persist the raw per-date Scan-returned counts to disk immediately after
    the single YobiSnapshots scan completes (or fails) -- before any
    reconciliation check that could raise runs. Written directly under
    staging_root, never under the `_raw_spool` subdirectory RawSpool.cleanup()
    removes, so it survives regardless of what happens next.
    """
    staging_root.mkdir(parents=True, exist_ok=True)
    log_path = staging_root / FORENSICS_LOG_FILENAME
    payload = {
        "loggedAtUtc": datetime.now(timezone.utc).isoformat(),
        "totalScannedRowsAllDates": forensics.total_scanned,
        "stageDateRawCounts": dict(sorted(forensics.stage_counts.items())),
        "measureOnlyDate": MEASURE_ONLY_DATE,
        "measureOnlyDateRawCount": forensics.measured_count,
        "otherDateRawCounts": dict(sorted(forensics.other_counts.items())),
        "preScanRunSummaryCollectedCounts": dict(sorted(pre_scan_counts.items())),
    }
    log_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    print(f"Forensic scan log written: {log_path}")
    print(f"Total raw Scan-returned rows (all dates, this single scan): {forensics.total_scanned}")
    for collection_date, count in sorted(forensics.stage_counts.items()):
        print(f"  raw[{collection_date}] = {count}")
    print(f"  raw[{MEASURE_ONLY_DATE}] (measure-only, not staged) = {forensics.measured_count}")
    for collection_date, count in sorted(forensics.other_counts.items()):
        print(f"  raw[{collection_date}] (OTHER date, not staged) = {count}")
    return log_path


def _read_spooled_rows(path: Path) -> Iterator[HistoryRow]:
    if not path.exists():
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            raw = json.loads(line)
            yield HistoryRow(
                video_id=raw["videoId"],
                creator_id=raw["creatorId"],
                view_count=raw["viewCount"],
                observed_at=raw["observedAt"],
                availability_status="available",
            )


def build_date_shard_parquet(spool: RawSpool, collection_date: str, shard: int, staging_root: Path) -> tuple[Path, int]:
    """Read one (date, shard)'s spooled rows, validate them, and write the
    final local Parquet file at the exact same relative path
    (history/daily/date=.../shard=NN.parquet) the S3 pipeline uses -- so the
    staged tree can later be uploaded key-for-key without any transformation.
    """
    spool_path = spool.path_for(collection_date, shard)
    rows: list[HistoryRow] = []
    seen_video_ids: set[str] = set()
    for row in _read_spooled_rows(spool_path):
        if shard_for_video(row.video_id) != shard:
            raise ShardMismatchError(
                f"videoId={row.video_id!r} staged under shard {shard:02d} for {collection_date} "
                f"but shard_for_video says {shard_for_video(row.video_id):02d}"
            )
        if row.video_id in seen_video_ids:
            raise DuplicateVideoError(
                f"Duplicate videoId={row.video_id!r} within {collection_date} shard {shard:02d}"
            )
        seen_video_ids.add(row.video_id)
        rows.append(row)

    parquet_bytes = serialize_history_rows(sorted(rows, key=lambda r: r.video_id))
    relative_key = daily_history_key(date.fromisoformat(collection_date), shard)
    output_path = staging_root / relative_key
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(parquet_bytes)
    return output_path, len(rows)


@dataclass
class DateReconciliation:
    collection_date: str
    pre_scan_collected_count: int
    scanned_count: int
    staged_row_count: int
    shard_file_count: int

    @property
    def ok(self) -> bool:
        return (
            self.pre_scan_collected_count == self.scanned_count == self.staged_row_count
            and self.shard_file_count == HISTORY_SHARD_COUNT
        )


@dataclass
class BackfillReport:
    staging_root: Path
    scanned_once: bool
    total_scanned_rows: int  # sum over the 15 staged dates only
    total_scanned_rows_all_dates: int  # grand total: staged + measure-only + other
    total_staged_rows: int
    date_count: int
    parquet_file_count: int
    total_bytes: int
    per_date: list[DateReconciliation]
    runtime_seconds: float
    measure_only_date: str
    measure_only_intended_count: int
    measure_only_actual_count: int
    measure_only_shortfall: int
    other_dates: dict[str, int]
    forensics_log_path: Path
    baseline_drift: dict[str, int] = field(default_factory=dict)
    anomalies: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.anomalies and all(d.ok for d in self.per_date)


def run_backfill(staging_root: Path, *, dynamodb_resource=None) -> BackfillReport:
    """Orchestrate the full read-only scan -> spool -> validate -> stage
    pipeline. Never calls S3 or writes to DynamoDB. Raises a BackfillError
    subclass on any guard failure; forensic per-date raw counts are written to
    disk (staging_root/scan_forensics.json) as soon as the scan phase ends,
    regardless of whether it succeeded, before any such error is raised."""
    start = time.monotonic()
    resource = dynamodb_resource or boto3.session.Session().resource("dynamodb")
    snapshots_table = resource.Table(SNAPSHOTS_TABLE)
    run_summaries_table = resource.Table(RUN_SUMMARIES_TABLE)

    pre_scan_counts = read_run_summary_collected_counts(run_summaries_table)
    missing = REQUIRED_RUN_SUMMARY_DATES - set(pre_scan_counts)
    if missing:
        raise UnexpectedDateError(
            f"YobiRunSummaries is missing required date(s) {sorted(missing)} -- refusing to scan"
        )

    staging_root.mkdir(parents=True, exist_ok=True)
    spool_root = staging_root / "_raw_spool"
    spool_root.mkdir(parents=True, exist_ok=True)
    spool = RawSpool(spool_root, STAGE_DATES)
    forensics = ScanForensics(stage_counts={collection_date: 0 for collection_date in STAGE_DATES})

    try:
        scan_error: Exception | None = None
        try:
            scan_snapshots_into_spool(snapshots_table, spool, STAGE_DATES, forensics)
        except Exception as exc:  # noqa: BLE001 -- deliberately broad: forensics must be flushed either way
            scan_error = exc
        finally:
            spool.close_all()
            forensics_log_path = _write_forensics_log(staging_root, forensics, pre_scan_counts)
        if scan_error is not None:
            if isinstance(scan_error, BackfillError):
                scan_error.forensics = forensics  # type: ignore[attr-defined]
            raise scan_error

        post_scan_counts = read_run_summary_collected_counts(run_summaries_table)
        changed = {
            collection_date: (pre_scan_counts[collection_date], post_scan_counts.get(collection_date))
            for collection_date in REQUIRED_RUN_SUMMARY_DATES
            if pre_scan_counts[collection_date] != post_scan_counts.get(collection_date)
        }
        if changed:
            exc = SourceCountChangedError(
                "YobiRunSummaries collectedCount changed during the scan for date(s): "
                + ", ".join(f"{d} (pre={pre} post={post})" for d, (pre, post) in sorted(changed.items()))
            )
            exc.forensics = forensics  # type: ignore[attr-defined]
            raise exc

        mismatched = {
            collection_date: (forensics.stage_counts[collection_date], pre_scan_counts[collection_date])
            for collection_date in STAGE_DATES
            if forensics.stage_counts[collection_date] != pre_scan_counts[collection_date]
        }
        if mismatched:
            exc = SourceCountMismatchError(
                "Scanned row count did not match approved collectedCount for date(s): "
                + ", ".join(
                    f"{d} (scanned={scanned} approved={approved} delta={scanned - approved:+d})"
                    for d, (scanned, approved) in sorted(mismatched.items())
                )
            )
            exc.forensics = forensics  # type: ignore[attr-defined]
            raise exc

        per_date: list[DateReconciliation] = []
        total_staged_rows = 0
        parquet_file_count = 0
        total_bytes = 0
        for collection_date in sorted(STAGE_DATES):
            staged_rows_for_date = 0
            shard_files_for_date = 0
            for shard in range(HISTORY_SHARD_COUNT):
                output_path, row_count = build_date_shard_parquet(spool, collection_date, shard, staging_root)
                staged_rows_for_date += row_count
                shard_files_for_date += 1
                parquet_file_count += 1
                total_bytes += output_path.stat().st_size
            total_staged_rows += staged_rows_for_date
            per_date.append(
                DateReconciliation(
                    collection_date=collection_date,
                    pre_scan_collected_count=pre_scan_counts[collection_date],
                    scanned_count=forensics.stage_counts[collection_date],
                    staged_row_count=staged_rows_for_date,
                    shard_file_count=shard_files_for_date,
                )
            )
    finally:
        spool.cleanup()

    total_scanned_rows = sum(forensics.stage_counts.values())
    anomalies: list[str] = []
    if parquet_file_count != len(STAGE_DATES) * HISTORY_SHARD_COUNT:
        anomalies.append(
            f"Expected {len(STAGE_DATES) * HISTORY_SHARD_COUNT} Parquet files, produced {parquet_file_count}"
        )

    baseline_drift = {
        collection_date: pre_scan_counts[collection_date] - expected
        for collection_date, expected in APPROVED_COMPLETE_ROW_COUNTS.items()
        if pre_scan_counts[collection_date] != expected
    }
    if pre_scan_counts[MEASURE_ONLY_DATE] != MEASURE_ONLY_DATE_KNOWN_INTENDED_COUNT:
        baseline_drift[MEASURE_ONLY_DATE] = (
            pre_scan_counts[MEASURE_ONLY_DATE] - MEASURE_ONLY_DATE_KNOWN_INTENDED_COUNT
        )

    measure_only_intended_count = pre_scan_counts[MEASURE_ONLY_DATE]
    measure_only_actual_count = forensics.measured_count
    measure_only_shortfall = measure_only_intended_count - measure_only_actual_count

    return BackfillReport(
        staging_root=staging_root,
        scanned_once=True,
        total_scanned_rows=total_scanned_rows,
        total_scanned_rows_all_dates=forensics.total_scanned,
        total_staged_rows=total_staged_rows,
        date_count=len(STAGE_DATES),
        parquet_file_count=parquet_file_count,
        total_bytes=total_bytes,
        per_date=per_date,
        runtime_seconds=time.monotonic() - start,
        measure_only_date=MEASURE_ONLY_DATE,
        measure_only_intended_count=measure_only_intended_count,
        measure_only_actual_count=measure_only_actual_count,
        measure_only_shortfall=measure_only_shortfall,
        other_dates=dict(sorted(forensics.other_counts.items())),
        forensics_log_path=forensics_log_path,
        baseline_drift=baseline_drift,
        anomalies=anomalies,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--staging-dir",
        default="history_backfill_staging",
        help="Local directory to write history/daily/date=.../shard=NN.parquet under (default: %(default)s).",
    )
    args = parser.parse_args(argv)
    staging_root = Path(args.staging_dir).resolve()

    print("=== History Parquet staging backfill (LOCAL ONLY, no S3/DynamoDB writes) ===")
    print(f"Staging root: {staging_root}")
    print(f"Stage dates (will be staged to Parquet): {sorted(STAGE_DATES)[0]} .. {sorted(STAGE_DATES)[-1]} "
          f"({len(STAGE_DATES)} dates)")
    print(f"Measure-only date (counted, never staged): {MEASURE_ONLY_DATE}")
    print("Scanning production YobiSnapshots (read-only, single pass)...\n")

    try:
        report = run_backfill(staging_root)
    except BackfillError as exc:
        print(f"\nABORTED -- staging result INVALID: {type(exc).__name__}: {exc}")
        forensics = getattr(exc, "forensics", None)
        if forensics is not None:
            print(
                f"(raw per-date scan counts were already persisted to "
                f"{staging_root / FORENSICS_LOG_FILENAME} before this failure -- not lost)"
            )
        return 1
    except ClientError as exc:
        print(f"\nABORTED -- AWS error: {exc}")
        return 1

    print(f"\nScanned exactly once:        {report.scanned_once}")
    print(f"Total scanned rows (staged 15 dates): {report.total_scanned_rows}")
    print(f"Total scanned rows (ALL dates, this scan): {report.total_scanned_rows_all_dates}")
    print(f"Total staged rows:           {report.total_staged_rows}")
    print(f"Dates staged:                {report.date_count}")
    print(f"Parquet files:               {report.parquet_file_count}")
    print(f"Total size (bytes):          {report.total_bytes}")
    print(f"Runtime (seconds):           {report.runtime_seconds:.1f}")
    print()
    for d in report.per_date:
        status = "OK" if d.ok else "MISMATCH"
        print(
            f"  {d.collection_date}: preScan={d.pre_scan_collected_count} "
            f"scanned={d.scanned_count} staged={d.staged_row_count} "
            f"shardFiles={d.shard_file_count} [{status}]"
        )

    print(f"\n{report.measure_only_date} (measure-only, NOT staged, NOT repaired):")
    print(f"  YobiRunSummaries intended count: {report.measure_only_intended_count}")
    print(f"  Actual scanned/stored count:     {report.measure_only_actual_count}")
    print(f"  Shortfall (intended - actual):   {report.measure_only_shortfall}")

    if report.other_dates:
        print("\nOther dates observed in this scan (NOT staged, NOT part of this migration):")
        for collection_date, count in sorted(report.other_dates.items()):
            print(f"  {collection_date}: {count} rows")

    if report.baseline_drift:
        print("\nBASELINE DRIFT (live YobiRunSummaries differs from the approved baseline given for T2.7E):")
        for collection_date, delta in sorted(report.baseline_drift.items()):
            print(f"  {collection_date}: delta={delta:+d}")

    if report.anomalies:
        print("\nANOMALIES:")
        for a in report.anomalies:
            print(f"  - {a}")

    print(f"\nOVERALL: {'PASS' if report.ok else 'FAIL'}")
    return 0 if report.ok else 1


if __name__ == "__main__":
    sys.exit(main())
