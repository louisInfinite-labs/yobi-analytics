"""Livestream completion lifecycle: a centralized, periodic Holodex refresh that GET /live-streams reads from
instead of calling Holodex itself, plus completion detection for a stream that drops out of Holodex's live/upcoming
response.

Runs as its own Lambda (yobi-analytics-livestream-lifecycle) on a 5-minute EventBridge schedule
(terraform/eventbridge.tf), with reserved_concurrent_executions=1 (terraform/lambda.tf) so two cycles can never
overlap -- this job's own read-modify-write of the pending-candidates set below is not otherwise safe under
concurrent execution. Each run (refresh_snapshot):

  1. Fetches the current live/upcoming list the same way api.read_api.get_live_streams always has
     (api.read_api.fetch_live_streams_from_holodex is the single source of truth for "what does Holodex say is
     live/upcoming right now" -- reused here, never duplicated), with a bounded retry around the Holodex call
     itself.
  2. Persists it as a shared snapshot (stores.remote_config_store, the same system-wide-singleton storage layer
     notifications.notification_dispatcher already uses for its own streamSchedule -- a different key, so this
     never touches that one) so api.read_api.get_live_streams can read it instead of hitting Holodex per request.
  3. Diffs this run's active videoIds against the previous run's: a video that was live/upcoming last run and is
     not anymore joins a DURABLE pending-candidates set, persisted alongside the snapshot -- Holodex dropping a
     videoId could mean it ended, or could be a transient Holodex gap, so this is never trusted by itself. A
     candidate reappearing in a later Holodex response (clearly not completed) is dropped from the set immediately.
  4. Verifies every pending candidate (new and carried over from earlier cycles) with one batched YouTube
     videos.list call (collection.youtube_client.get_video_statistics, itself chunked at its own
     MAX_IDS_PER_REQUEST=50 and already bounded-retry/quota-aware) and only then marks a confirmed one completed in
     Video Master -- an idempotent, targeted write (stores.dynamodb_store.set_video_live_status) that never
     fabricates a completion Holodex-only evidence could get wrong. A candidate YouTube still reports as
     live/upcoming/not-finalized, or one a transient YouTube failure prevented verifying this cycle, stays pending
     and is retried next cycle -- up to _MAX_PENDING_ATTEMPTS, after which it is dropped (never force-completed
     without YouTube's own confirmation; Video Master simply keeps its last known live_status, same as if this
     feature had never observed it disappearing at all).

A Holodex failure (after its own bounded retries) or a missing API key never wipes the persisted snapshot or
pending set -- both stay exactly as they were and verification is skipped for that run, matching the dispatcher's
own "availability first" precedent for this same external dependency: an unknown current state must never be
diffed against the previous one, since every currently-live stream would otherwise look like a completion
candidate.

AWS-aware verification (2026-10-13) found one real limitation worth recording here: the completed-videoId write
this module makes to Video Master (set_video_live_status) is visible to any DIRECT VideoMaster read immediately.
It is NOT visible to Home's "Latest Live" archive shelf (GET /creators/{creatorId}/videos/recent,
api.read_api.get_recent_creator_videos) that soon -- that endpoint reads only the once-daily S3 video-ranking
result (analytics/ranking_reducer.py), never VideoMaster directly, so a completion this job records still waits for
the next daily ranking_reducer run to reach that specific shelf. This is a pre-existing property of the ranking/S3
pipeline, unrelated to and unchanged by this feature (before this job existed, live_status's own transition to
"completed" depended on the next scheduled YouTube statistics observation, which could lag by days under Adaptive
Tracking Frequency -- this job's within-the-cycle write is strictly sooner), and reworking that pipeline to read
VideoMaster live is out of this feature's scope.
"""

from __future__ import annotations

import random
import time
from datetime import datetime, timezone
from typing import Any

from notifications.live_reminder import SYSTEM_CLIENT_ID
from stores.remote_config_store import get_remote_config, put_remote_config

# A distinct key from notifications.live_reminder.STREAM_SCHEDULE_KEY: that one backs the live-reminder dispatcher's
# own 15-minute-gated schedule and must not be touched by this feature; this is its own independent record.
LIVE_SNAPSHOT_KEY = "liveStreamSnapshot"

# Bounded retry around the one Holodex call this job makes per run -- a single transient failure must not skip a
# whole 5-minute cycle (and, worse, spuriously treat every currently-live stream as a completion candidate).
_HOLODEX_MAX_ATTEMPTS = 3
_HOLODEX_BACKOFF_BASE_SECONDS = 1.0
_HOLODEX_BACKOFF_CAP_SECONDS = 8.0

# A pending completion candidate is re-verified once per 5-minute cycle (the job's own cadence is the retry
# interval -- there is no separate, faster polling loop); 12 attempts is ~1 hour of retrying before giving up.
# Terminal behavior on giving up: the candidate is simply dropped from the pending set, never force-completed.
_MAX_PENDING_ATTEMPTS = 12


def _holodex_backoff_seconds(attempt: int) -> float:
    """Capped exponential backoff with jitter -- same shape as collection.youtube_client's own retry backoff."""
    return min(_HOLODEX_BACKOFF_CAP_SECONDS, _HOLODEX_BACKOFF_BASE_SECONDS * (2**attempt)) * (0.5 + random.random() / 2)


def _fetch_live_streams_with_bounded_retry() -> list[dict[str, Any]]:
    """api.read_api.fetch_live_streams_from_holodex, retried up to _HOLODEX_MAX_ATTEMPTS times on a transient
    HolodexAPIError. A MissingHolodexApiKeyError (or anything else) is never retried -- retrying cannot fix it.

    api.read_api is imported locally, not at module load: that module imports read_snapshot (below) for its own
    GET /live-streams fallback, so a local import on this side avoids turning the pair into a circular import.
    """
    from api.holodex_client import HolodexAPIError
    from api.read_api import fetch_live_streams_from_holodex

    last_error: HolodexAPIError | None = None
    for attempt in range(_HOLODEX_MAX_ATTEMPTS):
        try:
            return fetch_live_streams_from_holodex()
        except HolodexAPIError as exc:
            last_error = exc
            if attempt < _HOLODEX_MAX_ATTEMPTS - 1:
                time.sleep(_holodex_backoff_seconds(attempt))
    assert last_error is not None  # the loop above always either returns or sets this before exiting
    raise last_error


def _read_snapshot_record() -> dict[str, Any] | None:
    """The persisted shared record's `value` ({streams, refreshedAt, pendingCandidates}), or None if nothing has
    ever been persisted."""
    record = get_remote_config(SYSTEM_CLIENT_ID, LIVE_SNAPSHOT_KEY)
    return record["value"] if record is not None else None


def read_snapshot() -> list[dict[str, Any]] | None:
    """The persisted shared snapshot's streams, or None if nothing has ever been persisted.

    api.read_api.get_live_streams calls this (only when YOBI_STORAGE_BACKEND=="dynamodb") and falls back to its own
    direct Holodex fetch on None -- a never-refreshed snapshot (fresh deploy, local/test env) must never be
    confused with a genuine "nobody is live" result.
    """
    value = _read_snapshot_record()
    return value["streams"] if value is not None else None


def _bump(pending_state: dict[str, Any]) -> dict[str, Any]:
    """One more failed-to-confirm attempt for an existing pending candidate, its firstSeenMissingAt unchanged."""
    return {"firstSeenMissingAt": pending_state["firstSeenMissingAt"], "attempts": pending_state["attempts"] + 1}


def _verify_and_mark_completed(pending: dict[str, dict[str, Any]]) -> tuple[list[str], dict[str, dict[str, Any]]]:
    """Ask YouTube (one batched videos.list call -- collection.youtube_client.get_video_statistics chunks this at
    its own MAX_IDS_PER_REQUEST=50 internally, so e.g. 120 pending candidates costs ~3 requests here, not 120)
    which pending candidates have actually ended, and persist only those.

    Returns (videoIds confirmed+persisted as completed this cycle, the next cycle's pending dict). Every candidate
    not confirmed this cycle -- YouTube still reports it live/upcoming/not-finalized, the lookup failed (missing
    key, quota wall, a malformed/missing item), or the completed write itself failed -- is kept for the next cycle,
    up to _MAX_PENDING_ATTEMPTS; past that it is dropped (see module docstring's terminal-behavior note).
    """
    if not pending:
        return [], {}
    from collection.youtube_client import QuotaExhaustedError, build_youtube_client, get_video_statistics
    from ops.config import MissingAPIKeyError, get_api_key
    from stores.dynamodb_store import set_video_live_status

    candidate_ids = sorted(pending)
    try:
        youtube = build_youtube_client(get_api_key())
        results, _skip_reasons = get_video_statistics(youtube, candidate_ids)
    except MissingAPIKeyError as exc:
        print(f"Warning: cannot verify {len(candidate_ids)} completion candidate(s), no YouTube API key configured: {exc}")
        results = []
    except QuotaExhaustedError as exc:
        print(
            f"Warning: YouTube quota exhausted verifying completion candidates; "
            f"{len(exc.partial_results)} of {len(candidate_ids)} observed before the wall"
        )
        results = exc.partial_results

    by_video_id = {result["videoId"]: result for result in results}
    confirmed: list[str] = []
    next_pending: dict[str, dict[str, Any]] = {}
    for video_id, pending_state in pending.items():
        result = by_video_id.get(video_id)
        if result is not None and result.get("contentType") == "live" and result.get("liveStatus") == "completed":
            try:
                if set_video_live_status(video_id, "completed"):
                    confirmed.append(video_id)
                    continue
            except Exception as exc:  # noqa: BLE001 -- one failed write must not stop the rest of the batch
                print(f"Warning: could not persist completion for {video_id!r} ({type(exc).__name__}): {exc}")
        # Not resolved this cycle -- still live/upcoming per YouTube, the lookup didn't cover it, or the write
        # failed. Stays retryable up to _MAX_PENDING_ATTEMPTS.
        bumped = _bump(pending_state)
        if bumped["attempts"] < _MAX_PENDING_ATTEMPTS:
            next_pending[video_id] = bumped
        else:
            print(f"Warning: giving up on completion candidate {video_id!r} after {bumped['attempts']} attempts without YouTube confirmation")
    return confirmed, next_pending


def refresh_snapshot(*, now: datetime | None = None) -> dict[str, Any]:
    """One full refresh cycle: fetch, persist, diff into the durable pending-candidates set, verify+mark
    completions. Returns a summary for logging/tests.

    Never raises on a Holodex failure -- the last good snapshot AND pending set are left untouched and candidate
    verification is skipped for this cycle, rather than risk diffing an unknown current state against the previous
    one (every currently-live stream would otherwise look like a completion candidate).
    """
    moment = now or datetime.now(timezone.utc)
    previous = _read_snapshot_record() or {}
    previous_streams = previous.get("streams", [])
    previous_pending: dict[str, dict[str, Any]] = previous.get("pendingCandidates", {})
    previous_ids = {stream["videoId"] for stream in previous_streams}

    try:
        streams = _fetch_live_streams_with_bounded_retry()
    except Exception as exc:  # noqa: BLE001 -- HolodexAPIError/MissingHolodexApiKeyError/anything else: availability
        # first, keep the last good snapshot and pending set rather than overwrite them with an unknown observation.
        print(f"Warning: livestream snapshot refresh failed after retries ({type(exc).__name__}): {exc}; keeping the last persisted snapshot")
        return {
            "refreshed": False,
            "streamCount": len(previous_streams),
            "completionCandidates": sorted(previous_pending),
            "confirmedCompleted": [],
        }

    current_ids = {stream["videoId"] for stream in streams}
    pending = {video_id: state for video_id, state in previous_pending.items() if video_id not in current_ids}
    for video_id in previous_ids - current_ids:
        pending.setdefault(video_id, {"firstSeenMissingAt": moment.isoformat(), "attempts": 0})

    candidates = sorted(pending)
    try:
        confirmed, next_pending = _verify_and_mark_completed(pending)
    except Exception as exc:  # noqa: BLE001 -- an unexpected verification-side failure (beyond the
        # MissingAPIKeyError/QuotaExhaustedError _verify_and_mark_completed already handles internally) must never
        # block this cycle's Holodex snapshot from being persisted. Every pending candidate carries over UNCHANGED
        # (not bumped -- this attempt never actually ran for any of them) for the next cycle to retry.
        print(f"Warning: completion-candidate verification failed unexpectedly ({type(exc).__name__}): {exc}; snapshot still refreshed, pending candidates carried over unchanged")
        confirmed, next_pending = [], pending

    put_remote_config(
        {
            "clientId": SYSTEM_CLIENT_ID,
            "key": LIVE_SNAPSHOT_KEY,
            "value": {"streams": streams, "refreshedAt": moment.isoformat(), "pendingCandidates": next_pending},
            "updatedAt": moment.isoformat(),
        }
    )
    return {"refreshed": True, "streamCount": len(streams), "completionCandidates": candidates, "confirmedCompleted": confirmed}


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """EventBridge Scheduler entry point (yobi-analytics-livestream-lifecycle, rate(5 minutes))."""
    return refresh_snapshot()
