"""Backfill the `topic` field on existing YobiVideoMaster records and tracking-manifest entries from their stored titles.

Classifies with tracking.video_topics.classify_video_topic only: no YouTube
calls, no quota. Defaults to a dry run (report only, no writes). Pass --execute
to write. Run it outside the daily collection window (see "Concurrency" below).

What --execute writes, and nothing else:

1. YobiVideoMaster: a targeted UpdateItem on `topic` only, conditional on the
   record not already having one (attribute_not_exists), so no other Video
   Master field is touched and an existing valid topic is never overwritten.
   A record that already has a valid topic is skipped; --reclassify re-derives
   every topic from the title and rewrites only the ones that change.
2. Tracking manifest (S3, 16 shards): ONLY the `topic` field of entries that
   currently have none (or, with --reclassify, whose topic differs from Video
   Master's), via tracking_manifest.patch_shard -- the same bounded-retry,
   ETag-conditional read-modify-write loop discovery and the history worker
   use. Every other field (active, activity_state, content_type, live_status,
   discovered_at, ...) is carried over exactly as the shard's own current
   state has it, manifest-only entries are never dropped, and a shard with
   nothing to patch is never written. This script never calls
   publish_tracking_manifest (an unconditional full rebuild that would reset
   every entry to active=True, drop manifest entries absent from Video Master,
   and overwrite concurrent patches) -- see backfill_manifest_titles.py for the
   same reasoning.

Write confirmation: --execute prints the resolved, non-secret write targets
(DynamoDB table name, manifest bucket name, mode) and refuses to write unless
--yes is also given (exit 2, zero writes). A dry run never needs --yes.
--reclassify with --execute needs the same --yes and prints an explicit
overwrite warning. --skip-manifest always prints its own warning.

--reclassify (with --execute) may OVERWRITE existing topic values. Video Master
rewrites are compare-and-set against the topic value read in this run (a value
that changed meanwhile is counted in skippedConcurrent, never overwritten);
manifest entries are aligned to Video Master's topic through patch_shard. Without
--reclassify an existing valid manifest topic is never overwritten even if it
differs from Video Master's: such entries are counted in manifestEntriesDivergent
and keep the run from being reported COMPLETE.

Preflight: before the FIRST Video Master write, --execute reads all 16
manifest shards. If any shard cannot be read (wrong bucket, AccessDenied, ...)
or the manifest has zero entries in total, it aborts with ZERO writes anywhere
and a non-zero exit code. --skip-manifest deliberately bypasses the manifest
entirely (no preflight, no read, no patch): it backfills Video Master only,
prints a warning, and leaves the manifest (and so ranking) without the new
topics until a later run without the flag.

Result status (always printed, together with the full summary):
  COMPLETE   -- every write succeeded, the manifest patch count reconciles with
                the planned count, nothing is left to do (exit 0).
  PARTIAL    -- recoverable: some item/shard was skipped or failed, work
                remains, a divergent manifest topic was left in place, or the
                patched count did not reconcile with the planned count
                (manifestReconciled: False, which is never reported as clean
                COMPLETE -- a false negative is preferred over a false claim of
                completion); fix the cause and re-run --execute (exit 1).
  FAILED     -- aborted (preflight, Video Master scan, too many consecutive
                write failures, or Ctrl-C); see abortedReason (exit 1, or 2 for a
                preflight/guard abort, which performs no writes at all).
  DRY RUN    -- report only; exits 1 only if the scan/reads themselves had
                errors.
A recoverable partial run is NOT reported as success.

The video-ranking S3 result is NOT written here. analytics.ranking_reducer
rebuilds each creator's result from the manifest's `topic` on every daily
ReduceRankings run, so ranking rows pick the backfilled topics up on the next
SUCCESSFUL ReduceRankings run (a failed ranking build leaves the previous
results in place). Re-implementing the reducer here (or re-running it out of
band, which needs the execution lock) would be a larger and riskier write.

Idempotent and resumable: a re-run only touches records/entries that still
lack a topic. A manifest entry's topic is always taken from Video Master's own
topic (the value just written, or the one it already had), so a run that is
interrupted -- or partially fails -- after Video Master is updated but before
every manifest shard is patched is completed by simply running --execute again.

Concurrency: the remaining Video Master race is the history worker's
`upsert_videos(scheduler_updates)` path (collection.history_worker): it reads
a video (get_video), derives its new scheduler state, and writes the WHOLE item
back with put_item, so a read that predates this script's topic write can
overwrite that topic with the older, topic-less copy. (Discovery is not part of
this race: it only writes newly discovered videos, never an existing item.)
This is a known, accepted limitation of the existing Video Master design, not
changed here. Run --execute only while no daily collection or ranking
execution is in flight (collection 18:00 JST plus the run time that follows
it, and keep clear of discovery at 00:00 JST for the manifest patch); a re-run
repairs any topic that was overwritten. The manifest patch itself is
conflict-safe against concurrent manifest writers.

Known limitations (accepted; the script reports them rather than hiding them,
and none is ever described as "fully reconciled"):
- Manifest-only entries (no Video Master row) cannot receive a topic from this
  script: Video Master is the only source. They are counted in
  manifestEntriesStillMissingTopic and keep an --execute run PARTIAL.
- A manifest topic that differs from Video Master's is never overwritten in the
  default mode. It is counted in manifestEntriesDivergent and keeps the run
  PARTIAL; resolving it needs an explicit --reclassify (which also re-derives
  Video Master's topic from the title) or a manual data repair.
- Preflight verifies that all 16 manifest shards can be READ, not that the
  credentials may WRITE to S3 (a read-only role passes preflight; every shard
  patch then fails and the run is reported FAILED/PARTIAL, recoverable by a
  re-run once permissions are fixed).
- The manifest reader treats a missing shard object as an empty shard. Preflight
  only rejects a manifest that is empty in total; a manifest with some missing
  shards still passes, and Video Master videos absent from the manifest are not
  reported by this script.
- Console output never includes raw AWS error text (it can contain IAM ARNs and
  account IDs): only the exception class and the AWS error code are printed.
- Ctrl-C stops the run as FAILED (interrupted), prints the summary of the
  progress so far and exits non-zero; every write already made is complete, and
  a re-run resumes safely.
"""

from __future__ import annotations

import argparse
import os
import sys
from collections import Counter
from dataclasses import replace
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))

from botocore.exceptions import ClientError  # noqa: E402

from stores.dynamodb_store import VIDEO_MASTER_TABLE, scan_video_topic_items, set_video_topic  # noqa: E402
from stores.history_store import HISTORY_SHARD_COUNT  # noqa: E402
from tracking.tracking_manifest import ManifestEntry, S3TrackingManifestStore, patch_shard  # noqa: E402
from tracking.video_topics import TOPIC_IDS, classify_video_topic  # noqa: E402

# A transient failure on one item is counted and skipped; this many failures in a
# row means the cause is systemic (expired credentials, table gone, throttling
# that is not clearing), so the run stops instead of failing 128k items one by one.
MAX_CONSECUTIVE_WRITE_ERRORS = 25

STATUS_COMPLETE = "COMPLETE"
STATUS_PARTIAL = "PARTIAL (recoverable: fix the cause, then re-run --execute)"
STATUS_FAILED = "FAILED"
STATUS_DRY_RUN = "DRY RUN"


class PreflightError(RuntimeError):
    """The manifest cannot safely be written to, so no write may start."""


def _safe_error(exc: BaseException) -> str:
    """Describe a failure for the console without leaking AWS identifiers or response text.

    Prints only the exception class and, when a botocore ClientError is the exception
    or its cause (the stores wrap it in their own error types), its AWS error code.
    Never str(exc): AWS messages can carry IAM ARNs, account IDs and resource names.
    """
    cause = exc
    while cause is not None and not isinstance(cause, ClientError):
        cause = cause.__cause__ or cause.__context__
    if isinstance(cause, ClientError):
        code = cause.response.get("Error", {}).get("Code") or "unknown"
        return f"{type(exc).__name__}, AWS error code {code}"
    return type(exc).__name__


def _preflight_manifest(store: S3TrackingManifestStore) -> int:
    """Read all 16 manifest shards before any write; raise PreflightError if one is unreadable or the manifest is empty.

    Returns the total entry count. A shard that does not exist reads as empty,
    so only an unreadable shard or a manifest with no entries at all aborts.
    """
    total = 0
    for shard in range(HISTORY_SHARD_COUNT):
        try:
            entries, _version = store.read_shard_for_patch(shard)
        except Exception as exc:
            raise PreflightError(f"manifest shard {shard:02d} could not be read ({_safe_error(exc)})") from exc
        total += len(entries)
    if total == 0:
        raise PreflightError("manifest has zero entries across all shards; refusing to write")
    return total


def _patched_entry(entry: ManifestEntry, topic_by_video: dict[str, str], *, reclassify: bool) -> ManifestEntry:
    """Return `entry` with only `topic` changed, or `entry` itself when nothing applies.

    Sets topic when the entry has none, or (reclassify only) when it differs
    from Video Master's; never touches an entry Video Master has no topic for.
    """
    target = topic_by_video.get(entry.video_id)
    if target is None or entry.topic == target:
        return entry
    if entry.topic is None or reclassify:
        return replace(entry, topic=target)
    return entry


def _count_patchable(entries: list[ManifestEntry], topic_by_video: dict[str, str], *, reclassify: bool) -> int:
    """How many of `entries` would still change under _patched_entry."""
    return sum(1 for entry in entries if _patched_entry(entry, topic_by_video, reclassify=reclassify) is not entry)


def _backfill_manifest_topics(
    store: S3TrackingManifestStore,
    topic_by_video: dict[str, str],
    *,
    execute: bool,
    reclassify: bool,
    summary: dict[str, Any],
) -> None:
    """Report (and, only with execute=True, patch) manifest entries whose topic should be set from Video Master.

    Reads every shard (a plain GetObject, even in a dry run, so the report
    reflects the manifest's real current state); only execute=True calls
    patch_shard, and only for a shard with at least one patchable entry. A
    failure on one shard (read, exhausted patch_shard retries, verification
    read) is counted in manifestShardErrors and the independent remaining
    shards still run. After each patch the shard is re-read to count entries
    that are still patchable, so "patched" is verified rather than assumed.
    """
    summary.update(
        {
            "manifestShardsInspected": 0,
            "manifestEntriesInspected": 0,
            "manifestEntriesMissingTopic": 0,
            "manifestEntriesPatchable": 0,
            "manifestEntriesStillMissingTopic": 0,
            "manifestEntriesDivergent": 0,
            "manifestEntriesPatched": 0,
            "manifestShardsPatched": 0,
            "manifestShardErrors": 0,
            "manifestFailedShards": [],
            "manifestEntriesRemainingPatchable": 0,
            "manifestAffectedShards": [],
        }
    )

    def _shard_failed(shard: int, what: str, exc: Exception) -> None:
        """Record one shard-level failure without stopping the other shards."""
        summary["manifestShardErrors"] += 1
        summary["manifestFailedShards"].append(shard)
        print(f"Error: manifest shard {shard:02d} {what} failed ({_safe_error(exc)})")

    for shard in range(HISTORY_SHARD_COUNT):
        try:
            entries, _version = store.read_shard_for_patch(shard)
        except Exception as exc:
            _shard_failed(shard, "read", exc)
            continue
        summary["manifestShardsInspected"] += 1
        summary["manifestEntriesInspected"] += len(entries)

        missing = [entry for entry in entries if entry.topic is None]
        patchable_count = _count_patchable(entries, topic_by_video, reclassify=reclassify)
        summary["manifestEntriesMissingTopic"] += len(missing)
        summary["manifestEntriesPatchable"] += patchable_count
        summary["manifestEntriesStillMissingTopic"] += sum(1 for entry in missing if entry.video_id not in topic_by_video)
        # An existing manifest topic that disagrees with Video Master's: only --reclassify overwrites it.
        summary["manifestEntriesDivergent"] += sum(
            1
            for entry in entries
            if entry.topic is not None and topic_by_video.get(entry.video_id) not in (None, entry.topic)
        )

        if not patchable_count:
            continue
        summary["manifestAffectedShards"].append(shard)
        if not execute:
            continue

        patched_count = 0

        def _apply(current_entries: list[ManifestEntry]) -> list[ManifestEntry]:
            """Patch the shard's current entries; recounts on a retry so only the final attempt's count is kept."""
            nonlocal patched_count
            patched = [_patched_entry(entry, topic_by_video, reclassify=reclassify) for entry in current_entries]
            patched_count = sum(1 for before, after in zip(current_entries, patched) if before is not after)
            return patched

        try:
            patch_shard(store, shard, _apply)
        except Exception as exc:
            _shard_failed(shard, "patch", exc)
            summary["manifestEntriesRemainingPatchable"] += patchable_count
            continue
        summary["manifestEntriesPatched"] += patched_count
        summary["manifestShardsPatched"] += 1

        try:
            verified_entries, _version = store.read_shard_for_patch(shard)
        except Exception as exc:
            _shard_failed(shard, "verification read", exc)
            summary["manifestEntriesRemainingPatchable"] += patchable_count
            continue
        summary["manifestEntriesRemainingPatchable"] += _count_patchable(
            verified_entries, topic_by_video, reclassify=reclassify
        )

    if execute:
        summary["manifestReconciled"] = summary["manifestEntriesPatched"] == summary["manifestEntriesPatchable"]


def _final_status(summary: dict[str, Any], *, execute: bool, reclassify: bool) -> str:
    """Classify the run as COMPLETE / PARTIAL / FAILED (or DRY RUN) from its own accounting.

    A manifestReconciled of False (patched count != planned count) is never a clean
    COMPLETE: even with nothing left patchable, a concurrent change may have hidden
    lost work, and no benign case is proven, so it is reported PARTIAL. Likewise a
    divergent manifest topic left in place (no --reclassify) is an inconsistency.
    """
    if summary.get("abortedReason"):
        return STATUS_FAILED
    if not execute:
        return STATUS_DRY_RUN
    if summary.get("manifestShardErrors", 0) >= HISTORY_SHARD_COUNT:
        return STATUS_FAILED
    incomplete = (
        summary["errors"]
        or summary["writeErrors"]
        or summary["skippedConcurrent"]
        or summary.get("manifestShardErrors", 0)
        or summary.get("manifestEntriesRemainingPatchable", 0)
        or summary.get("manifestEntriesStillMissingTopic", 0)
        or summary.get("manifestReconciled") is False
        or (not reclassify and summary.get("manifestEntriesDivergent", 0))
        or summary["attempted"] != summary["updated"] + summary["skippedConcurrent"] + summary["writeErrors"]
    )
    if incomplete:
        return STATUS_PARTIAL
    if summary.get("manifestSkipped"):
        return f"{STATUS_COMPLETE} (Video Master only; manifest skipped)"
    return STATUS_COMPLETE


def backfill_topics(
    *, execute: bool, reclassify: bool, manifest_store: S3TrackingManifestStore | None = None
) -> dict[str, Any]:
    """Classify Video Master titles missing a topic and, when `manifest_store` is given, mirror them onto the manifest.

    Without execute=True nothing is written anywhere; the manifest section of
    the summary then reports what a real run would patch. `manifest_store=None`
    skips the manifest entirely (Video Master only). Always returns the
    summary, including when the run is aborted (see "status"/"abortedReason");
    execute=True with a manifest preflights all shards before the first write.
    """
    topic_counts: Counter[str] = Counter()
    topic_by_video: dict[str, str] = {}
    summary: dict[str, Any] = {
        "scanned": 0,
        "alreadyClassified": 0,
        "missingTopic": 0,
        "wouldUpdate": 0,
        "attempted": 0,
        "updated": 0,
        "skippedConcurrent": 0,
        "writeErrors": 0,
        "errors": 0,
    }
    if manifest_store is None:
        summary["manifestSkipped"] = True

    try:
        _run_backfill(
            summary, topic_counts, topic_by_video, execute=execute, reclassify=reclassify, manifest_store=manifest_store
        )
    except KeyboardInterrupt:
        # Progress already counted in `summary` is kept. Every write so far is complete (one atomic
        # UpdateItem or one conditional shard PutObject at a time), so a re-run safely resumes.
        print("\nInterrupted (Ctrl-C): stopping; progress so far is in the summary below.")
        summary["abortedReason"] = "interrupted (Ctrl-C)"
        summary.setdefault("topicCounts", {topic: topic_counts[topic] for topic in sorted(topic_counts)})
        summary.setdefault("otherCount", topic_counts["other"])
    summary["status"] = _final_status(summary, execute=execute, reclassify=reclassify)
    return summary


def _run_backfill(
    summary: dict[str, Any],
    topic_counts: Counter[str],
    topic_by_video: dict[str, str],
    *,
    execute: bool,
    reclassify: bool,
    manifest_store: S3TrackingManifestStore | None,
) -> None:
    """The preflight -> scan -> Video Master writes -> manifest patch work of backfill_topics.

    Fills `summary` in place and returns early (with `abortedReason` set) on a preflight
    or scan failure, so the caller always has the progress counted so far.
    """
    if execute and manifest_store is not None:
        try:
            summary["manifestPreflightEntries"] = _preflight_manifest(manifest_store)
        except PreflightError as exc:
            print(f"Preflight failed: {exc}")
            summary["preflightFailed"] = True
            summary["abortedReason"] = f"manifest preflight failed: {exc}"
            return

    try:
        items = scan_video_topic_items()
    except Exception as exc:
        summary["abortedReason"] = f"Video Master scan failed ({_safe_error(exc)})"
        return

    consecutive_write_errors = 0
    for item in items:
        summary["scanned"] += 1
        existing = item.get("topic")
        has_valid_topic = isinstance(existing, str) and existing in TOPIC_IDS
        if has_valid_topic and not reclassify:
            summary["alreadyClassified"] += 1
            topic_by_video[item["videoId"]] = existing
            continue
        if existing is not None and not has_valid_topic and not reclassify:
            print(f"Error: {item.get('videoId')!r} has an invalid topic {existing!r}; use --reclassify to replace it")
            summary["errors"] += 1
            continue
        title = item.get("title")
        if not isinstance(item.get("videoId"), str) or not isinstance(title, str) or not title.strip():
            print(f"Error: malformed Video Master record, cannot classify: {item!r}")
            summary["errors"] += 1
            continue
        topic = classify_video_topic(title)
        if existing is None:
            summary["missingTopic"] += 1
        elif existing == topic:
            summary["alreadyClassified"] += 1
            topic_by_video[item["videoId"]] = existing
            continue
        summary["wouldUpdate"] += 1
        topic_counts[topic] += 1
        if not execute:
            topic_by_video[item["videoId"]] = topic
            continue

        summary["attempted"] += 1
        try:
            # Never an unconditional overwrite: a missing topic is only ever filled while it is still
            # missing, and under --reclassify a present one is replaced only if it still equals the
            # value read above (compare-and-set), so a concurrent newer value is never clobbered.
            overwrite = existing is not None
            written = set_video_topic(
                item["videoId"], topic, overwrite=overwrite, expected_topic=existing if overwrite else None
            )
        except Exception as exc:
            summary["writeErrors"] += 1
            consecutive_write_errors += 1
            print(f"Error: topic write failed for {item['videoId']!r} ({_safe_error(exc)})")
            if consecutive_write_errors >= MAX_CONSECUTIVE_WRITE_ERRORS:
                summary["abortedReason"] = f"{consecutive_write_errors} consecutive Video Master write failures"
                break
            continue
        consecutive_write_errors = 0
        if written:
            summary["updated"] += 1
            topic_by_video[item["videoId"]] = topic
        else:
            # Conditional write rejected: the video was deleted, or already got a
            # topic from another writer. Not an error, but not silently complete either.
            summary["skippedConcurrent"] += 1

    summary["topicCounts"] = {topic: topic_counts[topic] for topic in sorted(topic_counts)}
    summary["otherCount"] = topic_counts["other"]

    if manifest_store is not None and not summary.get("abortedReason"):
        _backfill_manifest_topics(
            manifest_store, topic_by_video, execute=execute, reclassify=reclassify, summary=summary
        )


def _exit_code(summary: dict[str, Any]) -> int:
    """0 only for a COMPLETE execute run or an error-free dry run; 2 for a preflight abort; 1 otherwise."""
    if summary.get("preflightFailed"):
        return 2
    status = summary["status"]
    if status == STATUS_DRY_RUN:
        return 1 if summary["errors"] or summary.get("manifestShardErrors") else 0
    return 0 if status.startswith(STATUS_COMPLETE) else 1


def main(argv: list[str] | None = None) -> int:
    """CLI entry point: dry run by default; --execute writes Video Master topics and patches manifest topics."""
    # allow_abbrev=False: production-write flags (--execute, --yes, ...) must be typed exactly.
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter, allow_abbrev=False
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Actually write Video Master topics and patch manifest topics. Without this flag, reports only (dry run).",
    )
    parser.add_argument(
        "--reclassify",
        action="store_true",
        help="Re-derive the topic of records that already have one, rewriting only those that change.",
    )
    parser.add_argument(
        "--skip-manifest",
        action="store_true",
        help="Video Master only: do not preflight, read or patch the tracking manifest (local/dev, no S3 manifest).",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Required together with --execute: confirm writing to the targets printed at the top of the run.",
    )
    args = parser.parse_args(argv)

    bucket_name = os.environ.get("YOBI_HISTORY_BUCKET")
    mode = ("EXECUTE (writes)" if args.execute else "DRY RUN (no writes)") + (" + RECLASSIFY" if args.reclassify else "")
    manifest_target = "skipped (--skip-manifest)" if args.skip_manifest else (bucket_name or "NOT CONFIGURED")
    print(f"=== Video topic backfill -- {mode} ===\n")
    print("Targets (non-secret names only):")
    print(f"  DynamoDB table : {VIDEO_MASTER_TABLE}")
    print(f"  Manifest bucket: {manifest_target}")
    print(f"  Mode           : {mode}\n")
    if args.skip_manifest and args.execute:
        print("WARNING: --skip-manifest: the manifest (and so ranking) will NOT get these topics until a later run without it.\n")
    if args.reclassify and args.execute:
        print(
            "WARNING: --reclassify may OVERWRITE existing topic values. Video Master rewrites are compare-and-set "
            "(a value changed meanwhile is skipped); manifest entries are aligned to Video Master's topic.\n"
        )
    if args.execute and not args.yes:
        print("Refusing to write without --yes. Re-run with --yes to write to the targets above (nothing was written).")
        return 2
    if args.execute and not args.skip_manifest and not bucket_name:
        print("YOBI_HISTORY_BUCKET is not configured; refusing to write Video Master without patching the manifest.")
        print("Set it, or pass --skip-manifest to backfill Video Master only.")
        return 2
    manifest_store = S3TrackingManifestStore(bucket_name) if bucket_name and not args.skip_manifest else None

    if manifest_store is None and not args.execute:
        print("Manifest: skipped (--skip-manifest or YOBI_HISTORY_BUCKET not configured)\n")
    summary = backfill_topics(execute=args.execute, reclassify=args.reclassify, manifest_store=manifest_store)
    for key, value in summary.items():
        print(f"{key}: {value}")
    if args.execute:
        print(
            "\nRanking S3 is not written here: the new topic values appear in ranking S3 on the next "
            "SUCCESSFUL ReduceRankings run."
        )
    print(f"\nRESULT: {summary['status']}")
    return _exit_code(summary)


if __name__ == "__main__":
    sys.exit(main())
