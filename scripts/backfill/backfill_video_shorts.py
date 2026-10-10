"""Backfill (B18): mark already-stored YouTube Shorts as contentType="short" in Video Master and the tracking manifest.

New videos are flagged at discovery (collection.main._discover_creator); this script brings the EXISTING catalog in
line so Home's 最新影片 (contentType=upload) stops listing Shorts that were stored as plain uploads. The signal is each
channel's own Shorts shelf (its "UUSH" playlist, tracking.video_discovery.discover_short_video_ids) -- never duration
and never a "#shorts" title. Quota: 1 YouTube unit per 50 Shorts per creator; nothing else is called.

Defaults to a DRY RUN (reports, writes nothing). --execute --yes writes:

1. YobiVideoMaster: a targeted conditional UpdateItem (stores.dynamodb_store.set_video_short) that only ever turns a
   stored "upload" (or unclassified) record into "short" and removes liveStatus. A livestream record is never touched
   (a Short cannot be live; such a record is counted in `unexpectedLive` and left alone), nor is anything else.
2. Tracking manifest (S3, 16 shards): ONLY content_type/live_status of the entries for those videos, through
   tracking_manifest.patch_shard (the same ETag-conditional read-modify-write loop the history worker uses). Every other
   field is carried over exactly. This script never calls publish_tracking_manifest.

The video-ranking S3 results are NOT written here: analytics.ranking_reducer rebuilds each creator's result from the
manifest on every daily ReduceRankings run, so Shorts leave the upload shelf on the next SUCCESSFUL run.

Idempotent and resumable (a re-run only touches records/entries that are still "upload"/unclassified); a record already
"short" in Video Master still has its manifest entry aligned, so an interrupted run is finished by running it again.
Run it outside the daily collection window (see backfill_video_topics.py's "Concurrency" note: the same history-worker
whole-item write race applies, and a re-run repairs it; the history worker never downgrades a "short" afterwards).

Result status: COMPLETE / PARTIAL (recoverable: re-run) / FAILED (aborted) / DRY RUN. --report-file must be outside the
repository.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import replace
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from backfill_video_topics import PreflightError, _preflight_manifest, _safe_error  # noqa: E402  (shared safety rails)
from collection.youtube_client import QuotaExhaustedError, YouTubeAPIError  # noqa: E402
from stores.dynamodb_store import VIDEO_MASTER_TABLE, get_videos_by_creator, set_video_short  # noqa: E402
from stores.history_store import HISTORY_SHARD_COUNT  # noqa: E402
from tracking.creator_master import Creator  # noqa: E402
from tracking.tracking_manifest import ManifestEntry, S3TrackingManifestStore, patch_shard  # noqa: E402
from tracking.video_discovery import discover_short_video_ids, get_shorts_playlist_id  # noqa: E402

# A systemic cause (expired credentials, table gone, throttling) stops the run instead of failing item by item.
MAX_CONSECUTIVE_WRITE_ERRORS = 25

STATUS_COMPLETE = "COMPLETE"
STATUS_PARTIAL = "PARTIAL (recoverable: fix the cause, then re-run --execute)"
STATUS_FAILED = "FAILED"
STATUS_DRY_RUN = "DRY RUN"


def _patched_entry(entry: ManifestEntry, short_ids: set[str]) -> ManifestEntry:
    """`entry` with content_type="short" (and no live_status) when it is a stored upload/unclassified Short, else itself."""
    if entry.video_id in short_ids and entry.content_type in (None, "upload"):
        return replace(entry, content_type="short", live_status=None)
    return entry


def _backfill_manifest(store: S3TrackingManifestStore, short_ids: set[str], *, execute: bool, summary: dict[str, Any]) -> None:
    """Report (and, only with execute=True, patch) the manifest entries that should become "short"."""
    summary.update(
        {
            "manifestEntriesPatchable": 0,
            "manifestEntriesPatched": 0,
            "manifestShardsPatched": 0,
            "manifestShardErrors": 0,
            "manifestEntriesRemainingPatchable": 0,
        }
    )
    for shard in range(HISTORY_SHARD_COUNT):
        try:
            entries, _version = store.read_shard_for_patch(shard)
        except Exception as exc:
            summary["manifestShardErrors"] += 1
            print(f"Error: manifest shard {shard:02d} read failed ({_safe_error(exc)})")
            continue
        patchable = sum(1 for entry in entries if _patched_entry(entry, short_ids) is not entry)
        summary["manifestEntriesPatchable"] += patchable
        if not patchable or not execute:
            continue

        patched_count = 0

        def _apply(current: list[ManifestEntry]) -> list[ManifestEntry]:
            nonlocal patched_count
            patched = [_patched_entry(entry, short_ids) for entry in current]
            patched_count = sum(1 for before, after in zip(current, patched) if before is not after)
            return patched

        try:
            patch_shard(store, shard, _apply)
            verified, _version = store.read_shard_for_patch(shard)
        except Exception as exc:
            summary["manifestShardErrors"] += 1
            summary["manifestEntriesRemainingPatchable"] += patchable
            print(f"Error: manifest shard {shard:02d} patch failed ({_safe_error(exc)})")
            continue
        summary["manifestEntriesPatched"] += patched_count
        summary["manifestShardsPatched"] += 1
        summary["manifestEntriesRemainingPatchable"] += sum(1 for entry in verified if _patched_entry(entry, short_ids) is not entry)
    if execute:
        summary["manifestReconciled"] = summary["manifestEntriesPatched"] == summary["manifestEntriesPatchable"]


def _final_status(summary: dict[str, Any], *, execute: bool) -> str:
    """COMPLETE only when every planned write landed and the manifest reconciles; anything else is PARTIAL/FAILED."""
    if summary.get("abortedReason"):
        return STATUS_FAILED
    if not execute:
        return STATUS_DRY_RUN
    if summary.get("manifestShardErrors", 0) >= HISTORY_SHARD_COUNT:
        return STATUS_FAILED
    incomplete = (
        summary["creatorErrors"]
        or summary["writeErrors"]
        or summary["skippedConcurrent"]
        or summary.get("manifestShardErrors", 0)
        or summary.get("manifestEntriesRemainingPatchable", 0)
        or summary.get("manifestReconciled") is False
        or summary["attempted"] != summary["updated"] + summary["skippedConcurrent"] + summary["writeErrors"]
    )
    return STATUS_PARTIAL if incomplete else STATUS_COMPLETE


def backfill_shorts(
    *,
    youtube: Any,
    creators: list[Creator],
    execute: bool,
    manifest_store: S3TrackingManifestStore | None,
) -> dict[str, Any]:
    """Find each creator's stored videos that sit on their Shorts shelf and (with execute=True) mark them "short".

    Always returns the summary, including when the run is aborted ("abortedReason"). With execute=True and a manifest
    store, all 16 manifest shards are preflighted before the first Video Master write.
    """
    summary: dict[str, Any] = {
        "creatorsInspected": 0,
        "creatorsWithoutShortsPlaylist": 0,
        "creatorErrors": 0,
        "shortsOnShelves": 0,
        "alreadyShort": 0,
        "wouldUpdate": 0,
        "attempted": 0,
        "updated": 0,
        "skippedConcurrent": 0,
        "writeErrors": 0,
        "unexpectedLive": 0,
        "shelfVideosNotInVideoMaster": 0,
    }
    short_ids: set[str] = set()  # every Short whose Video Master record is (or just became) "short"

    if execute and manifest_store is not None:
        try:
            summary["manifestPreflightEntries"] = _preflight_manifest(manifest_store)
        except PreflightError as exc:
            print(f"Preflight failed: {exc}")
            summary["preflightFailed"] = True
            summary["abortedReason"] = f"manifest preflight failed: {exc}"
            summary["status"] = _final_status(summary, execute=execute)
            return summary

    consecutive_write_errors = 0
    try:
        for creator in creators:
            summary["creatorsInspected"] += 1
            playlist_id = get_shorts_playlist_id(creator.youtube_channel_id)
            if playlist_id is None:
                summary["creatorsWithoutShortsPlaylist"] += 1
                continue
            try:
                shelf_ids = discover_short_video_ids(youtube, playlist_id)
            except QuotaExhaustedError:
                summary["abortedReason"] = "YouTube quota exhausted"
                break
            except YouTubeAPIError as exc:
                summary["creatorErrors"] += 1
                print(f"Error: Shorts shelf lookup failed for {creator.creator_id!r} ({type(exc).__name__})")
                continue
            summary["shortsOnShelves"] += len(shelf_ids)

            stored = {video.video_id: video for video in get_videos_by_creator(creator.creator_id)}
            summary["shelfVideosNotInVideoMaster"] += sum(1 for video_id in shelf_ids if video_id not in stored)
            for video_id in sorted(shelf_ids & stored.keys()):
                content_type = stored[video_id].content_type
                if content_type == "short":
                    summary["alreadyShort"] += 1
                    short_ids.add(video_id)
                    continue
                if content_type not in (None, "upload"):
                    summary["unexpectedLive"] += 1  # a Short cannot be a livestream: leave the record alone
                    continue
                summary["wouldUpdate"] += 1
                if not execute:
                    short_ids.add(video_id)
                    continue
                summary["attempted"] += 1
                try:
                    written = set_video_short(video_id)
                except Exception as exc:
                    summary["writeErrors"] += 1
                    consecutive_write_errors += 1
                    print(f"Error: Shorts write failed for {video_id!r} ({_safe_error(exc)})")
                    if consecutive_write_errors >= MAX_CONSECUTIVE_WRITE_ERRORS:
                        summary["abortedReason"] = f"{consecutive_write_errors} consecutive Video Master write failures"
                        break
                    continue
                consecutive_write_errors = 0
                if written:
                    summary["updated"] += 1
                    short_ids.add(video_id)
                else:
                    summary["skippedConcurrent"] += 1  # deleted, became a livestream, or another writer got there first
            if summary.get("abortedReason"):
                break
    except KeyboardInterrupt:
        print("\nInterrupted (Ctrl-C): stopping; progress so far is in the summary below.")
        summary["abortedReason"] = "interrupted (Ctrl-C)"

    if manifest_store is not None and not summary.get("abortedReason"):
        _backfill_manifest(manifest_store, short_ids, execute=execute, summary=summary)
    summary["status"] = _final_status(summary, execute=execute)
    return summary


def _exit_code(summary: dict[str, Any]) -> int:
    """0 for a COMPLETE run or an error-free dry run; 2 for a preflight abort; 1 otherwise."""
    if summary.get("preflightFailed"):
        return 2
    if summary["status"] == STATUS_DRY_RUN:
        return 1 if summary["creatorErrors"] or summary.get("manifestShardErrors") else 0
    return 0 if summary["status"] == STATUS_COMPLETE else 1


def main(argv: list[str] | None = None) -> int:
    """CLI entry point: dry run by default; --execute --yes marks stored Shorts in Video Master and the manifest."""
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter, allow_abbrev=False)
    parser.add_argument("--execute", action="store_true", help="Actually write. Without this flag the run only reports (dry run).")
    parser.add_argument("--yes", action="store_true", help="Required together with --execute: confirm the targets printed first.")
    parser.add_argument("--creator", help="Restrict the run to one creatorId (e.g. to try it on a single creator first).")
    parser.add_argument("--report-file", type=Path, help="Write the full summary as JSON to this path (must be outside the repository).")
    args = parser.parse_args(argv)

    if args.report_file is not None and args.report_file.resolve().is_relative_to(REPO_ROOT):
        print("--report-file must be outside the repository (a production report must never be committed); nothing was written.")
        return 2
    bucket_name = os.environ.get("YOBI_HISTORY_BUCKET")
    mode = "EXECUTE (writes)" if args.execute else "DRY RUN (no writes)"
    print(f"=== Shorts backfill -- {mode} ===\n")
    print("Targets (non-secret names only):")
    print(f"  DynamoDB table : {VIDEO_MASTER_TABLE}")
    print(f"  Manifest bucket: {bucket_name or 'NOT CONFIGURED'}")
    print(f"  Creator scope  : {args.creator or 'all active creators'}\n")
    if args.execute and not args.yes:
        print("Refusing to write without --yes. Re-run with --yes to write to the targets above (nothing was written).")
        return 2
    if args.execute and not bucket_name:
        print("YOBI_HISTORY_BUCKET is not configured; refusing to write Video Master without patching the manifest.")
        return 2

    from collection.youtube_client import build_youtube_client
    from ops.config import get_api_key
    from tracking.creator_master import get_active_creators

    creators = [creator for creator in get_active_creators() if args.creator in (None, creator.creator_id)]
    if args.creator and not creators:
        print(f"No active creator with creatorId {args.creator!r}; nothing was done.")
        return 2
    summary = backfill_shorts(
        youtube=build_youtube_client(get_api_key()),
        creators=creators,
        execute=args.execute,
        manifest_store=S3TrackingManifestStore(bucket_name) if bucket_name else None,
    )
    for key, value in summary.items():
        print(f"{key}: {value}")
    if args.report_file is not None:
        args.report_file.parent.mkdir(parents=True, exist_ok=True)
        args.report_file.write_text(json.dumps({"mode": mode, **summary}, indent=2, sort_keys=True), encoding="utf-8")
        print(f"Report written to {args.report_file}")
    if args.execute:
        print("\nRanking S3 is not written here: Shorts leave the upload shelf on the next SUCCESSFUL ReduceRankings run.")
    print(f"\nRESULT: {summary['status']}")
    return _exit_code(summary)


if __name__ == "__main__":
    sys.exit(main())
