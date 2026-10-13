"""Livestream completion lifecycle: a centralized, periodic Holodex refresh that GET /live-streams reads from
instead of calling Holodex itself, plus completion detection for a stream that drops out of Holodex's live/upcoming
response.

Runs as its own Lambda (yobi-analytics-livestream-lifecycle) on a 5-minute EventBridge schedule
(terraform/eventbridge.tf). Each run (refresh_snapshot):

  1. Fetches the current live/upcoming list the same way api.read_api.get_live_streams always has
     (api.read_api.fetch_live_streams_from_holodex is the single source of truth for "what does Holodex say is
     live/upcoming right now" -- reused here, never duplicated), with a bounded retry around the Holodex call
     itself.
  2. Persists it as a shared snapshot (stores.remote_config_store, the same system-wide-singleton storage layer
     notifications.notification_dispatcher already uses for its own streamSchedule -- a different key, so this
     never touches that one) so api.read_api.get_live_streams can read it instead of hitting Holodex per request.
  3. Diffs this run's active videoIds against the previous run's: a video that was live/upcoming last run and is
     not anymore is a completion CANDIDATE -- Holodex dropping it could mean it ended, or could be a transient
     Holodex gap, so this is never trusted by itself.
  4. Verifies each candidate with one batched YouTube videos.list call
     (collection.youtube_client.get_video_statistics, already bounded-retry and quota-aware) and only then marks it
     completed in Video Master -- an idempotent, targeted write (stores.dynamodb_store.set_video_live_status) that
     never fabricates a completion Holodex-only evidence could get wrong.

A Holodex failure (after its own bounded retries) or a missing API key never wipes the persisted snapshot -- the
last good snapshot stays in place and completion detection is skipped for that run, matching the dispatcher's own
"availability first" precedent for this same external dependency: an unknown current state must never be diffed
against the previous one, since every currently-live stream would otherwise look like a completion candidate.
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


def read_snapshot() -> list[dict[str, Any]] | None:
    """The persisted shared snapshot's streams, or None if nothing has ever been persisted.

    api.read_api.get_live_streams calls this (only when YOBI_STORAGE_BACKEND=="dynamodb") and falls back to its own
    direct Holodex fetch on None -- a never-refreshed snapshot (fresh deploy, local/test env) must never be
    confused with a genuine "nobody is live" result.
    """
    record = get_remote_config(SYSTEM_CLIENT_ID, LIVE_SNAPSHOT_KEY)
    if record is None:
        return None
    return record["value"]["streams"]


def _verify_and_mark_completed(candidate_ids: list[str]) -> list[str]:
    """Ask YouTube (one batched videos.list call) which completion candidates actually ended, and persist only
    those -- Holodex dropping a videoId is never trusted by itself (see module docstring). Returns the videoIds
    actually confirmed and persisted as completed.
    """
    if not candidate_ids:
        return []
    from collection.youtube_client import QuotaExhaustedError, build_youtube_client, get_video_statistics
    from ops.config import MissingAPIKeyError, get_api_key
    from stores.dynamodb_store import set_video_live_status

    try:
        youtube = build_youtube_client(get_api_key())
    except MissingAPIKeyError as exc:
        print(f"Warning: cannot verify {len(candidate_ids)} completion candidate(s), no YouTube API key configured: {exc}")
        return []

    try:
        results, _skip_reasons = get_video_statistics(youtube, candidate_ids)
    except QuotaExhaustedError as exc:
        print(
            f"Warning: YouTube quota exhausted verifying completion candidates; "
            f"{len(exc.partial_results)} of {len(candidate_ids)} observed before the wall"
        )
        results = exc.partial_results

    confirmed: list[str] = []
    for result in results:
        if result.get("contentType") == "live" and result.get("liveStatus") == "completed":
            video_id = result["videoId"]
            try:
                if set_video_live_status(video_id, "completed"):
                    confirmed.append(video_id)
            except Exception as exc:  # noqa: BLE001 -- one failed write must not stop the rest of the batch; the
                # videoId stays a completion candidate as long as Holodex keeps omitting it, so the next cycle retries it.
                print(f"Warning: could not persist completion for {video_id!r} ({type(exc).__name__}): {exc}")
    return confirmed


def refresh_snapshot(*, now: datetime | None = None) -> dict[str, Any]:
    """One full refresh cycle: fetch, persist, diff, verify+mark completions. Returns a summary for logging/tests.

    Never raises on a Holodex failure -- the last good snapshot is left untouched and completion detection is
    skipped for this cycle rather than risk diffing an unknown current state against the previous one.
    """
    moment = now or datetime.now(timezone.utc)
    previous_streams = read_snapshot() or []
    previous_ids = {stream["videoId"] for stream in previous_streams}

    try:
        streams = _fetch_live_streams_with_bounded_retry()
    except Exception as exc:  # noqa: BLE001 -- HolodexAPIError/MissingHolodexApiKeyError/anything else: availability
        # first, keep the last good snapshot rather than overwrite it with an unknown/failed observation.
        print(f"Warning: livestream snapshot refresh failed after retries ({type(exc).__name__}): {exc}; keeping the last persisted snapshot")
        return {"refreshed": False, "streamCount": len(previous_streams), "completionCandidates": [], "confirmedCompleted": []}

    put_remote_config(
        {
            "clientId": SYSTEM_CLIENT_ID,
            "key": LIVE_SNAPSHOT_KEY,
            "value": {"streams": streams, "refreshedAt": moment.isoformat()},
            "updatedAt": moment.isoformat(),
        }
    )

    current_ids = {stream["videoId"] for stream in streams}
    candidates = sorted(previous_ids - current_ids)
    confirmed = _verify_and_mark_completed(candidates)
    return {"refreshed": True, "streamCount": len(streams), "completionCandidates": candidates, "confirmedCompleted": confirmed}


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """EventBridge Scheduler entry point (yobi-analytics-livestream-lifecycle, rate(5 minutes))."""
    return refresh_snapshot()
