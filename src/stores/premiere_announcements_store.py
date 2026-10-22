"""Which upcoming videos the new-video Collector has already DECIDED about: videoId -> {"premiere": bool, "at": ISO time}.

The Collector announces an upcoming YouTube Premiere from the persisted shared livestream snapshot (collection/premiere_announcements.py). Each snapshot entry needs
one YouTube answer to tell a Premiere from an ordinary scheduled livestream, and each Premiere needs exactly one announcement. This small record is what makes both
happen once: an id decided as an ordinary livestream is never asked about again, an id decided as an announced Premiere is never announced again (across runs and across
event dates), and the later uploads-playlist discovery of the same Premiere knows it was already announced and records no second new-video event for it.

One record `{"version": n, "decisions": {videoId: {"premiere": bool, "at": ISO timestamp}}}` under the system client, first-write-wins per video (a decision is
never overwritten), written only when a run has a NEW decision to add (an unchanged state is never rewritten), bounded to the newest MAX_ENTRIES (about 70
bytes each). Every write is a compare-and-set on `version`, so two overlapping Collector runs can never overwrite each other's decisions: the loser re-reads,
merges and retries (MAX_WRITE_ATTEMPTS), and a run that still loses raises, leaving its ids undecided for the next window.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any

from stores.remote_config_store import RemoteConfigStoreError, get_remote_config, put_remote_config, put_remote_config_versioned

SYSTEM_CLIENT_ID = "__system__"
PREMIERE_ANNOUNCEMENTS_KEY = "premiereAnnouncements"
MAX_ENTRIES = 1000
MAX_WRITE_ATTEMPTS = 3


def _usable_time(value: Any) -> bool:
    """Whether `value` is an ISO-8601 timestamp with a UTC offset."""
    if not isinstance(value, str):
        return False
    try:
        return datetime.fromisoformat(value).tzinfo is not None
    except ValueError:
        return False


def _read_state() -> tuple[dict[str, dict[str, Any]], int | None]:
    """(decisions, stored version) from one read; the version is None when no record exists yet. A damaged entry is dropped, the rest is served."""
    record = get_remote_config(SYSTEM_CLIENT_ID, PREMIERE_ANNOUNCEMENTS_KEY)
    value = (record or {}).get("value") or {}
    raw_version = value.get("version")
    version = int(raw_version) if isinstance(raw_version, (int, Decimal)) and not isinstance(raw_version, bool) else (0 if record is not None else None)
    decisions = value.get("decisions")
    if not isinstance(decisions, dict):
        return {}, version
    return {
        video_id: {"premiere": entry["premiere"], "at": entry["at"]}
        for video_id, entry in decisions.items()
        if isinstance(video_id, str) and video_id and isinstance(entry, dict) and isinstance(entry.get("premiere"), bool) and _usable_time(entry.get("at"))
    }, version


def read_decisions() -> dict[str, dict[str, Any]]:
    """videoId -> {"premiere": bool, "at": time} for every decision recorded so far; {} when nothing was recorded.
    Raises the store's own error when the read fails (the Collector then skips this step for the run)."""
    return _read_state()[0]


def announced_video_ids(decisions: dict[str, dict[str, Any]]) -> set[str]:
    """The ids decided to be Premieres (and announced)."""
    return {video_id for video_id, entry in decisions.items() if entry["premiere"]}


def record_decisions(new_decisions: dict[str, bool], *, now: datetime) -> int:
    """Add the decisions for ids that have none yet, in ONE compare-and-set write; returns how many were added. An id that already has a decision keeps it
    (also one a concurrent run recorded meanwhile), and nothing is written when there is nothing new. Beyond MAX_ENTRIES the oldest decisions are dropped.
    Raises RemoteConfigStoreError when the write keeps losing to concurrent writers (MAX_WRITE_ATTEMPTS) or the store fails."""
    fresh = {video_id: bool(premiere) for video_id, premiere in new_decisions.items() if video_id}
    if not fresh:
        return 0
    moment = now.isoformat()
    for _attempt in range(MAX_WRITE_ATTEMPTS):
        current, version = _read_state()
        added = {video_id: premiere for video_id, premiere in fresh.items() if video_id not in current}
        if not added:
            return 0
        merged = {**current, **{video_id: {"premiere": premiere, "at": moment} for video_id, premiere in added.items()}}
        if len(merged) > MAX_ENTRIES:
            merged = dict(sorted(merged.items(), key=lambda item: datetime.fromisoformat(item[1]["at"]), reverse=True)[:MAX_ENTRIES])
        record = {
            "clientId": SYSTEM_CLIENT_ID,
            "key": PREMIERE_ANNOUNCEMENTS_KEY,
            "value": {"version": (version or 0) + 1, "decisions": merged},
            "updatedAt": moment,
        }
        if put_remote_config_versioned(record, expected_version=version):
            return len(added)
    raise RemoteConfigStoreError(f"Could not record the Premiere decisions after {MAX_WRITE_ATTEMPTS} attempts: concurrent writers kept winning")
