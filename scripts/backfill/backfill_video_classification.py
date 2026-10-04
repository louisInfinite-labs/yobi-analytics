"""One-time backfill of `contentType`/`liveStatus` for legacy videos, so Home's recent/live shelves work on day one.

Why this exists: Home filters by contentType/liveStatus, which are learned ONLY by observing a video on YouTube
(collection.youtube_client._parse_video_item, via liveStreamingDetails). Every legacy Video Master record and
manifest entry predates both fields, and the history worker's bounded catch-up
(history_worker.UNCLASSIFIED_OBSERVATION_BUDGET_PER_SHARD) would take several scheduled runs to reach them all. That
budget stays as the NORMAL future background repair; this script is the one-time migration, run in a controlled
maintenance window before a scheduled history run.

What it classifies: every ACTIVE manifest entry whose classification is incomplete
(tracking.video_master.is_classification_incomplete: no contentType, or contentType "live" without a liveStatus).
A plain upload with liveStatus None is COMPLETE and is never touched or re-requested.

Same interpretation as production: videos are fetched with collection.youtube_client.get_video_statistics (the exact
function, batching, retry and parser the history worker uses), and the observed pair is applied with the history
worker's own rule (a known contentType owns BOTH fields, including a None liveStatus). No second parser exists here.

Where it writes (--execute only), per manifest shard, in this order:

1. YobiVideoMaster (the source of truth): a targeted, CONDITIONAL UpdateItem on contentType/liveStatus only
   (stores.dynamodb_store.set_video_classification), accepted only while the stored classification is still
   incomplete. Title, topic, scheduler state, view counts and every other attribute are never touched and an
   already-classified record is never overwritten.
2. The tracking manifest shard: ONLY contentType/liveStatus of entries that are still incomplete, through
   tracking_manifest.patch_shard (bounded-retry, ETag-conditional read-modify-write). Entry values always come from the
   authoritative Video Master result, so master and manifest cannot diverge.

Writing Video Master FIRST is what makes the result survive any later full manifest publication
(tracking_manifest.publish_tracking_manifest rebuilds the manifest from Video Master). A manifest-only patch would be
erased by the next full publish. Never touched: S3 history/ (daily view-count rows), rankings, subscriber data, any
other manifest field, and no other DynamoDB table.

Videos YouTube does not return are NEVER given a fabricated classification; they are reported separately:
  unavailable  -- no data returned (deleted/private), left unclassified;
  unparseable  -- returned but malformed per the production parser (e.g. an upcoming stream with no viewCount);
  apiFailed    -- the request itself failed after the client's retries; the run is PARTIAL, re-run to retry them.

Safety properties: dry run by default (reads only: manifest shards + a Video Master scan; no YouTube call, no API key,
no write); --execute needs --yes and --stop-at; abbreviations are disabled; idempotent (a re-run only touches what is
still incomplete and issues no request for anything else); resumable at video granularity (Video Master ahead of the
manifest is synced from Video Master without another YouTube request); bounded (50 ids per request, shard-by-shard,
conditional writes, a consecutive-failure abort); QuotaExhaustedError stops the run after persisting what was fetched.

Time guard: --execute computes the conservative duration estimate BEFORE the first write and refuses to start (exit 2,
zero writes) if it would not finish by --stop-at (minus a safety margin); during the run it stops at a shard boundary
(never starting new YouTube batches) once --stop-at is near. Run it while no history worker/collector run is in flight:
the history worker's whole-item Video Master put can race any other writer (see backfill_video_topics.py).

Status (always printed): COMPLETE / PARTIAL (recoverable: re-run) / FAILED / DRY RUN. Exit codes: 0 clean dry run or
COMPLETE; 1 PARTIAL/FAILED (or a dry run with read errors); 2 a guard refused to start (nothing was written).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))

from botocore.exceptions import ClientError  # noqa: E402

from collection.quota_ledger import QUOTA_LIMIT_UNITS  # noqa: E402
from collection.youtube_client import (  # noqa: E402
    MAX_IDS_PER_REQUEST,
    SKIP_REASON_API_ERROR_PREFIX,
    SKIP_REASON_NO_DATA,
    QuotaExhaustedError,
    get_video_statistics,
)
from stores.dynamodb_store import (  # noqa: E402
    VIDEO_MASTER_TABLE,
    get_video,
    scan_video_classification_items,
    set_video_classification,
)
from stores.history_store import HISTORY_SHARD_COUNT  # noqa: E402
from tracking.tracking_manifest import ManifestEntry, S3TrackingManifestStore, patch_shard  # noqa: E402
from tracking.video_master import VALID_CONTENT_TYPES, VALID_LIVE_STATUSES, is_classification_incomplete  # noqa: E402

Classification = tuple["str | None", "str | None"]  # (contentType, liveStatus)

# videos.list costs 1 quota unit per request regardless of how many ids (<= MAX_IDS_PER_REQUEST) or parts it carries.
VIDEOS_LIST_QUOTA_UNITS = 1

# Concurrent Video Master UpdateItem calls (boto3 resources are per-thread in dynamodb_store). YouTube requests stay
# sequential: the googleapiclient resource is not thread-safe and sequential requests keep quota use predictable.
MASTER_WRITE_WORKERS = 8
_WRITE_CHUNK_SIZE = 200
# A whole chunk of at least this many writes failing means the cause is systemic (credentials, table, throttling).
_SYSTEMIC_FAILURE_MIN_CHUNK = 25
# Consecutive YouTube batches failing unexpectedly (not the client's own skip handling) abort the run.
_MAX_CONSECUTIVE_BATCH_FAILURES = 5

# Planning assumptions, NOT measurements: used for the pre-run estimate and the --stop-at guard. "Conservative"
# must hold on a slow day; "typical" is a hoped-for pace. The per-shard progress lines print the real pace.
CONSERVATIVE_SECONDS_PER_YOUTUBE_REQUEST = 1.5
TYPICAL_SECONDS_PER_YOUTUBE_REQUEST = 0.5
CONSERVATIVE_SECONDS_PER_MASTER_WRITE = 0.05  # per call; divided across MASTER_WRITE_WORKERS
TYPICAL_SECONDS_PER_MASTER_WRITE = 0.015
CONSERVATIVE_SECONDS_PER_MANIFEST_SHARD = 20.0  # read + conditional write + verification read of ~8k rows
TYPICAL_SECONDS_PER_MANIFEST_SHARD = 8.0
CONSERVATIVE_FIXED_SECONDS = 180.0  # 16 manifest reads + the Video Master scan + client setup
TYPICAL_FIXED_SECONDS = 60.0
# The projected conservative finish must leave at least this much room before --stop-at.
SAFETY_MARGIN = timedelta(minutes=10)
# Stop starting new YouTube batches this long before --stop-at, leaving time to persist the shard in progress.
SHARD_FINALIZE_RESERVE = timedelta(minutes=3)

STATUS_COMPLETE = "COMPLETE"
STATUS_PARTIAL = "PARTIAL (recoverable: fix the cause, then re-run --execute)"
STATUS_FAILED = "FAILED"
STATUS_DRY_RUN = "DRY RUN"

# Lists reported in full to --report-file, and capped on the console.
_ID_LIST_KEYS = (
    "unavailableVideoIds",
    "unparseableVideoIds",
    "apiFailedVideoIds",
    "noMasterRowVideoIds",
    "masterInvalidVideoIds",
)
_CONSOLE_ID_SAMPLE = 20

# Printed first, as the plan; everything else is the run's own result (skipped on a dry run: it would be all zeros).
_PLAN_KEYS = (
    "mode",
    "videoMasterRecordsScanned",
    "manifestEntries",
    "inactiveEntriesIgnored",
    "entriesIncomplete",
    "toObserveOnYouTube",
    "manifestSyncFromMasterOnly",
    "masterHealFromManifest",
    "noMasterRow",
    "masterInvalidValue",
    "classifiedButDivergent",
    "youtubeBatchSize",
    "youtubeRequestsPlanned",
    "youtubeQuotaUnitsPlanned",
    "youtubeQuotaPercentOfDailyLimit",
    "masterWritesPlannedMax",
    "manifestShardWritesPlanned",
    "estimatedMinutesTypical",
    "estimatedMinutesConservative",
    "stopAt",
    "projectedFinishConservative",
    "marginMinutes",
    "deadlineVerdict",
)
_PLAN_ID_LIST_KEYS = ("noMasterRowVideoIds", "masterInvalidVideoIds")


class PreflightError(RuntimeError):
    """The manifest or Video Master cannot be read, so no run may start."""


def _safe_error(exc: BaseException) -> str:
    """Describe a failure for the console without leaking AWS identifiers or response text (class + AWS code only)."""
    cause = exc
    while cause is not None and not isinstance(cause, ClientError):
        cause = cause.__cause__ or cause.__context__
    if isinstance(cause, ClientError):
        code = cause.response.get("Error", {}).get("Code") or "unknown"
        return f"{type(exc).__name__}, AWS error code {code}"
    return type(exc).__name__


@dataclass
class ShardPlan:
    """What one manifest shard needs, derived from the manifest entries and the Video Master scan."""

    shard: int
    incomplete: int = 0
    needs_youtube: list[str] = field(default_factory=list)  # master ALSO incomplete: observe on YouTube
    master_ahead: dict[str, Classification] = field(default_factory=dict)  # master done: sync the manifest only
    manifest_ahead: dict[str, Classification] = field(default_factory=dict)  # manifest done: write Video Master
    no_master_row: list[str] = field(default_factory=list)
    master_invalid: list[str] = field(default_factory=list)
    divergent: int = 0
    inactive_ignored: int = 0
    entries: int = 0

    @property
    def request_count(self) -> int:
        """videos.list requests this shard needs (50 ids per request)."""
        return math.ceil(len(self.needs_youtube) / MAX_IDS_PER_REQUEST)

    @property
    def has_work(self) -> bool:
        """Whether anything is left to write for this shard."""
        return bool(self.needs_youtube or self.master_ahead or self.manifest_ahead)


def _master_state(items: list[dict[str, Any]]) -> tuple[dict[str, Classification], set[str]]:
    """videoId -> (contentType, liveStatus) from the scan, plus the ids carrying a value outside the valid sets."""
    state: dict[str, Classification] = {}
    invalid: set[str] = set()
    for item in items:
        video_id = item.get("videoId")
        if not isinstance(video_id, str):
            continue
        content_type, live_status = item.get("contentType"), item.get("liveStatus")
        if (content_type is not None and content_type not in VALID_CONTENT_TYPES) or (
            live_status is not None and live_status not in VALID_LIVE_STATUSES
        ):
            invalid.add(video_id)
        state[video_id] = (content_type, live_status)
    return state, invalid


def _plan_shard(shard: int, entries: list[ManifestEntry], master: dict[str, Classification], invalid: set[str]) -> ShardPlan:
    """Sort one shard's active entries into: nothing to do / observe on YouTube / sync from one side to the other."""
    plan = ShardPlan(shard=shard, entries=len(entries))
    for entry in sorted(entries, key=lambda e: e.video_id):
        if not entry.active:
            plan.inactive_ignored += 1
            continue
        manifest_value: Classification = (entry.content_type, entry.live_status)
        manifest_incomplete = is_classification_incomplete(*manifest_value)
        if manifest_incomplete:
            plan.incomplete += 1
        state = master.get(entry.video_id)
        if state is None:
            if manifest_incomplete:
                plan.no_master_row.append(entry.video_id)
            continue
        if entry.video_id in invalid:
            plan.master_invalid.append(entry.video_id)
            continue
        master_incomplete = is_classification_incomplete(*state)
        if manifest_incomplete and master_incomplete:
            plan.needs_youtube.append(entry.video_id)
        elif manifest_incomplete:
            plan.master_ahead[entry.video_id] = state
        elif master_incomplete:
            plan.manifest_ahead[entry.video_id] = manifest_value
        elif state != manifest_value:
            plan.divergent += 1  # both classified but different: reported, never overwritten
    return plan


def estimate_run(plans: list[ShardPlan], *, workers: int = MASTER_WRITE_WORKERS) -> dict[str, Any]:
    """Quota, write counts and wall-clock estimates for a plan, computed from the production batch size."""
    requests = sum(plan.request_count for plan in plans)
    master_writes = sum(len(plan.needs_youtube) + len(plan.manifest_ahead) for plan in plans)
    manifest_shards = sum(1 for plan in plans if plan.has_work)
    units = requests * VIDEOS_LIST_QUOTA_UNITS

    def seconds(per_request: float, per_write: float, per_shard: float, fixed: float) -> float:
        return fixed + requests * per_request + master_writes * per_write / max(1, workers) + manifest_shards * per_shard

    conservative = seconds(
        CONSERVATIVE_SECONDS_PER_YOUTUBE_REQUEST,
        CONSERVATIVE_SECONDS_PER_MASTER_WRITE,
        CONSERVATIVE_SECONDS_PER_MANIFEST_SHARD,
        CONSERVATIVE_FIXED_SECONDS,
    )
    typical = seconds(
        TYPICAL_SECONDS_PER_YOUTUBE_REQUEST,
        TYPICAL_SECONDS_PER_MASTER_WRITE,
        TYPICAL_SECONDS_PER_MANIFEST_SHARD,
        TYPICAL_FIXED_SECONDS,
    )
    return {
        "youtubeBatchSize": MAX_IDS_PER_REQUEST,
        "youtubeRequestsPlanned": requests,
        "youtubeQuotaUnitsPlanned": units,
        "youtubeQuotaPercentOfDailyLimit": round(100 * units / QUOTA_LIMIT_UNITS, 1),
        "masterWritesPlannedMax": master_writes,
        "manifestShardWritesPlanned": manifest_shards,
        "estimatedMinutesTypical": round(typical / 60, 1),
        "estimatedMinutesConservative": round(conservative / 60, 1),
        "_conservativeSeconds": conservative,
    }


def _build_plans(
    manifest_store: S3TrackingManifestStore, summary: dict[str, Any]
) -> list[ShardPlan]:
    """Read all manifest shards and the Video Master classification scan; raise PreflightError if either fails."""
    try:
        master, invalid = _master_state(scan_video_classification_items())
    except Exception as exc:
        raise PreflightError(f"Video Master scan failed ({_safe_error(exc)})") from exc
    summary["videoMasterRecordsScanned"] = len(master)

    plans: list[ShardPlan] = []
    for shard in range(HISTORY_SHARD_COUNT):
        try:
            entries, _version = manifest_store.read_shard_for_patch(shard)
        except Exception as exc:
            raise PreflightError(f"manifest shard {shard:02d} could not be read ({_safe_error(exc)})") from exc
        plans.append(_plan_shard(shard, entries, master, invalid))
    if sum(plan.entries for plan in plans) == 0:
        raise PreflightError("manifest has zero entries across all shards; refusing to continue")
    return plans


def _plan_summary(plans: list[ShardPlan]) -> dict[str, Any]:
    """The plan's counters, in the order they are printed."""
    return {
        "manifestEntries": sum(plan.entries for plan in plans),
        "inactiveEntriesIgnored": sum(plan.inactive_ignored for plan in plans),
        "entriesIncomplete": sum(plan.incomplete for plan in plans),
        "toObserveOnYouTube": sum(len(plan.needs_youtube) for plan in plans),
        "manifestSyncFromMasterOnly": sum(len(plan.master_ahead) for plan in plans),
        "masterHealFromManifest": sum(len(plan.manifest_ahead) for plan in plans),
        "noMasterRow": sum(len(plan.no_master_row) for plan in plans),
        "masterInvalidValue": sum(len(plan.master_invalid) for plan in plans),
        "classifiedButDivergent": sum(plan.divergent for plan in plans),
    }


def _stop_deadline_check(
    estimate: dict[str, Any], *, now: datetime, stop_at: datetime | None
) -> dict[str, Any]:
    """Projected conservative finish vs --stop-at: the go/no-go the operator (and --execute) acts on."""
    if stop_at is None:
        return {"deadlineVerdict": "no --stop-at given (not evaluated)"}
    finish = (now + timedelta(seconds=estimate["_conservativeSeconds"])).astimezone(stop_at.tzinfo)
    margin = stop_at - finish
    safe = margin >= SAFETY_MARGIN
    return {
        "stopAt": stop_at.isoformat(),
        "projectedFinishConservative": finish.isoformat(timespec="seconds"),
        "marginMinutes": round(margin.total_seconds() / 60, 1),
        "deadlineVerdict": "SAFE" if safe else "NOT SAFE: do not start (it would not finish with the required margin)",
        "_deadlineSafe": safe,
    }


class _Run:
    """Mutable state shared by one execution: dependencies, the deadline, counters and collected id lists."""

    def __init__(
        self,
        *,
        summary: dict[str, Any],
        manifest_store: S3TrackingManifestStore,
        youtube_factory: Callable[[], Any],
        get_statistics: Callable[[Any, list[str]], tuple[list[dict], dict[str, str]]],
        write_classification: Callable[[str, str, str | None], bool],
        read_master_video: Callable[[str], Any],
        stop_at: datetime | None,
        now_fn: Callable[[], datetime],
        workers: int,
    ) -> None:
        """Hold the injected dependencies; nothing here touches AWS or YouTube."""
        self.summary = summary
        self.manifest_store = manifest_store
        self.youtube_factory = youtube_factory
        self.get_statistics = get_statistics
        self.write_classification = write_classification
        self.read_master_video = read_master_video
        self.stop_at = stop_at
        self.now_fn = now_fn
        self.workers = workers
        self.youtube: Any = None
        self.stop_requested = False

    def time_is_up(self) -> bool:
        """Whether --stop-at is close enough that no new YouTube batch may start."""
        return self.stop_at is not None and self.now_fn() + SHARD_FINALIZE_RESERVE >= self.stop_at


def _classify_skip(reason: str) -> str:
    """Map a get_video_statistics skip reason to unavailable / apiFailed / unparseable (the client's own constants)."""
    if reason == SKIP_REASON_NO_DATA:
        return "unavailableVideoIds"
    if reason.startswith(SKIP_REASON_API_ERROR_PREFIX):
        return "apiFailedVideoIds"
    return "unparseableVideoIds"


def _observed_classification(video: dict[str, Any]) -> Classification | None:
    """The (contentType, liveStatus) pair for one parsed video, or None if it is not a valid complete classification.

    Mirrors history_worker._build_scheduler_updates: a known contentType owns BOTH fields, so an upload carries
    liveStatus None and a livestream must carry a known liveStatus.
    """
    content_type, live_status = video.get("contentType"), video.get("liveStatus")
    if content_type == "upload" and live_status is None:
        return ("upload", None)
    if content_type == "live" and live_status in VALID_LIVE_STATUSES:
        return ("live", live_status)
    return None


def _fetch_shard(run: _Run, plan: ShardPlan) -> dict[str, Classification]:
    """Observe this shard's still-unclassified videos on YouTube, 50 ids per request; returns what was classified."""
    summary = run.summary
    observed: dict[str, Classification] = {}
    batches = [
        plan.needs_youtube[start : start + MAX_IDS_PER_REQUEST]
        for start in range(0, len(plan.needs_youtube), MAX_IDS_PER_REQUEST)
    ]
    consecutive_failures = 0
    for index, batch in enumerate(batches):
        if run.time_is_up():
            run.stop_requested = True
            summary["deferredNotAttempted"] += sum(len(rest) for rest in batches[index:])
            summary["stoppedByDeadline"] = True
            break
        if run.youtube is None:
            run.youtube = run.youtube_factory()
        summary["youtubeRequests"] += 1
        try:
            videos, skipped = run.get_statistics(run.youtube, batch)
        except QuotaExhaustedError:
            summary["abortedReason"] = "YouTube quota exhausted"
            run.stop_requested = True
            summary["deferredNotAttempted"] += sum(len(rest) for rest in batches[index:])
            break
        except Exception as exc:  # noqa: BLE001 - one bad batch must not lose the rest of the shard
            consecutive_failures += 1
            summary["youtubeBatchErrors"] += 1
            summary["apiFailedVideoIds"].extend(batch)
            print(f"Error: YouTube batch failed unexpectedly ({_safe_error(exc)}); {len(batch)} id(s) left for a re-run")
            if consecutive_failures >= _MAX_CONSECUTIVE_BATCH_FAILURES:
                summary["abortedReason"] = f"{consecutive_failures} consecutive YouTube batch failures"
                run.stop_requested = True
                break
            continue
        consecutive_failures = 0
        requested = set(batch)
        for video in videos:
            video_id = video.get("videoId")
            if video_id not in requested:
                continue
            classification = _observed_classification(video)
            if classification is None:
                summary["unparseableVideoIds"].append(video_id)
            else:
                observed[video_id] = classification
        for video_id, reason in skipped.items():
            summary[_classify_skip(reason)].append(video_id)
    return observed


def _write_master(run: _Run, writes: dict[str, Classification]) -> dict[str, str]:
    """Conditionally write contentType/liveStatus to Video Master; returns videoId -> written/rejected/error."""
    summary = run.summary
    outcome: dict[str, str] = {}
    items = sorted(writes.items())

    def _one(item: tuple[str, Classification]) -> tuple[str, str]:
        """One conditional UpdateItem; never raises (an error becomes the "error" outcome)."""
        video_id, (content_type, live_status) = item
        try:
            return video_id, "written" if run.write_classification(video_id, content_type, live_status) else "rejected"
        except Exception as exc:  # noqa: BLE001 - counted, never printed raw
            print(f"Error: Video Master write failed for {video_id!r} ({_safe_error(exc)})")
            return video_id, "error"

    with ThreadPoolExecutor(max_workers=max(1, run.workers)) as pool:
        for start in range(0, len(items), _WRITE_CHUNK_SIZE):
            chunk = items[start : start + _WRITE_CHUNK_SIZE]
            results = list(pool.map(_one, chunk))
            outcome.update(results)
            failures = sum(1 for _video_id, status in results if status == "error")
            if failures == len(chunk) and len(chunk) >= _SYSTEMIC_FAILURE_MIN_CHUNK:
                summary["abortedReason"] = f"a full chunk of {len(chunk)} Video Master writes failed"
                run.stop_requested = True
                break
    summary["deferredNotAttempted"] += len(items) - len(outcome)
    summary["masterWritten"] += sum(1 for status in outcome.values() if status == "written")
    summary["masterRejectedAlreadyClassified"] += sum(1 for status in outcome.values() if status == "rejected")
    summary["masterWriteErrors"] += sum(1 for status in outcome.values() if status == "error")
    return outcome


def _manifest_targets(
    run: _Run, plan: ShardPlan, writes: dict[str, Classification], outcome: dict[str, str]
) -> dict[str, Classification]:
    """Authoritative values for the manifest patch: Video Master's own result for every video, never a guess."""
    targets: dict[str, Classification] = dict(plan.master_ahead)
    for video_id, status in outcome.items():
        if status == "written":
            targets[video_id] = writes[video_id]
        elif status == "rejected":
            # Another writer classified it first (or the row is gone): the manifest must follow Video Master.
            try:
                video = run.read_master_video(video_id)
            except Exception as exc:  # noqa: BLE001
                run.summary["masterReadErrors"] += 1
                print(f"Error: Video Master read failed for {video_id!r} ({_safe_error(exc)})")
                continue
            if video is None:
                run.summary["masterRowVanished"] += 1
            elif not is_classification_incomplete(video.content_type, video.live_status):
                targets[video_id] = (video.content_type, video.live_status)
    return targets


def _patch_manifest_shard(run: _Run, plan: ShardPlan, targets: dict[str, Classification]) -> None:
    """Patch ONLY contentType/liveStatus of still-incomplete entries in this shard, then verify by re-reading it."""
    summary = run.summary
    # manifest_ahead entries already hold their classification in the manifest; only Video Master was behind.
    todo = {video_id: value for video_id, value in targets.items() if video_id not in plan.manifest_ahead}
    if not todo:
        return
    patched_count = 0

    def _apply(current: list[ManifestEntry]) -> list[ManifestEntry]:
        """Recomputed fresh on every patch_shard attempt, from the shard's current state."""
        nonlocal patched_count
        result: list[ManifestEntry] = []
        patched_count = 0
        for entry in current:
            target = todo.get(entry.video_id)
            if target is not None and is_classification_incomplete(entry.content_type, entry.live_status):
                entry = replace(entry, content_type=target[0], live_status=target[1])
                patched_count += 1
            result.append(entry)
        return result

    try:
        patch_shard(run.manifest_store, plan.shard, _apply)
    except Exception as exc:  # noqa: BLE001
        summary["manifestShardErrors"] += 1
        summary["manifestFailedShards"].append(plan.shard)
        print(f"Error: manifest shard {plan.shard:02d} patch failed ({_safe_error(exc)})")
        return
    summary["manifestEntriesPatched"] += patched_count
    summary["manifestShardsPatched"] += 1
    try:
        verified, _version = run.manifest_store.read_shard_for_patch(plan.shard)
    except Exception as exc:  # noqa: BLE001
        summary["manifestShardErrors"] += 1
        summary["manifestFailedShards"].append(plan.shard)
        print(f"Error: manifest shard {plan.shard:02d} verification read failed ({_safe_error(exc)})")
        return
    summary["manifestEntriesRemaining"] += sum(
        1
        for entry in verified
        if entry.video_id in todo and is_classification_incomplete(entry.content_type, entry.live_status)
    )


def _execute(run: _Run, plans: list[ShardPlan]) -> None:
    """Shard by shard: observe -> Video Master -> manifest. Stops early on abort, quota exhaustion or the deadline."""
    summary = run.summary
    for plan in plans:
        if not plan.has_work:
            continue
        if run.stop_requested or run.time_is_up():
            if not run.stop_requested:
                summary["stoppedByDeadline"] = True
            run.stop_requested = True
            summary["deferredNotAttempted"] += len(plan.needs_youtube) + len(plan.master_ahead) + len(plan.manifest_ahead)
            continue
        started = run.now_fn()
        observed = _fetch_shard(run, plan)
        summary["observedClassified"] += len(observed)
        writes: dict[str, Classification] = {**plan.manifest_ahead, **observed}
        outcome = _write_master(run, writes) if writes else {}
        targets = _manifest_targets(run, plan, writes, outcome)
        _patch_manifest_shard(run, plan, targets)
        elapsed = (run.now_fn() - started).total_seconds()
        print(
            f"shard {plan.shard:02d}: observed={len(observed)}/{len(plan.needs_youtube)} "
            f"masterWritten={sum(1 for s in outcome.values() if s == 'written')} "
            f"manifestTargets={len(targets)} elapsed={elapsed:.0f}s"
        )


def _final_status(summary: dict[str, Any], *, execute: bool) -> str:
    """COMPLETE / PARTIAL / FAILED (or DRY RUN) from the run's own accounting.

    Unavailable/unparseable videos are an expected, separately reported outcome, not a failure; a failed request,
    write or patch, anything deferred, or a verification mismatch is PARTIAL (a re-run finishes it).
    """
    if summary.get("abortedReason"):
        return STATUS_FAILED
    if not execute:
        return STATUS_DRY_RUN
    if (
        summary["apiFailedVideoIds"]
        or summary["youtubeBatchErrors"]
        or summary["masterWriteErrors"]
        or summary["masterReadErrors"]
        or summary["masterRowVanished"]
        or summary["manifestShardErrors"]
        or summary["manifestEntriesRemaining"]
        or summary["deferredNotAttempted"]
    ):
        return STATUS_PARTIAL
    return STATUS_COMPLETE


def _new_summary() -> dict[str, Any]:
    """Zeroed counters/lists for one run."""
    summary: dict[str, Any] = {
        "videoMasterRecordsScanned": 0,
        "youtubeRequests": 0,
        "youtubeBatchErrors": 0,
        "observedClassified": 0,
        "masterWritten": 0,
        "masterRejectedAlreadyClassified": 0,
        "masterWriteErrors": 0,
        "masterReadErrors": 0,
        "masterRowVanished": 0,
        "manifestEntriesPatched": 0,
        "manifestShardsPatched": 0,
        "manifestShardErrors": 0,
        "manifestFailedShards": [],
        "manifestEntriesRemaining": 0,
        "deferredNotAttempted": 0,
        "stoppedByDeadline": False,
    }
    for key in _ID_LIST_KEYS:
        summary[key] = []
    return summary


def backfill_classification(
    *,
    execute: bool,
    manifest_store: S3TrackingManifestStore,
    youtube_factory: Callable[[], Any] | None = None,
    stop_at: datetime | None = None,
    now_fn: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    get_statistics: Callable[[Any, list[str]], tuple[list[dict], dict[str, str]]] = get_video_statistics,
    write_classification: Callable[[str, str, str | None], bool] = set_video_classification,
    read_master_video: Callable[[str], Any] = get_video,
    workers: int = MASTER_WRITE_WORKERS,
) -> dict[str, Any]:
    """Plan (always) and, only with execute=True, perform the one-time classification backfill; returns the summary.

    The plan reads the 16 manifest shards and scans Video Master; a dry run stops there (no YouTube client, no API
    key, no write). execute=True first applies the --stop-at guard to the conservative estimate and refuses to start
    (abortedReason + guardRefused, zero writes) if it cannot finish safely. Always returns the summary, including
    when aborted (see "status"/"abortedReason").
    """
    summary = _new_summary()
    summary["mode"] = "EXECUTE" if execute else "DRY RUN"
    try:
        plans = _build_plans(manifest_store, summary)
    except PreflightError as exc:
        print(f"Preflight failed: {exc}")
        summary.update({"preflightFailed": True, "abortedReason": f"preflight failed: {exc}"})
        summary["status"] = _final_status(summary, execute=execute)
        return summary

    summary.update(_plan_summary(plans))
    estimate = estimate_run(plans, workers=workers)
    deadline = _stop_deadline_check(estimate, now=now_fn(), stop_at=stop_at)
    summary.update({key: value for key, value in estimate.items() if not key.startswith("_")})
    summary.update({key: value for key, value in deadline.items() if not key.startswith("_")})
    summary["noMasterRowVideoIds"] = sorted(v for plan in plans for v in plan.no_master_row)
    summary["masterInvalidVideoIds"] = sorted(v for plan in plans for v in plan.master_invalid)

    if execute and (stop_at is None or not deadline["_deadlineSafe"]):
        summary.update({"guardRefused": True, "abortedReason": "the projected run would not finish before --stop-at"})
        summary["status"] = _final_status(summary, execute=execute)
        return summary

    if execute:
        run = _Run(
            summary=summary,
            manifest_store=manifest_store,
            youtube_factory=youtube_factory or _unconfigured_youtube,
            get_statistics=get_statistics,
            write_classification=write_classification,
            read_master_video=read_master_video,
            stop_at=stop_at,
            now_fn=now_fn,
            workers=workers,
        )
        if summary["toObserveOnYouTube"]:
            # Built (and the API key resolved) BEFORE the first write, so a missing key aborts with zero writes.
            try:
                run.youtube = run.youtube_factory()
            except Exception as exc:  # noqa: BLE001 - class name only: never print anything key-related
                print(f"Preflight failed: the YouTube client could not be built ({_safe_error(exc)}); nothing was written.")
                summary.update({"preflightFailed": True, "abortedReason": "preflight failed: YouTube client unavailable"})
                summary["status"] = _final_status(summary, execute=execute)
                return summary
        try:
            _execute(run, plans)
        except KeyboardInterrupt:
            print("\nInterrupted (Ctrl-C): stopping; progress so far is in the summary below.")
            summary["abortedReason"] = "interrupted (Ctrl-C)"
        summary["unavailableVideoIds"] = sorted(set(summary["unavailableVideoIds"]))
        summary["unparseableVideoIds"] = sorted(set(summary["unparseableVideoIds"]))
        summary["apiFailedVideoIds"] = sorted(set(summary["apiFailedVideoIds"]))
    summary["status"] = _final_status(summary, execute=execute)
    return summary


def _unconfigured_youtube() -> Any:
    """Fail loudly if execute is reached without a YouTube client factory (a programming error, never silent)."""
    raise RuntimeError("no YouTube client factory was provided")


def _real_youtube_factory() -> Any:
    """Build the production YouTube client from the same key source the collector uses (never printed)."""
    from collection.youtube_client import build_youtube_client
    from ops.config import get_api_key

    return build_youtube_client(get_api_key())


def _exit_code(summary: dict[str, Any]) -> int:
    """0 for a clean dry run or COMPLETE; 2 when a guard refused to start; 1 otherwise."""
    if summary.get("guardRefused") or (summary.get("preflightFailed") and summary["mode"] == "EXECUTE"):
        return 2
    status = summary["status"]
    return 0 if status in (STATUS_DRY_RUN, STATUS_COMPLETE) else 1


def _parse_stop_at(raw: str | None) -> datetime | None:
    """Parse --stop-at as a timezone-aware ISO-8601 timestamp (e.g. 2026-10-02T17:30:00+09:00)."""
    if raw is None:
        return None
    parsed = datetime.fromisoformat(raw)
    if parsed.tzinfo is None:
        raise ValueError("--stop-at must include a UTC offset, e.g. 2026-10-02T17:30:00+09:00")
    return parsed


def _print_item(key: str, value: Any) -> None:
    """Print one counter; id lists are capped on the console (the full lists go to --report-file)."""
    if key in _ID_LIST_KEYS:
        sample = value[:_CONSOLE_ID_SAMPLE]
        more = f" ... (+{len(value) - len(sample)} more)" if len(value) > len(sample) else ""
        print(f"{key}: {len(value)}" + (f" {sample}{more}" if value else ""))
    else:
        print(f"{key}: {value}")


def _print_summary(summary: dict[str, Any]) -> None:
    """Print the plan first, then (unless this was a dry run) the run's result counters."""
    print("--- plan ---")
    for key in _PLAN_KEYS:
        if key in summary:
            _print_item(key, summary[key])
    for key in _PLAN_ID_LIST_KEYS:
        _print_item(key, summary[key])
    if summary.get("mode") == "DRY RUN" and not summary.get("abortedReason"):
        return
    print("\n--- result ---")
    for key, value in summary.items():
        if key not in _PLAN_KEYS and key not in _PLAN_ID_LIST_KEYS and key != "status":
            _print_item(key, value)


def main(argv: list[str] | None = None) -> int:
    """CLI entry point: dry run by default; --execute --yes --stop-at writes Video Master and the manifest."""
    # allow_abbrev=False: production-write flags (--execute, --yes, ...) must be typed exactly.
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter, allow_abbrev=False
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Actually classify: write Video Master and patch the manifest. Without this flag, reports only (dry run).",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Required together with --execute: confirm writing to the targets printed at the top of the run.",
    )
    parser.add_argument(
        "--stop-at",
        help="ISO-8601 deadline with a UTC offset (e.g. 2026-10-02T17:30:00+09:00). Required with --execute; "
        "a dry run uses it to print the go/no-go verdict.",
    )
    parser.add_argument("--report-file", help="Write the full id lists (unavailable, unparseable, ...) to this JSON file.")
    args = parser.parse_args(argv)

    bucket_name = os.environ.get("YOBI_HISTORY_BUCKET")
    mode = "EXECUTE (writes)" if args.execute else "DRY RUN (no writes)"
    print(f"=== Video classification backfill -- {mode} ===\n")
    print("Targets (non-secret names only):")
    print(f"  DynamoDB table : {VIDEO_MASTER_TABLE}")
    print(f"  Manifest bucket: {bucket_name or 'NOT CONFIGURED'}")
    print(f"  Mode           : {mode}\n")
    try:
        stop_at = _parse_stop_at(args.stop_at)
    except ValueError as exc:
        print(f"Invalid --stop-at: {exc}")
        return 2
    if not bucket_name:
        print("YOBI_HISTORY_BUCKET is not configured (explicit, no default for this script); refusing to continue.")
        return 2
    if args.execute and not args.yes:
        print("Refusing to write without --yes. Re-run with --yes to write to the targets above (nothing was written).")
        return 2
    if args.execute and stop_at is None:
        print("--execute requires --stop-at (the time by which the run must be finished); nothing was written.")
        return 2
    if args.execute and stop_at <= datetime.now(timezone.utc):
        print("--stop-at is already in the past; nothing was written.")
        return 2

    summary = backfill_classification(
        execute=args.execute,
        manifest_store=S3TrackingManifestStore(bucket_name),
        youtube_factory=_real_youtube_factory,
        stop_at=stop_at,
    )
    _print_summary(summary)
    if args.report_file:
        report = {key: summary[key] for key in _ID_LIST_KEYS}
        report["status"] = summary["status"]
        Path(args.report_file).write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
        print(f"\nFull id lists written to {args.report_file}")
    print(f"\nRESULT: {summary['status']}")
    return _exit_code(summary)


if __name__ == "__main__":
    sys.exit(main())
