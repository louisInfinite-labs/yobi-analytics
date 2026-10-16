"""Livestream lifecycle: two independent jobs in one Lambda, plus the freshness-aware read GET /live-streams uses.

One Holodex request per 10 minutes is the ONLY routine upstream polling in the whole backend:

1. DISPLAY refresh (refresh_display_snapshot, every 10 minutes at :00/:10/:20/:30/:40/:50 UTC, event {"mode": "display"}): ONE
   aggregate Holodex `/users/live` request (all channels at once, never per creator; it returns BOTH live and upcoming
   streams, so there is no second request for the other status) -> the display snapshot every visitor of GET /live-streams
   shares. A page view never reaches Holodex. The large snapshot item is rewritten only when its meaningful content changed
   (or every DISPLAY_CONTENT_REFRESH_SECONDS regardless); every other run just refreshes a tiny heartbeat record, so an
   unchanged run costs ~1 DynamoDB write unit instead of ~17. Freshness is max(snapshot.refreshedAt, heartbeat.refreshedAt).
   A schedule change Holodex reports is therefore visible to everyone within one display interval, never sooner.
2. COMPLETION lifecycle (refresh_snapshot, every 5 minutes, any other event): decides which streams ENDED. It makes NO
   Holodex request of its own while the display snapshot is fresh -- it reads that snapshot and compares it with its
   previous observation. Only if the display snapshot is stale (display job failing) and not in a failure cooldown does it
   fall back to one bounded Holodex fetch; during a cooldown it skips the cycle (an unknown state is never diffed).
   The freshness constants below are derived from the display cadence on purpose: a threshold shorter than one interval would
   make this fallback fire on every cycle and silently restore routine Holodex polling.

Both run as the same Lambda (yobi-analytics-livestream-lifecycle) under two EventBridge schedules
(terraform/eventbridge.tf), reserved_concurrent_executions=1, so runs are serialized. Re-delivered/duplicate completion
invocations are additionally ignored when the previous cycle finished less than COMPLETION_MIN_INTERVAL_SECONDS ago.

COMPLETION details -- what is a candidate, what confirms an end:
  - Only a stream observed LIVE in the previous observation can become an ended-stream candidate by disappearing. An
    UPCOMING stream vanishing (cancelled, rescheduled, deleted) is not an end.
  - LIVE-END WATCH: the display snapshot only moves every 10 minutes and Holodex itself keeps listing a stream for a few
    minutes after it ended (measured in production: actualEnd -> confirmed end p50 5.9 min, mean 8.7 min), so waiting for a stream
    to DISAPPEAR would delay every end by up to another display interval. Every completion cycle therefore also asks YouTube about
    the streams the snapshot currently lists as live -- the same batched call below, 1 quota unit per 50 videoIds -- and a stream
    YouTube already reports with an actualEndTime becomes a candidate at once, whether or not Holodex still lists it. End
    confirmation then costs at most one completion interval after YouTube's own actualEndTime and no longer depends on Holodex's
    cadence at all. GET /live-streams stops listing such a stream as live (api.read_api) so every client agrees with the record.
  - A candidate is checked with YouTube (collection.youtube_client.get_archive_probe: snippet, liveStreamingDetails, status,
    statistics in ONE batched videos.list call per cycle, shared with the archive lookup below). Ended means YouTube returns
    liveStreamingDetails.actualEndTime -- no statistics are required, so a hidden viewCount cannot block a confirmation.
  - Outcomes are kept apart: ENDED (confirmed, with YouTube's actualEndTime); STILL LIVE/UPCOMING per YouTube (the
    disappearance was a Holodex gap -- stays a candidate, costs no attempt); NOT RETURNED (deleted, private or otherwise
    unavailable -- the API cannot tell these apart) counted per consecutive check, and after _MAX_PENDING_ATTEMPTS recorded
    as endState "unavailable" rather than silently dropped; and a TRANSIENT failure (no API key, quota, network) which
    changes nothing and costs no attempt.
  - Every confirmed end is recorded in its own record (`liveStreamEnded`, kept RECENTLY_ENDED_RETENTION, written only when
    it changes): videoId, creator, title, start times, lastSeenLiveAt, confirmedEndedAt, actualEnd (YouTube's value, never
    invented), endState and the archive state. Video Master `liveStatus=completed` is a best-effort side write.
  - ARCHIVE LOOKUP (separate from the end state; its success or failure never affects it): the exact videoId must be
    returned with title, creator channel (matching the creator), a finalized broadcast, public/unlisted, processed upload and
    embeddable. The first attempt is the cycle that confirms the end; attempts continue over successive cycles until at least
    ARCHIVE_LOOKUP_MAX_ATTEMPTS have been made AND ARCHIVE_LOOKUP_MIN_WINDOW has passed since the stream's actual end; then the entry is
    handed to the daily history task (collection.history_worker re-observes every manifest entry last seen upcoming/live daily until
    YouTube reports it completed). The window is anchored to the END, not to the confirmation: with the live-end watch the end is
    confirmed earlier, and a bare attempt count would then stop probing before YouTube has finished processing the upload (measured in
    production: 14% of verified archives needed the third attempt, ~14-16 minutes after the end). The extra attempts cost no extra
    YouTube quota -- they ride in the batch the cycle already sends. A probe that got no answer spends no attempt
    (ARCHIVE_LOOKUP_MAX_AGE bounds that). A creator who does not archive simply ends up handed off.
  - Home's 最新直播 (GET /creators/{id}/videos/recent) otherwise only reads the once-daily S3 ranking result. It overlays the
    records above (api.read_api): an exactly-matching ended video whose archive is verified available is shown as a
    completed livestream without waiting for the 18:00 JST run, never a different video, never an unverified one.

Persisted records (stores.remote_config_store, clientId "__system__"):
  liveStreamDisplaySnapshot  {streams, refreshedAt, consecutiveFailures}    large; rewritten on change / every DISPLAY_CONTENT_REFRESH_SECONDS
  liveStreamDisplayHeartbeat {refreshedAt, consecutiveFailures, lastFailureAt, cooldownUntil}   tiny; every run
  liveStreamSnapshot         {refreshedAt, liveBaseline, pendingCandidates, archiveWatch[, streams]}   completion state;
                             `streams` is a backup serving copy written only when the cycle had to fetch Holodex itself
  liveStreamEnded            {ended: {videoId: entry}}                      written only when it changes

read_serving_snapshot is what GET /live-streams reads: it serves the display snapshot while fresh, else the freshest of
the display and completion snapshots within MAX_SNAPSHOT_AGE_SECONDS, and raises LiveSnapshotStaleError (503) rather than
silently serve arbitrarily old data. The direct-Holodex fallback in api.read_api exists only for "nothing was ever persisted".

Deployment note: the freshness constants assume the 10-minute display schedule. Deploy the code to every function FIRST (the new
thresholds also work with the old 1-minute schedule), and only then move the schedule to cron(0/10 * * * ? *). The reverse order would
make the old thresholds (180 s / 900 s) see a normal 10-minute-old snapshot as stale: the completion job would fall back to its own
Holodex fetch every 5 minutes until the new code landed.
"""

from __future__ import annotations

import copy
import json
import random
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from api.holodex_client import HolodexAPIError
from notifications.live_reminder import SYSTEM_CLIENT_ID
from stores.remote_config_store import get_remote_config, put_remote_config

# The completion job's own record: its diff baseline (the streams that were LIVE at its last observation), pending
# completion candidates, and the archive-lookup bookkeeping. Distinct key from notifications.live_reminder.STREAM_SCHEDULE_KEY.
LIVE_SNAPSHOT_KEY = "liveStreamSnapshot"

# The display snapshot the 10-minute job writes and GET /live-streams prefers -- its own key, so the completion job's
# state is never touched by it -- and the tiny heartbeat/bookkeeping record next to it.
DISPLAY_SNAPSHOT_KEY = "liveStreamDisplaySnapshot"
DISPLAY_HEARTBEAT_KEY = "liveStreamDisplayHeartbeat"

# Confirmed-ended streams and their archive state; written only when its content changes.
ENDED_STREAMS_KEY = "liveStreamEnded"

# How often the display job polls Holodex: the EventBridge schedule `livestream_display_refresh` (terraform/eventbridge.tf,
# cron(0/10 * * * ? *)). A test pins the two together. Everything below that talks about freshness is derived from it.
DISPLAY_REFRESH_INTERVAL_SECONDS = 600

# GET /live-streams serves the display snapshot while it is at most this old -- one normal interval plus one MISSED run plus a
# minute of Lambda lag -- then falls back to whichever of the two snapshots is freshest, and refuses (LiveSnapshotStaleError ->
# 503) once even that is older than MAX_SNAPSHOT_AGE_SECONDS (3 missed display runs) -- bounded staleness, never an indefinite
# OFFLINE. DISPLAY_FRESH_SECONDS must stay above one interval: it is also the threshold at which the completion job gives up on
# the shared snapshot and makes its own Holodex request, so a smaller value would turn that fallback into routine polling.
DISPLAY_FRESH_SECONDS = 2 * DISPLAY_REFRESH_INTERVAL_SECONDS + 60
MAX_SNAPSHOT_AGE_SECONDS = 3 * DISPLAY_REFRESH_INTERVAL_SECONDS
# Even an unchanged snapshot's large item is rewritten this often, purely as a self-heal and so its own refreshedAt cannot grow
# arbitrarily old for anyone inspecting the record. Readers do not need it: freshness follows the heartbeat.
DISPLAY_CONTENT_REFRESH_SECONDS = 6 * 3600

# Display-job cooldowns (see the module docstring): an HTTP 429 backs off for 5 minutes, and from the third consecutive
# failure on the cooldown doubles from 2 minutes up to a 10-minute cap. One or two isolated failures cost nothing.
_DISPLAY_RATE_LIMIT_COOLDOWN_SECONDS = 300
_DISPLAY_COOLDOWN_AFTER_FAILURES = 3
_DISPLAY_COOLDOWN_BASE_SECONDS = 120
_DISPLAY_COOLDOWN_CAP_SECONDS = 600

# Bounded retry around the one Holodex call the completion FALLBACK makes -- a single transient failure must not skip a
# whole 5-minute cycle (and, worse, spuriously treat every currently-live stream as a completion candidate).
_HOLODEX_MAX_ATTEMPTS = 3
_HOLODEX_BACKOFF_BASE_SECONDS = 1.0
_HOLODEX_BACKOFF_CAP_SECONDS = 8.0

# Scheduler delivers a completion run every 300 s; anything closer than this to the previous finished cycle is a duplicate
# delivery or an async retry and must not be processed (and counted) a second time.
COMPLETION_MIN_INTERVAL_SECONDS = 120

# A candidate YouTube does not return at all (deleted/private/unavailable) is re-checked once per 5-minute cycle (the
# job's own cadence is the retry interval -- there is no separate, faster loop); 12 consecutive checks is ~1 hour. Then it
# is recorded as endState "unavailable". Transient failures and "still live per YouTube" never consume these attempts.
_MAX_PENDING_ATTEMPTS = 12
# Whatever the reason, a candidate unresolved this long is dropped (the daily task reconciles it).
PENDING_MAX_AGE = timedelta(hours=24)

# ARCHIVE LOOKUP -- a separate concern from end detection (module docstring).
ARCHIVE_LOOKUP_MAX_ATTEMPTS = 3
# Attempts also continue until this long after the stream's actual END (see _archive_window_open): a bare attempt count measured from
# the confirmation would shrink the window the moment ends are confirmed sooner than before.
ARCHIVE_LOOKUP_MIN_WINDOW = timedelta(minutes=20)
ARCHIVE_LOOKUP_MAX_AGE = timedelta(hours=1)
ARCHIVE_PENDING = "pending"
ARCHIVE_AVAILABLE = "available"
ARCHIVE_HANDED_OFF = "handed_off_to_daily_task"
ARCHIVE_UNAVAILABLE = "unavailable"

END_STATE_ENDED = "ended"
END_STATE_UNAVAILABLE = "unavailable"

# How long a confirmed end is kept: covers the Schedule's post-end waiting, the 24 h until the daily 18:00 JST pipeline can
# list the archive itself, and a missed day. GET /live-streams exposes only the last RECENTLY_ENDED_EXPOSE of it.
RECENTLY_ENDED_RETENTION = timedelta(hours=36)
RECENTLY_ENDED_EXPOSE = timedelta(hours=24)
# Safety stop for the record's size (an entry is roughly 0.4 KB); drops the OLDEST first, never a working limit.
RECENTLY_ENDED_MAX_ENTRIES = 300
# Readers (the API Lambda) keep the ended map this long in memory instead of re-reading it for every request.
ENDED_CACHE_SECONDS = 60

_STREAM_FIELDS = ("videoId", "creatorId", "title", "scheduledStart", "actualStart")


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


def _parse_moment(value: Any) -> datetime | None:
    """An ISO-8601 timestamp as an aware datetime, or None if absent/unparseable (an unusable snapshot)."""
    if not isinstance(value, str):
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def _read_record(key: str) -> dict[str, Any] | None:
    """The persisted record's `value` for `key`, or None if nothing was persisted under it."""
    record = get_remote_config(SYSTEM_CLIENT_ID, key)
    return record["value"] if record is not None else None


def _put_record(key: str, value: dict[str, Any], moment: datetime) -> None:
    """Persist one lifecycle record under its own key (a full overwrite, like every remote-config write)."""
    put_remote_config({"clientId": SYSTEM_CLIENT_ID, "key": key, "value": value, "updatedAt": moment.isoformat()})


def _put_display_record(value: dict[str, Any], moment: datetime) -> None:
    """Persist the large display snapshot record under its own key."""
    _put_record(DISPLAY_SNAPSHOT_KEY, value, moment)


def _read_snapshot_record() -> dict[str, Any] | None:
    """The completion job's persisted `value` ({refreshedAt, liveBaseline, pendingCandidates, archiveWatch[, streams]}),
    or None if nothing has ever been persisted."""
    return _read_record(LIVE_SNAPSHOT_KEY)


def read_snapshot() -> list[dict[str, Any]] | None:
    """The completion record's backup serving copy of the streams, or None when there is none (never persisted, or the
    last cycle reused the display snapshot and kept no copy).

    api.read_api.get_live_streams reads the display/completion snapshots through read_serving_snapshot instead; this
    accessor remains for callers and tests that want the completion job's own copy.
    """
    value = _read_snapshot_record()
    return value.get("streams") if value is not None else None


def _usable(value: dict[str, Any] | None) -> tuple[list[dict[str, Any]], datetime] | None:
    """(streams, refreshedAt) when a snapshot value carries both, else None (e.g. a display record that so far only
    holds failure/cooldown bookkeeping, or a malformed one)."""
    if value is None or not isinstance(value.get("streams"), list):
        return None
    refreshed_at = _parse_moment(value.get("refreshedAt"))
    return (value["streams"], refreshed_at) if refreshed_at is not None else None


def _read_display() -> tuple[dict[str, Any], dict[str, Any], tuple[list[dict[str, Any]], datetime] | None]:
    """(large snapshot value, heartbeat value, usable (streams, effective refreshedAt)).

    The effective refreshedAt is the later of the large item's own and the heartbeat's, so a run that changed nothing (and
    therefore did not rewrite the large item) still keeps the snapshot fresh. Records written before the heartbeat existed
    simply have no heartbeat, and their own refreshedAt applies unchanged.
    """
    snapshot = _read_record(DISPLAY_SNAPSHOT_KEY) or {}
    heartbeat = _read_record(DISPLAY_HEARTBEAT_KEY) or {}
    usable = _usable(snapshot)
    if usable is not None:
        beat = _parse_moment(heartbeat.get("refreshedAt"))
        if beat is not None and beat > usable[1]:
            usable = (usable[0], beat)
    return snapshot, heartbeat, usable


def _display_state(snapshot: dict[str, Any], heartbeat: dict[str, Any]) -> dict[str, Any]:
    """The display job's failure/cooldown bookkeeping: the heartbeat record when there is one, else the legacy fields that older
    versions kept inside the large snapshot item."""
    return heartbeat if heartbeat else snapshot


def _stream_signature(streams: Any) -> str | None:
    """A canonical form of a stream list for change detection: ordered by videoId and key-sorted, so neither the order Holodex
    happens to return nor dict key order can make an unchanged snapshot look changed. None for anything that is not a list."""
    if not isinstance(streams, list):
        return None
    return json.dumps(sorted(streams, key=lambda stream: str(stream.get("videoId"))), sort_keys=True, default=str)

# ============ serving ============


class LiveSnapshotStaleError(HolodexAPIError):
    """Every persisted live snapshot is older than MAX_SNAPSHOT_AGE_SECONDS: both refreshers have stopped or are failing.

    A HolodexAPIError subclass so api_handler.py's existing "live data temporarily unavailable" 503 mapping applies --
    an explicit bounded error instead of serving an arbitrarily old (possibly all-OFFLINE) list as if it were current.
    """


def read_serving_snapshot(*, now: datetime | None = None) -> list[dict[str, Any]] | None:
    """The streams GET /live-streams should serve, with bounded staleness.

    - The display snapshot, when it (or its heartbeat) is at most DISPLAY_FRESH_SECONDS old (the normal case).
    - Otherwise the freshest of the display and completion snapshots, when that one is at most MAX_SNAPSHOT_AGE_SECONDS
      old (the display job is late or failing but the completion job still refreshes its backup copy).
    - Raises LiveSnapshotStaleError when snapshots exist but all are older than that: never silently serves them.
    - None only when no usable snapshot was ever persisted (fresh deploy / non-DynamoDB environment): the caller then
      falls back to its own one-request direct Holodex fetch, exactly as before this existed.

    A store read failure propagates (never folded into the fallback), see api.read_api._read_shared_live_snapshot.
    """
    moment = now or datetime.now(timezone.utc)
    _snapshot, _heartbeat, display = _read_display()
    if display is not None and (moment - display[1]).total_seconds() <= DISPLAY_FRESH_SECONDS:
        return display[0]
    completion = _usable(_read_record(LIVE_SNAPSHOT_KEY))
    candidates = [snapshot for snapshot in (display, completion) if snapshot is not None]
    if not candidates:
        return None
    streams, refreshed_at = max(candidates, key=lambda snapshot: snapshot[1])
    if (moment - refreshed_at).total_seconds() > MAX_SNAPSHOT_AGE_SECONDS:
        raise LiveSnapshotStaleError(
            f"live stream snapshot is stale: freshest refresh was {refreshed_at.isoformat()}, "
            f"more than {MAX_SNAPSHOT_AGE_SECONDS}s ago"
        )
    return streams


def read_display_refreshed_at() -> datetime | None:
    """When the shared display snapshot was last successfully refreshed -- the later of the heartbeat's and the snapshot's own refreshedAt --
    or None when no snapshot was ever persisted. Reads only the tiny heartbeat record unless it is missing (a record from before the
    heartbeat existed), so a caller that merely wants to know "did the snapshot change since I last looked" (the notification dispatcher,
    once a minute) does not pay for the large item."""
    beat = _parse_moment((_read_record(DISPLAY_HEARTBEAT_KEY) or {}).get("refreshedAt"))
    if beat is not None:
        return beat
    _snapshot, _heartbeat, usable = _read_display()
    return usable[1] if usable is not None else None


# ============ DISPLAY refresh (every 10 minutes) ============


def _display_cooldown_seconds(failures: int, error: Exception) -> int:
    """How long the display job stays off Holodex after a failed run: 0 for an isolated failure, 300s for a 429, and an
    exponential 120s..600s from the third consecutive failure."""
    if getattr(error, "status_code", None) == 429:
        return _DISPLAY_RATE_LIMIT_COOLDOWN_SECONDS
    if failures < _DISPLAY_COOLDOWN_AFTER_FAILURES:
        return 0
    return min(_DISPLAY_COOLDOWN_CAP_SECONDS, _DISPLAY_COOLDOWN_BASE_SECONDS * 2 ** (failures - _DISPLAY_COOLDOWN_AFTER_FAILURES))


def refresh_display_snapshot(*, now: datetime | None = None) -> dict[str, Any]:
    """One display refresh: a single aggregate Holodex request (live AND upcoming together), persisted as the snapshot every
    GET /live-streams visitor shares.

    No in-run retry (the next scheduled run, one display interval later, is the retry) and a persisted shared cooldown (see the module
    docstring), so the upstream request rate can never exceed one per run. A failure never overwrites the last good streams or their
    refreshedAt -- only the heartbeat's failure bookkeeping changes -- and the snapshot's age is what bounds staleness.

    The large item is written only when the meaningful content (the stream list, ignoring order) changed, or when it has
    gone DISPLAY_CONTENT_REFRESH_SECONDS without a write; otherwise only the tiny heartbeat is. A failed WRITE is logged and
    reported, never raised (a raised error would make Lambda re-deliver the event and fire a second Holodex request) and never
    advances the heartbeat past data that did not land. Returns a summary for logging/tests.
    """
    moment = now or datetime.now(timezone.utc)
    snapshot, heartbeat, _usable_display = _read_display()
    state = _display_state(snapshot, heartbeat)
    cooldown_until = _parse_moment(state.get("cooldownUntil"))
    if cooldown_until is not None and moment < cooldown_until:
        return {"refreshed": False, "skipped": "cooldown", "cooldownUntil": cooldown_until.isoformat()}

    from api.read_api import fetch_live_streams_from_holodex

    try:
        streams = fetch_live_streams_from_holodex()
    except Exception as exc:  # noqa: BLE001 -- HolodexAPIError/MissingHolodexApiKeyError/anything else: availability first
        failures = int(state.get("consecutiveFailures", 0)) + 1
        cooldown = _display_cooldown_seconds(failures, exc)
        record: dict[str, Any] = {"consecutiveFailures": failures, "lastFailureAt": moment.isoformat()}
        if heartbeat.get("refreshedAt"):
            record["refreshedAt"] = heartbeat["refreshedAt"]  # the last SUCCESS, never the failure's time
        if cooldown:
            record["cooldownUntil"] = (moment + timedelta(seconds=cooldown)).isoformat()
        try:
            _put_record(DISPLAY_HEARTBEAT_KEY, record, moment)
        except Exception as write_exc:  # noqa: BLE001 -- bookkeeping is best effort; see the docstring
            print(f"Warning: could not record the display refresh failure ({type(write_exc).__name__}): {write_exc}")
        print(f"Warning: live display refresh failed ({type(exc).__name__}): {exc}; keeping the last snapshot, cooldown {cooldown}s")
        return {"refreshed": False, "failures": failures, "cooldownSeconds": cooldown}

    snapshot_refreshed = _parse_moment(snapshot.get("refreshedAt"))
    age = (moment - snapshot_refreshed).total_seconds() if snapshot_refreshed is not None else float("inf")
    changed = _stream_signature(streams) != _stream_signature(snapshot.get("streams"))
    write_snapshot = changed or age >= DISPLAY_CONTENT_REFRESH_SECONDS
    try:
        if write_snapshot:
            _put_display_record({"streams": streams, "refreshedAt": moment.isoformat(), "consecutiveFailures": 0}, moment)
        _put_record(DISPLAY_HEARTBEAT_KEY, {"refreshedAt": moment.isoformat(), "consecutiveFailures": 0}, moment)
    except Exception as exc:  # noqa: BLE001 -- the Holodex request is already spent; do not re-deliver and spend another
        print(f"Warning: live display snapshot could not be persisted ({type(exc).__name__}): {exc}; the previous snapshot stays")
        return {"refreshed": False, "writeFailed": True, "streamCount": len(streams)}
    return {"refreshed": True, "streamCount": len(streams), "snapshotWritten": write_snapshot}


# ============ COMPLETION lifecycle (5 minutes) ============


def _slim_stream(stream: dict[str, Any]) -> dict[str, Any]:
    """The few fields of a snapshot stream worth remembering once it has left the live list: identity, creator, title and start times."""
    return {key: stream.get(key) for key in _STREAM_FIELDS}


def _live_baseline(previous: dict[str, Any]) -> list[dict[str, Any]]:
    """The streams that were LIVE at the previous observation. New records keep this list directly; a record from before
    it existed carried the whole stream list, of which only the live ones count."""
    if isinstance(previous.get("liveBaseline"), list):
        return previous["liveBaseline"]
    return [_slim_stream(stream) for stream in previous.get("streams") or [] if stream.get("status") == "live"]


def _streams_for_completion(moment: datetime) -> tuple[list[dict[str, Any]], str] | None:
    """(streams, source) for this completion cycle, or None to skip the cycle.

    source "display": the shared display snapshot, when it is fresh -- no Holodex request at all. Otherwise (display job
    stale or never ran) one bounded Holodex fetch, source "holodex". While the display job is in a failure cooldown the cycle
    is skipped (None): the cooldown exists to keep Holodex alone, and an unknown state must never be diffed against the last.
    Raises on a Holodex failure in the fallback, which the caller turns into a skipped cycle.
    """
    snapshot, heartbeat, display = _read_display()
    cooldown_until = _parse_moment(_display_state(snapshot, heartbeat).get("cooldownUntil"))
    if cooldown_until is not None and moment < cooldown_until:
        return None
    if display is not None and (moment - display[1]).total_seconds() <= DISPLAY_FRESH_SECONDS:
        return display[0], "display"
    return _fetch_live_streams_with_bounded_retry(), "holodex"


def _probe(video_ids: list[str]) -> tuple[dict[str, dict[str, Any]], set[str]]:
    """(facts by videoId, ids that YouTube actually ANSWERED for). An id answered for but absent from the facts was not
    returned (deleted/private/unavailable). When the call could not be made or failed (no key, quota wall, network) the
    answered set is empty -- or covers only the batches before the wall -- and nothing is concluded about the rest."""
    if not video_ids:
        return {}, set()
    from collection.youtube_client import QuotaExhaustedError, build_youtube_client, get_archive_probe
    from ops.config import get_api_key

    try:
        probes = get_archive_probe(build_youtube_client(get_api_key()), video_ids)
        return probes, set(video_ids)
    except QuotaExhaustedError as exc:
        remaining = set(getattr(exc, "remaining_video_ids", None) or video_ids)
        partial = {item["videoId"]: item for item in exc.partial_results} if isinstance(exc.partial_results, list) else {}
        print(f"Warning: YouTube quota exhausted probing {len(video_ids)} video(s); {len(partial)} answered before the wall")
        return partial, set(video_ids) - remaining
    except Exception as exc:  # noqa: BLE001 -- no key, network, malformed: nothing was learned, nothing is concluded
        print(f"Warning: could not probe {len(video_ids)} video(s) on YouTube this cycle ({type(exc).__name__}): {exc}")
        return {}, set()


def _creator_channel_id(creator_id: str | None) -> str | None:
    """The creator's YouTube channel id from Creator Master, or None when unknown (then only the other archive checks apply)."""
    if not creator_id:
        return None
    try:
        from api.read_api import _find_creator

        creator = _find_creator(creator_id)
        return creator.youtube_channel_id if creator is not None else None
    except Exception:  # noqa: BLE001 -- creator lookup is a nicety; never a reason to fail the lookup itself
        return None


def _evaluate_archive(probe: dict[str, Any] | None, expected_channel_id: str | None) -> tuple[str | None, dict[str, Any]]:
    """(the reason this archive is NOT usable yet, or None when it is; the facts worth recording).

    Usable means all of: YouTube returns the exact videoId with a title and its creator's channel (matching the creator when known), the
    broadcast is finalized (actualEndTime), it is public or unlisted, its upload is processed and it is embeddable (the app plays it embedded).
    """
    if probe is None:
        return "not_returned_by_youtube", {}
    facts: dict[str, Any] = {"title": probe.get("title"), "channelId": probe.get("channelId")}
    if not probe.get("title") or not probe.get("channelId"):
        return "metadata_missing", facts
    if expected_channel_id and probe["channelId"] != expected_channel_id:
        return "channel_mismatch", facts
    if not probe.get("actualEndTime"):
        return "broadcast_not_finalized", facts
    if probe.get("privacyStatus") not in ("public", "unlisted"):
        return "not_public", facts
    if probe.get("uploadStatus") != "processed":
        return "still_processing", facts
    if probe.get("embeddable") is False:
        return "not_embeddable", facts
    facts.update({"actualEndTime": probe["actualEndTime"], "publishedAt": probe.get("publishedAt"), "viewCount": probe.get("viewCount")})
    return None, facts

def _prune_ended(ended: dict[str, dict[str, Any]], moment: datetime) -> dict[str, dict[str, Any]]:
    """Drop confirmed-ended records older than RECENTLY_ENDED_RETENTION (and any malformed one), and the oldest beyond RECENTLY_ENDED_MAX_ENTRIES."""
    kept = {}
    for video_id, entry in ended.items():
        confirmed_at = _parse_moment(entry.get("confirmedEndedAt")) if isinstance(entry, dict) else None
        if confirmed_at is not None and moment - confirmed_at <= RECENTLY_ENDED_RETENTION:
            kept[video_id] = entry
    if len(kept) > RECENTLY_ENDED_MAX_ENTRIES:
        newest = sorted(kept, key=lambda video_id: kept[video_id]["confirmedEndedAt"], reverse=True)[:RECENTLY_ENDED_MAX_ENTRIES]
        kept = {video_id: kept[video_id] for video_id in newest}
    return kept


def _ended_entry(stream: dict[str, Any], *, end_state: str, previous_refreshed_at: str | None, moment: datetime, actual_end: str | None) -> dict[str, Any]:
    """A new record for a stream that is no longer going to be live. actualEnd is YouTube's own actualEndTime or None -- never invented."""
    return {
        **_slim_stream(stream),
        "lastSeenLiveAt": previous_refreshed_at,
        "confirmedEndedAt": moment.isoformat(),
        "actualEnd": actual_end,
        "endState": end_state,
        "archive": {"status": ARCHIVE_PENDING if end_state == END_STATE_ENDED else ARCHIVE_UNAVAILABLE},
    }


def _resolve_candidates(
    pending: dict[str, dict[str, Any]],
    probes: dict[str, dict[str, Any]],
    answered: set[str],
    ended: dict[str, dict[str, Any]],
    *,
    previous_refreshed_at: str | None,
    moment: datetime,
) -> tuple[list[str], dict[str, dict[str, Any]]]:
    """Decide each pending candidate from this cycle's YouTube answer. Returns (videoIds newly recorded as ended, next pending).

    ENDED (actualEndTime present) -> recorded with YouTube's end time; Video Master completed is a best-effort side write whose
    failure keeps the candidate for a bounded retry of the write only. Present but not ended -> still live: stays, costs nothing.
    Not returned -> counted; after _MAX_PENDING_ATTEMPTS recorded as "unavailable". Not answered -> untouched. Idempotent: a video
    already recorded is never recorded twice.
    """
    from stores.dynamodb_store import set_video_live_status

    newly_ended: list[str] = []
    next_pending: dict[str, dict[str, Any]] = {}
    for video_id, state in pending.items():
        first_seen = _parse_moment(state.get("firstSeenMissingAt"))
        if first_seen is not None and moment - first_seen > PENDING_MAX_AGE:
            print(f"Warning: dropping completion candidate {video_id!r}, unresolved for over {PENDING_MAX_AGE}")
            continue
        if video_id not in answered:
            next_pending[video_id] = state  # a transient failure: nothing learned, nothing counted
            continue
        probe = probes.get(video_id)
        stream = state.get("stream") or {"videoId": video_id}
        if probe is None:
            attempts = int(state.get("attempts", 0)) + 1
            if attempts >= _MAX_PENDING_ATTEMPTS:
                print(f"Warning: completion candidate {video_id!r} not returned by YouTube in {attempts} consecutive checks; recorded as unavailable")
                if video_id not in ended:
                    ended[video_id] = _ended_entry(stream, end_state=END_STATE_UNAVAILABLE, previous_refreshed_at=previous_refreshed_at, moment=moment, actual_end=None)
                    newly_ended.append(video_id)
            else:
                next_pending[video_id] = {**state, "attempts": attempts}
            continue
        if not probe.get("actualEndTime"):
            next_pending[video_id] = {**state, "attempts": 0}  # YouTube says it is still live/upcoming: Holodex merely lost it
            continue
        if video_id not in ended:
            ended[video_id] = _ended_entry(stream, end_state=END_STATE_ENDED, previous_refreshed_at=previous_refreshed_at, moment=moment, actual_end=probe["actualEndTime"])
            newly_ended.append(video_id)
        try:
            set_video_live_status(video_id, "completed")
        except Exception as exc:  # noqa: BLE001 -- the end is already recorded; only this side write is retried, boundedly
            attempts = int(state.get("attempts", 0)) + 1
            print(f"Warning: could not persist completion for {video_id!r} ({type(exc).__name__}): {exc}")
            if attempts < _MAX_PENDING_ATTEMPTS:
                next_pending[video_id] = {**state, "attempts": attempts}
    return newly_ended, next_pending


def _archive_window_open(entry: dict[str, Any], moment: datetime) -> bool:
    """Whether the stream's actual END is still younger than ARCHIVE_LOOKUP_MIN_WINDOW -- YouTube may simply not have finished processing the
    upload yet. Measured from YouTube's actualEnd (the confirmation time when there is none), so confirming an end sooner never shortens it."""
    reference = _parse_moment(entry.get("actualEnd")) or _parse_moment(entry.get("confirmedEndedAt"))
    return reference is not None and moment - reference < ARCHIVE_LOOKUP_MIN_WINDOW


def _run_archive_lookups(
    ended: dict[str, dict[str, Any]],
    watch: dict[str, dict[str, Any]],
    newly_ended: list[str],
    probes: dict[str, dict[str, Any]],
    answered: set[str],
    moment: datetime,
) -> dict[str, dict[str, Any]]:
    """One archive-lookup pass over the ended records still awaiting one, using the SAME probe answers as end detection.

    A record gets at least ARCHIVE_LOOKUP_MAX_ATTEMPTS attempts over successive cycles -- the first in the cycle that confirmed the end -- and
    keeps being attempted until ARCHIVE_LOOKUP_MIN_WINDOW after the stream's actual end (see _archive_window_open). A usable archive is
    recorded as available; the last unsuccessful attempt (or, if probes could not run, ARCHIVE_LOOKUP_MAX_AGE) hands it to the daily history
    task. Not answered -> no attempt spent. Returns the next archiveWatch; mutates `ended`.
    """
    next_watch: dict[str, dict[str, Any]] = {}
    for video_id in list(dict.fromkeys([*newly_ended, *watch])):
        entry = ended.get(video_id)
        if entry is None or entry.get("endState") != END_STATE_ENDED or (entry.get("archive") or {}).get("status") != ARCHIVE_PENDING:
            continue
        state = watch.get(video_id, {"attempts": 0})
        confirmed_at = _parse_moment(entry.get("confirmedEndedAt"))
        if video_id not in answered:
            if confirmed_at is not None and moment - confirmed_at > ARCHIVE_LOOKUP_MAX_AGE:
                entry["archive"] = {"status": ARCHIVE_HANDED_OFF, "attempts": int(state.get("attempts", 0)), "handedOffAt": moment.isoformat(), "reason": state.get("lastReason") or "lookup_window_elapsed"}
            else:
                next_watch[video_id] = state
            continue
        attempts = int(state.get("attempts", 0)) + 1
        reason, facts = _evaluate_archive(probes.get(video_id), _creator_channel_id(entry.get("creatorId")))
        if reason is None:
            entry["archive"] = {"status": ARCHIVE_AVAILABLE, "attempts": attempts, "availableAt": moment.isoformat(), **facts}
        elif attempts >= ARCHIVE_LOOKUP_MAX_ATTEMPTS and not _archive_window_open(entry, moment):
            entry["archive"] = {"status": ARCHIVE_HANDED_OFF, "attempts": attempts, "handedOffAt": moment.isoformat(), "reason": reason}
        else:
            next_watch[video_id] = {"attempts": attempts, "lastReason": reason, "lastCheckedAt": moment.isoformat()}
    return next_watch


def _read_ended_record() -> dict[str, dict[str, Any]] | None:
    """The persisted ended map, or None when the record has never been written."""
    value = _read_record(ENDED_STREAMS_KEY)
    if value is None or not isinstance(value.get("ended"), dict):
        return None
    return value["ended"]


def refresh_snapshot(*, now: datetime | None = None) -> dict[str, Any]:
    """One completion cycle: take the current streams (the shared display snapshot, no Holodex request), diff against the previous
    observation into the durable pending-candidates set, resolve candidates -- plus the live-end watch over every stream the snapshot lists as
    live, and the archive watch -- with ONE batched YouTube call, record confirmed ends, run the archive lookups, and persist. Returns a
    summary for logging/tests.

    Never raises on a Holodex or YouTube failure -- the last good state is left untouched and nothing is concluded from an unknown
    observation (every currently-live stream would otherwise look like a completion candidate). A duplicate/re-delivered invocation
    (the previous cycle finished less than COMPLETION_MIN_INTERVAL_SECONDS ago) does nothing.
    """
    moment = now or datetime.now(timezone.utc)
    previous = _read_snapshot_record() or {}
    live_baseline = _live_baseline(previous)
    previous_pending: dict[str, dict[str, Any]] = dict(previous.get("pendingCandidates") or {})
    previous_watch: dict[str, dict[str, Any]] = dict(previous.get("archiveWatch") or {})
    summary_base = {"streamCount": len(live_baseline), "completionCandidates": sorted(previous_pending), "confirmedCompleted": []}

    previous_refreshed = _parse_moment(previous.get("refreshedAt"))
    if previous_refreshed is not None and 0 <= (moment - previous_refreshed).total_seconds() < COMPLETION_MIN_INTERVAL_SECONDS:
        return {"refreshed": False, "skipped": "duplicate_invocation", **summary_base}

    try:
        obtained = _streams_for_completion(moment)
    except Exception as exc:  # noqa: BLE001 -- HolodexAPIError/MissingHolodexApiKeyError/anything else: availability
        # first, keep the last good state rather than overwrite it with an unknown observation.
        print(f"Warning: livestream snapshot refresh failed after retries ({type(exc).__name__}): {exc}; keeping the last persisted snapshot")
        return {"refreshed": False, **summary_base}
    if obtained is None:
        return {"refreshed": False, "skipped": "display_cooldown", **summary_base}
    streams, source = obtained

    previous_ended = _read_ended_record()
    ended = _prune_ended(copy.deepcopy(previous_ended or {}), moment)  # a deep copy: entries are updated in place below and compared with the original before writing

    # Candidates: only a stream previously observed LIVE that is no longer in the snapshot at all. A stream that merely changed status, or
    # an UPCOMING one that vanished, is not an end. A candidate that reappears is a false alarm and is dropped at once -- except one the
    # live-end watch below found already ended on YouTube while Holodex still lists it (it is listed BY DEFINITION until Holodex catches up).
    # A stream whose end is already recorded needs no second look when it finally disappears.
    current_ids = {stream["videoId"] for stream in streams}
    baseline_by_id = {stream["videoId"]: stream for stream in live_baseline}
    pending = {video_id: state for video_id, state in previous_pending.items() if video_id not in current_ids or state.get("listedWhileEnded")}
    for video_id in baseline_by_id.keys() - current_ids:
        if video_id not in ended:
            pending.setdefault(video_id, {"firstSeenMissingAt": moment.isoformat(), "attempts": 0, "stream": baseline_by_id[video_id]})

    # LIVE-END WATCH (module docstring): the streams the snapshot lists as live ride in the same batched YouTube call as the candidates and
    # the archive watch -- one videos.list unit per 50 ids -- so an end is confirmed within a completion interval of YouTube's actualEndTime
    # rather than after Holodex's own lag plus the next display refresh.
    listed_live = {stream["videoId"]: stream for stream in streams if stream.get("status") == "live"}
    probe_ids = sorted(set(pending) | set(listed_live) | {video_id for video_id in previous_watch if video_id in ended})
    probes, answered = _probe(probe_ids)
    for video_id, stream in listed_live.items():
        probe = probes.get(video_id)
        if video_id in ended or video_id in pending or video_id not in answered or probe is None or not probe.get("actualEndTime"):
            continue  # recorded already, handled as a candidate already, not answered (nothing learned), gone, or genuinely still live
        pending[video_id] = {"firstSeenMissingAt": moment.isoformat(), "attempts": 0, "stream": _slim_stream(stream), "listedWhileEnded": True}
    candidates = sorted(pending)

    # Two independent jobs from here. (1) The observed end state is decided from YouTube's answer for the candidates alone.
    # (2) The archive lookup runs on top of it with the same answers; whatever happens in (2) the ends from (1) are persisted below.
    newly_ended, next_pending = _resolve_candidates(
        pending, probes, answered, ended, previous_refreshed_at=previous.get("refreshedAt"), moment=moment
    )
    try:
        next_watch = _run_archive_lookups(ended, previous_watch, newly_ended, probes, answered, moment)
    except Exception as exc:  # noqa: BLE001 -- not expected; keeps "archive failures never block end recording" a guarantee
        print(f"Warning: archive lookup failed unexpectedly ({type(exc).__name__}): {exc}; confirmed ends are still recorded")
        next_watch = previous_watch

    try:
        if previous_ended is None or json.dumps(ended, sort_keys=True, default=str) != json.dumps(previous_ended, sort_keys=True, default=str):
            _put_record(ENDED_STREAMS_KEY, {"ended": ended}, moment)
        value: dict[str, Any] = {
            "refreshedAt": moment.isoformat(),
            "liveBaseline": [_slim_stream(stream) for stream in streams if stream.get("status") == "live"],
            "pendingCandidates": next_pending,
            "archiveWatch": next_watch,
        }
        if source == "holodex":
            value["streams"] = streams  # the display snapshot was not usable: keep a backup serving copy, as before
        _put_record(LIVE_SNAPSHOT_KEY, value, moment)
    except Exception as exc:  # noqa: BLE001 -- not raised: a re-delivery would only repeat this work; the next cycle redoes it idempotently
        print(f"Warning: livestream completion state could not be persisted ({type(exc).__name__}): {exc}")
        return {"refreshed": False, "writeFailed": True, **summary_base}
    reset_ended_cache()
    return {"refreshed": True, "streamCount": len(streams), "completionCandidates": candidates, "confirmedCompleted": newly_ended}


# ============ reading the end state (API Lambda) ============

_ended_cache: dict[str, Any] = {"at": None, "value": None}


def read_ended_streams() -> dict[str, dict[str, Any]] | None:
    """The persisted ended map (videoId -> entry), cached in memory for ENDED_CACHE_SECONDS so the API does not re-read it per request.
    None means the record has never been written: the end signal is not available (distinct from an empty map)."""
    fetched_at = _ended_cache["at"]
    if fetched_at is not None and time.monotonic() - fetched_at < ENDED_CACHE_SECONDS:
        return _ended_cache["value"]
    value = _read_ended_record()
    _ended_cache.update({"at": time.monotonic(), "value": value})
    return value


def reset_ended_cache() -> None:
    """Forget the in-memory ended map (tests, and callers that just wrote it)."""
    _ended_cache.update({"at": None, "value": None})


def read_recently_ended(*, now: datetime | None = None) -> list[dict[str, Any]] | None:
    """The streams the 5-minute lifecycle has CONFIRMED ended within RECENTLY_ENDED_EXPOSE, newest first, in the slim form GET /live-streams
    exposes as `recentlyEnded` (identity, end state, confirmedEndedAt, actualEnd, start times, archive status). The Schedule releases from
    this and ignores the archive state. None when the record has never been written: "no end signal", not "nothing ended"."""
    ended = read_ended_streams()
    if ended is None:
        return None
    moment = now or datetime.now(timezone.utc)
    entries = []
    for entry in ended.values():
        confirmed_at = _parse_moment(entry.get("confirmedEndedAt")) if isinstance(entry, dict) else None
        if confirmed_at is None or moment - confirmed_at > RECENTLY_ENDED_EXPOSE:
            continue
        archive = entry.get("archive") or {}
        entries.append(
            {
                **{key: entry.get(key) for key in (*_STREAM_FIELDS, "lastSeenLiveAt", "confirmedEndedAt", "actualEnd", "endState")},
                "archive": {key: archive[key] for key in ("status", "reason") if key in archive},
            }
        )
    return sorted(entries, key=lambda entry: entry.get("confirmedEndedAt") or "", reverse=True)


def read_available_archives(creator_id: str) -> list[dict[str, Any]]:
    """The creator's ended streams whose archive has been VERIFIED available (exact videoId, public/unlisted, processed, embeddable), with the
    facts Home needs to list them (title, publishedAt, viewCount when YouTube shows one). Empty when there is no record or nothing qualifies."""
    ended = read_ended_streams() or {}
    return [
        {"videoId": entry["videoId"], "creatorId": creator_id, **entry["archive"]}
        for entry in ended.values()
        if isinstance(entry, dict)
        and entry.get("creatorId") == creator_id
        and entry.get("endState") == END_STATE_ENDED
        and (entry.get("archive") or {}).get("status") == ARCHIVE_AVAILABLE
    ]


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """EventBridge Scheduler entry point (yobi-analytics-livestream-lifecycle): the 10-minute schedule sends
    {"mode": "display"}; the 5-minute completion schedule sends no input."""
    if isinstance(event, dict) and event.get("mode") == "display":
        return refresh_display_snapshot()
    return refresh_snapshot()