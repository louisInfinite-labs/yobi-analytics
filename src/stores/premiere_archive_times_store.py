"""Durable archive-availability times of completed YouTube Premieres: videoId -> when the lifecycle verified the replay available.

A Premiere is announced (and so discovered) long before its replay can be watched, so "NEW" for a Premiere has to count from the moment the archive became
available, not from its announcement. The lifecycle's own ended-stream record carries that time (`archive.availableAt`) but is pruned 36 hours after the
end was confirmed; a viewer who comes back later would then lose the replay's NEW state. This record keeps the time for as long as it can still matter.

Why a small record of its own rather than a Video Master attribute: the recent-videos API serves the creator's catalog from the persisted S3 ranking result,
which is built from the tracking manifest, which is built from Video Master -- a field written to Video Master would only reach the API after the history
pipeline, the manifest, the ranking reducer and the result serializer all learned it (three Lambdas), and up to a day late. This one record is read by the
API with a single cached GetItem and keeps the canonical videoId as its key (no second video record). It is a read model: the value is only ever copied from the
lifecycle's own verified `availableAt` -- never computed, defaulted, or taken from a request time.

One record `{"times": {videoId: ISO timestamp}}` under the system client, first-write-wins per video (a time is never overwritten), bounded to the
newest MAX_ENTRIES (about 55 bytes each, so far below DynamoDB's item limit).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from stores.remote_config_store import get_remote_config, put_remote_config

SYSTEM_CLIENT_ID = "__system__"
PREMIERE_ARCHIVE_TIMES_KEY = "premiereArchiveTimes"
MAX_ENTRIES = 1000


def _usable_time(value: Any) -> bool:
    """Whether `value` is an ISO-8601 timestamp with a UTC offset (an unusable stored time is dropped, never repaired)."""
    if not isinstance(value, str):
        return False
    try:
        return datetime.fromisoformat(value).tzinfo is not None
    except ValueError:
        return False


def read_premiere_archive_times() -> dict[str, str]:
    """videoId -> archive-availability time for every completed Premiere recorded so far; {} when nothing was recorded. Raises the store's own error when the
    read fails (callers that serve a page treat that as "no times", never as a reason to fail)."""
    record = get_remote_config(SYSTEM_CLIENT_ID, PREMIERE_ARCHIVE_TIMES_KEY)
    times = ((record or {}).get("value") or {}).get("times")
    if not isinstance(times, dict):
        return {}
    return {video_id: moment for video_id, moment in times.items() if isinstance(video_id, str) and video_id and _usable_time(moment)}


def record_premiere_archive_times(new_times: dict[str, str], *, now: datetime) -> int:
    """Add the given videoId -> availability times that are not recorded yet, in ONE write; returns how many were added. A video that already has a time keeps
    it (the first confirmation wins), an unusable time is ignored, and nothing is written when there is nothing to add. Beyond MAX_ENTRIES the oldest
    times are dropped."""
    fresh = {video_id: moment for video_id, moment in new_times.items() if video_id and _usable_time(moment)}
    if not fresh:
        return 0
    current = read_premiere_archive_times()
    added = {video_id: moment for video_id, moment in fresh.items() if video_id not in current}
    if not added:
        return 0
    merged = {**current, **added}
    if len(merged) > MAX_ENTRIES:
        newest = sorted(merged.items(), key=lambda item: datetime.fromisoformat(item[1]), reverse=True)[:MAX_ENTRIES]
        merged = dict(newest)
    put_remote_config(
        {"clientId": SYSTEM_CLIENT_ID, "key": PREMIERE_ARCHIVE_TIMES_KEY, "value": {"times": merged}, "updatedAt": now.isoformat()}
    )
    return len(added)
