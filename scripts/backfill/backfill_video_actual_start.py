"""One-time F37 backfill of `actualStartAt` for COMPLETED livestream archives that have none yet.

Why: "On this day" must date a livestream by when it really started, but the catalog only ever stored `publishedAt`. New
observations now capture `actualStartTime` for free (collection.history_worker); the daily Hot/Warm/Cold rotation re-observes
every tracked video within 15 days, so history would fill itself eventually. This script is the optional accelerator for the
back catalog. It is NOT scheduled, and a second copy of it never needs to exist.

Eligible: Video Master records with contentType "live", liveStatus "completed" and no actualStartAt. Premieres/uploads/Shorts
keep publishedAt (a Premiere is published at its start); upcoming/live streams are captured by the daily run once they start.

What it does per run (--execute only), bounded by --max-batches:
1. YouTube videos.list through collection.youtube_client.get_video_statistics (the production parser): 50 ids per request,
   1 quota unit per request, shard by shard.
2. For each video YouTube returns as a completed livestream WITH an actualStartTime: ONE conditional UpdateItem on Video Master
   (stores.dynamodb_store.set_video_actual_start): it only sets actualStartAt, only on a livestream that has none. A stored
   start is never overwritten and an unchanged value is never written.
3. The tracking manifest shard is patched once per shard (S3 conditional read-modify-write) so the ranking reducer sees the
   value; a crash between 2 and 3 is repaired from the checkpoint's `manifestPending` on the next run.

Videos YouTube does not return (deleted/private), returns without a usable start, or no longer reports as a completed livestream
are NEVER given a guessed date: they are recorded in the checkpoint's `settled` map and reported, and are not requested again
unless --retry-unavailable is given.

Scope: --organization / --creator limit planning and writes to those creators and read Video Master through the creatorId index (a few thousand items, never a
full-table scan); without a scope the whole table is scanned once. --probe-only asks YouTube (spends quota) but writes nothing, to measure recoverability first.

Safety: dry run by default (no YouTube client, no API key, no AWS write; with --ranking-dir it does not even read AWS);
--execute needs --yes, YOBI_HISTORY_BUCKET and the aws source; idempotent (a re-run plans only what still lacks a start);
resumable (checkpoint file); quota exhaustion or too many consecutive failures stop the run after persisting what was fetched.
No recurring scheduler.

Exit codes: 0 clean dry run or COMPLETE; 1 PARTIAL/FAILED; 2 a guard refused to start (nothing was written).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Callable, Iterable

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))

from collection.history_worker import normalize_actual_start  # noqa: E402
from collection.quota_ledger import QUOTA_LIMIT_UNITS  # noqa: E402
from collection.youtube_client import (  # noqa: E402
    MAX_IDS_PER_REQUEST,
    SKIP_REASON_API_ERROR_PREFIX,
    SKIP_REASON_NO_DATA,
    QuotaExhaustedError,
    get_video_statistics,
)
from stores.history_store import HISTORY_SHARD_COUNT, shard_for_video  # noqa: E402
from tracking.tracking_manifest import ManifestEntry, patch_shard  # noqa: E402

# videos.list costs 1 quota unit per request however many ids (<= MAX_IDS_PER_REQUEST) it carries.
VIDEOS_LIST_QUOTA_UNITS = 1
DEFAULT_MAX_BATCHES = 200
WRITE_WORKERS = 8
_MAX_CONSECUTIVE_BATCH_FAILURES = 5
# PAY_PER_REQUEST: an UpdateItem on a Video Master item (well under 1 KB) bills 1 write request unit. Assumed, not measured.
WRITE_UNITS_PER_UPDATE = 1

SETTLED_UNAVAILABLE = "unavailable"
SETTLED_NO_START = "noStartTime"
SETTLED_NOT_COMPLETED_LIVE = "notCompletedLivestream"

STATUS_COMPLETE = "COMPLETE"
STATUS_PARTIAL = "PARTIAL (recoverable: fix the cause, then re-run --execute)"
STATUS_FAILED = "FAILED"
STATUS_DRY_RUN = "DRY RUN"


@dataclass(frozen=True)
class CatalogRow:
    """The few Video Master / ranking-result fields the backfill plans from."""

    video_id: str
    content_type: str | None
    live_status: str | None
    actual_start_at: str | None = None
    year: str | None = None
    creator_id: str | None = None


@dataclass
class Checkpoint:
    """Resumable state, saved after every batch: ids settled without a start, and written starts not yet mirrored to the manifest."""

    settled: dict[str, str] = field(default_factory=dict)
    manifest_pending: dict[str, str] = field(default_factory=dict)
    path: Path | None = None

    @classmethod
    def load(cls, path: Path | None) -> "Checkpoint":
        """Read the checkpoint file (an absent path or file is a fresh checkpoint)."""
        if path is None or not path.exists():
            return cls(path=path)
        raw = json.loads(path.read_text(encoding="utf-8"))
        return cls(settled=dict(raw.get("settled", {})), manifest_pending=dict(raw.get("manifestPending", {})), path=path)

    def save(self) -> None:
        """Atomically persist the checkpoint (no-op without a path)."""
        if self.path is None:
            return
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(json.dumps({"settled": self.settled, "manifestPending": self.manifest_pending}, sort_keys=True), encoding="utf-8")
        os.replace(tmp, self.path)


def rows_from_master_items(items: Iterable[dict[str, Any]]) -> list[CatalogRow]:
    """CatalogRows from a Video Master scan (videoId/contentType/liveStatus/actualStartAt)."""
    return [
        CatalogRow(item["videoId"], item.get("contentType"), item.get("liveStatus"), item.get("actualStartAt"), None, item.get("creatorId"))
        for item in items
        if isinstance(item.get("videoId"), str)
    ]


def rows_from_ranking_dir(directory: Path) -> list[CatalogRow]:
    """CatalogRows from downloaded per-creator video-ranking result files (offline dry run); `year` is the publishedAt year."""
    rows: list[CatalogRow] = []
    for path in sorted(directory.glob("*.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        for video in payload.get("videos", []):
            published = video.get("publishedAt") or ""
            rows.append(
                CatalogRow(video["videoId"], video.get("contentType"), video.get("liveStatus"), video.get("actualStartAt"), published[:4] or None, payload.get("creatorId"))
            )
    return rows


def is_eligible(row: CatalogRow) -> bool:
    """A completed livestream archive that has no stored actual start."""
    return row.content_type == "live" and row.live_status == "completed" and not row.actual_start_at


def plan_backfill(rows: list[CatalogRow], *, settled: dict[str, str] | None = None, batch_size: int = MAX_IDS_PER_REQUEST) -> dict[str, Any]:
    """Counts, the eligible ids and the request/quota/write estimates for a catalog; nothing is called or written."""
    settled = settled or {}
    batch_size = max(1, min(batch_size, MAX_IDS_PER_REQUEST))
    kinds: Counter[str] = Counter()
    live_by_status: Counter[str] = Counter()
    eligible: list[str] = []
    eligible_by_year: Counter[str] = Counter()
    already = 0
    for row in rows:
        kinds[row.content_type or "unclassified"] += 1
        if row.content_type == "live":
            live_by_status[row.live_status or "none"] += 1
            if row.live_status == "completed" and row.actual_start_at:
                already += 1
        if is_eligible(row):
            if row.video_id in settled:
                continue
            eligible.append(row.video_id)
            eligible_by_year[row.year or "unknown"] += 1
    eligible.sort()
    requests = math.ceil(len(eligible) / batch_size)
    return {
        "rowsExamined": len(rows),
        "byContentType": dict(sorted(kinds.items())),
        "liveByStatus": dict(sorted(live_by_status.items())),
        "completedLivestreams": live_by_status.get("completed", 0),
        "completedWithActualStart": already,
        "completedMissingActualStart": live_by_status.get("completed", 0) - already,
        "settledExcluded": sum(1 for row in rows if is_eligible(row) and row.video_id in settled),
        "eligible": len(eligible),
        "eligibleByPublishedYear": dict(sorted(eligible_by_year.items())),
        "youtubeBatchSize": batch_size,
        "youtubeRequestsPlanned": requests,
        "youtubeQuotaUnitsPlanned": requests * VIDEOS_LIST_QUOTA_UNITS,
        "youtubeQuotaPercentOfDailyLimit": round(100 * requests * VIDEOS_LIST_QUOTA_UNITS / QUOTA_LIMIT_UNITS, 2),
        "masterWritesPlannedMax": len(eligible),
        "dynamoWriteUnitsPlannedMax": len(eligible) * WRITE_UNITS_PER_UPDATE,
        "manifestShardWritesPlannedMax": min(HISTORY_SHARD_COUNT, len({shard_for_video(v) for v in eligible})),
        "_eligibleIds": eligible,
    }


def _skip_bucket(reason: str) -> str:
    """Map a get_video_statistics skip reason to unavailable / apiFailed / unparseable."""
    if reason == SKIP_REASON_NO_DATA:
        return "unavailable"
    if reason.startswith(SKIP_REASON_API_ERROR_PREFIX):
        return "apiFailed"
    return "unparseable"


def _mirror_to_manifest(manifest_store: Any, shard: int, starts: dict[str, str], patch: Callable[..., Any]) -> None:
    """Set actual_start_at on this shard's manifest entries that have none yet (never overwriting one)."""

    def _apply(entries: list[ManifestEntry]) -> list[ManifestEntry]:
        """The shard's entries with the given starts filled in where missing."""
        return [
            replace(entry, actual_start_at=starts[entry.video_id])
            if entry.video_id in starts and entry.actual_start_at is None
            else entry
            for entry in entries
        ]

    patch(manifest_store, shard, _apply)


def _flush_pending(manifest_store: Any, checkpoint: Checkpoint, patch: Callable[..., Any], summary: dict[str, Any]) -> None:
    """Mirror every checkpointed-but-unmirrored start to its manifest shard, clearing each shard's entries once patched."""
    by_shard: dict[int, dict[str, str]] = {}
    for video_id, start in checkpoint.manifest_pending.items():
        by_shard.setdefault(shard_for_video(video_id), {})[video_id] = start
    for shard, starts in sorted(by_shard.items()):
        _mirror_to_manifest(manifest_store, shard, starts, patch)
        for video_id in starts:
            checkpoint.manifest_pending.pop(video_id, None)
        checkpoint.save()
        summary["manifestShardsPatched"] += 1


def run_backfill(
    rows: list[CatalogRow],
    *,
    execute: bool,
    batch_size: int = MAX_IDS_PER_REQUEST,
    max_batches: int | None = DEFAULT_MAX_BATCHES,
    checkpoint: Checkpoint | None = None,
    retry_unavailable: bool = False,
    manifest_store: Any = None,
    youtube_factory: Callable[[], Any] | None = None,
    get_statistics: Callable[[Any, list[str]], tuple[list[dict], dict[str, str]]] = get_video_statistics,
    write_start: Callable[[str, str], bool] | None = None,
    patch: Callable[..., Any] = patch_shard,
    creator_ids: set[str] | None = None,
    probe_only: bool = False,
) -> dict[str, Any]:
    """Plan, and (execute=True) run, the backfill. A dry run touches nothing external; every collaborator is injected for tests.

    `creator_ids` limits the scope (for example the VSPO roster). `probe_only` (with execute=True) spends YouTube quota but writes NOTHING -- no Video
    Master update, no manifest patch, no checkpoint -- and reports how many of the planned videos YouTube can answer with a start time.
    """
    rows_in_catalog = len(rows)
    if creator_ids is not None:
        rows = [row for row in rows if row.creator_id in creator_ids]
    if probe_only:
        checkpoint = Checkpoint()
    checkpoint = checkpoint or Checkpoint()
    settled = {} if retry_unavailable else dict(checkpoint.settled)
    plan = plan_backfill(rows, settled=settled, batch_size=batch_size)
    eligible_ids: list[str] = plan.pop("_eligibleIds")
    mode = "PROBE ONLY (YouTube requests, no writes)" if (execute and probe_only) else "EXECUTE (writes)" if execute else "DRY RUN (no writes)"
    summary: dict[str, Any] = {"mode": mode, "rowsInCatalog": rows_in_catalog, "scopeCreators": None if creator_ids is None else len(creator_ids), **plan}
    if not execute:
        summary["status"] = STATUS_DRY_RUN
        return summary

    batch_size = plan["youtubeBatchSize"]
    summary.update(
        youtubeRequests=0, videosReturned=0, startsWritten=0, masterRejected=0, settledUnavailable=0, settledNoStart=0,
        settledNotCompletedLivestream=0, apiFailed=0, unparseable=0, manifestShardsPatched=0, batchesDeferred=0, abortedReason=None,
    )
    if probe_only:
        summary["probeRecoverable"] = 0
    else:
        _flush_pending(manifest_store, checkpoint, patch, summary)

    by_shard: dict[int, list[str]] = {}
    for video_id in eligible_ids:
        by_shard.setdefault(shard_for_video(video_id), []).append(video_id)
    youtube: Any = None
    batches_run = 0
    consecutive_failures = 0
    stop = False
    for shard in sorted(by_shard):
        ids = by_shard[shard]
        for start in range(0, len(ids), batch_size):
            batch = ids[start : start + batch_size]
            if max_batches is not None and batches_run >= max_batches:
                summary["batchesDeferred"] += math.ceil((len(ids) - start) / batch_size)
                stop = True
                break
            if youtube is None:
                youtube = youtube_factory()
            batches_run += 1
            summary["youtubeRequests"] += 1
            try:
                videos, skipped = get_statistics(youtube, batch)
                consecutive_failures = 0
            except QuotaExhaustedError:
                summary["abortedReason"] = "YouTube quota exhausted"
                stop = True
                break
            except Exception as exc:  # a whole-request failure: counted, the ids stay eligible for the next run
                consecutive_failures += 1
                summary["apiFailed"] += len(batch)
                if consecutive_failures >= _MAX_CONSECUTIVE_BATCH_FAILURES:
                    summary["abortedReason"] = f"{consecutive_failures} consecutive batch failures ({type(exc).__name__})"
                    stop = True
                    break
                continue
            summary["videosReturned"] += len(videos)
            returned = {video["videoId"]: video for video in videos}
            to_write: dict[str, str] = {}
            for video_id in batch:
                video = returned.get(video_id)
                if video is None:
                    bucket = _skip_bucket(skipped.get(video_id, SKIP_REASON_NO_DATA))
                    if bucket == "unavailable":
                        checkpoint.settled[video_id] = SETTLED_UNAVAILABLE
                        summary["settledUnavailable"] += 1
                    else:
                        summary["apiFailed" if bucket == "apiFailed" else "unparseable"] += 1
                    continue
                if video.get("contentType") != "live" or video.get("liveStatus") != "completed":
                    checkpoint.settled[video_id] = SETTLED_NOT_COMPLETED_LIVE
                    summary["settledNotCompletedLivestream"] += 1
                    continue
                normalized = normalize_actual_start(video.get("actualStartTime"))
                if normalized is None:
                    checkpoint.settled[video_id] = SETTLED_NO_START
                    summary["settledNoStart"] += 1
                    continue
                to_write[video_id] = normalized
            if probe_only:
                summary["probeRecoverable"] += len(to_write)
                continue
            with ThreadPoolExecutor(max_workers=WRITE_WORKERS) as pool:
                outcomes = dict(zip(to_write, pool.map(lambda item: write_start(item[0], item[1]), to_write.items())))
            for video_id, written in outcomes.items():
                if written:
                    summary["startsWritten"] += 1
                    checkpoint.manifest_pending[video_id] = to_write[video_id]
                else:
                    summary["masterRejected"] += 1
            checkpoint.save()
        if stop:
            break
        # One manifest patch per shard, after all of its batches.
        if not probe_only:
            _flush_pending(manifest_store, checkpoint, patch, summary)
    if not probe_only:
        _flush_pending(manifest_store, checkpoint, patch, summary)
    summary["status"] = _final_status(summary)
    return summary


def _final_status(summary: dict[str, Any]) -> str:
    """COMPLETE only when nothing was deferred, failed or aborted."""
    if summary.get("abortedReason") and summary.get("youtubeRequests", 0) == 0:
        return STATUS_FAILED
    clean = not (summary.get("abortedReason") or summary.get("batchesDeferred") or summary.get("apiFailed") or summary.get("unparseable"))
    return STATUS_COMPLETE if clean else STATUS_PARTIAL


def _real_youtube_factory() -> Any:
    """Build the production YouTube client from the collector's own key source (never printed)."""
    from collection.youtube_client import build_youtube_client
    from ops.config import get_api_key

    return build_youtube_client(get_api_key())


def _print_summary(summary: dict[str, Any]) -> None:
    """Print every counter, one per line."""
    for key, value in summary.items():
        print(f"{key}: {value}")


def main(argv: list[str] | None = None) -> int:
    """CLI entry point: dry run by default; --execute --yes writes Video Master and the manifest."""
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter, allow_abbrev=False)
    parser.add_argument("--execute", action="store_true", help="Fetch from YouTube and write. Without it: dry run (no external call, no write).")
    parser.add_argument("--yes", action="store_true", help="Required with --execute: confirm production writes.")
    parser.add_argument("--ranking-dir", help="Offline dry run over downloaded per-creator video-ranking JSON files (reads no AWS).")
    parser.add_argument("--organization", help="Limit the scope to one organization of the Creator Master roster (for example vspo).")
    parser.add_argument("--creator", action="append", default=[], help="Limit the scope to this creatorId (repeatable).")
    parser.add_argument("--probe-only", action="store_true", help="With --yes: request YouTube (spends quota) but write nothing; reports how many videos can be recovered.")
    parser.add_argument("--batch-size", type=int, default=MAX_IDS_PER_REQUEST, help=f"Ids per YouTube request, at most {MAX_IDS_PER_REQUEST}.")
    parser.add_argument("--max-batches", type=int, default=DEFAULT_MAX_BATCHES, help="YouTube requests per run (bounds quota and duration).")
    parser.add_argument("--checkpoint", default="backfill_video_actual_start.checkpoint.json", help="Resumable checkpoint file.")
    parser.add_argument("--retry-unavailable", action="store_true", help="Request ids a previous run settled as unavailable/no start again.")
    parser.add_argument("--report-file", help="Write the final summary as JSON to this file.")
    args = parser.parse_args(argv)

    if args.batch_size < 1 or args.max_batches < 1:
        print("--batch-size and --max-batches must be positive.")
        return 2
    if args.execute and args.ranking_dir:
        print("--execute cannot be combined with --ranking-dir (an offline sample is never a write source); nothing was written.")
        return 2
    if args.probe_only and (args.ranking_dir or args.execute or not args.yes):
        print("--probe-only needs --yes (it spends YouTube quota), cannot be combined with --execute or --ranking-dir; nothing was written.")
        return 2
    if args.execute and not args.yes:
        print("Refusing to write without --yes (nothing was written).")
        return 2
    bucket_name = os.environ.get("YOBI_HISTORY_BUCKET")
    if args.execute and not bucket_name:
        print("YOBI_HISTORY_BUCKET is not configured; refusing to write.")
        return 2

    creator_ids: set[str] | None = None
    if args.organization or args.creator:
        from tracking.creator_master import load_creators

        creator_ids = {c.creator_id for c in load_creators() if args.organization and c.organization == args.organization} | set(args.creator)
        if not creator_ids:
            print("The organization/creator filter matched no creator; nothing was done.")
            return 2
    manifest_store = None
    write_start = None
    if args.ranking_dir:
        rows = rows_from_ranking_dir(Path(args.ranking_dir))
    else:
        from stores import dynamodb_store

        write_start = dynamodb_store.set_video_actual_start
        if creator_ids is not None:
            # A scoped run reads only those creators' items through the creatorId index (bounded), never the whole table.
            rows = [
                CatalogRow(v.video_id, v.content_type, v.live_status, v.actual_start_at, None, v.creator_id)
                for creator_id in sorted(creator_ids)
                for v in dynamodb_store.get_videos_by_creator(creator_id)
            ]
        else:
            rows = rows_from_master_items(dynamodb_store.scan_video_actual_start_items())
        if args.execute:
            from tracking.tracking_manifest import S3TrackingManifestStore

            manifest_store = S3TrackingManifestStore(bucket_name)
    print(f"=== F37 actual-start backfill -- {'PROBE ONLY (YouTube requests, no writes)' if args.probe_only else 'EXECUTE (writes)' if args.execute else 'DRY RUN (no external call, no write)'} ===")
    summary = run_backfill(
        rows,
        execute=args.execute or args.probe_only,
        probe_only=args.probe_only,
        creator_ids=creator_ids,
        batch_size=args.batch_size,
        max_batches=args.max_batches,
        checkpoint=Checkpoint.load(Path(args.checkpoint)),
        retry_unavailable=args.retry_unavailable,
        manifest_store=manifest_store,
        youtube_factory=_real_youtube_factory,
        write_start=write_start,
    )
    _print_summary(summary)
    if args.report_file:
        Path(args.report_file).write_text(json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8")
    print(f"\nRESULT: {summary['status']}")
    return 0 if summary["status"] in (STATUS_DRY_RUN, STATUS_COMPLETE) else 1


if __name__ == "__main__":
    sys.exit(main())
