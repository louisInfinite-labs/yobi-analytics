"""Scheduled Lambda entry point for the notification dispatcher: live reminders every minute, plus the `new_video_slots` mode.

One Lambda, two schedules (terraform/eventbridge.tf):

- no `mode` (rate(1 minute)): the live reminders below. This path no longer delivers new-video pushes.
- `{"mode": "new_video_slots"}` (every 15 minutes, UTC :00/:15/:30/:45): scheduled new-video delivery, implemented in
  new_video_dispatcher.py. It is routed there before any reminder work, so the two never share a run.

Each reminder run (docs/notification-dispatch-due-candidates.md):

1. Loads the system-wide "streamSchedule" snapshot (see below) and works out IN MEMORY which streams have a reminder due in this very minute
   (reminder_candidates.due_streams). Most minutes none does, and the run then reads nothing else: no client, preference or subscription is touched.
2. For those streams only, looks up their followers through the remote-config table's configKey-index (reminder_candidates.find_candidates: the
   reminder items are the per-creator subscription edges) and resolves, per follower, which single reminder setting applies -- per-stream override >
   creator 全部 > creator + the stream's matched topic > unset (live_reminder.resolve_effective_setting). It used to load EVERY client that had a stored
   NotificationPreference, then its push subscription and two reminder Queries, every minute (cost proportional to registered clients).
3. For each follower whose setting can be due now, reads that one client's stored preference and push subscription (the source of truth for mute,
   quiet hours, the master switch, locale and the subscription) and sends through the unchanged claim -> send -> confirm/release delivery code. A client
   with a stored preference but no push subscription is skipped (nothing to deliver to), not treated as an error. One client's failure never stops
   the others; only a run in which EVERY candidate client failed raises, so a systemic outage still shows up in the Lambda's error metric.
4. Then the simultaneous-livestream notices (simultaneous_dispatcher.py): collisions among the schedule's upcoming streams, derived in memory, and
   delivered only to clients that opted in. An idle day costs this step nothing.

The CURRENT scheduledStartMs and the stream's topic always come from the "streamSchedule" snapshot (live_reminder.StreamScheduleEntry), never from
anything stored inside a setting: a Holodex reschedule is picked up automatically on the snapshot's next refresh. A reminder is sent independent of
any discovery event (a genuinely different trigger: a stream's own scheduledStartMs, never discoveredAt). It is skipped -- never delayed or replayed --
if the client is muted or in quiet hours at the moment it was meant to fire, or at the moment this run would send it. This reuses the Lambda's own
cadence as-is -- rate(1 minute), applied to production since 2026-10-10 -- so _REMINDER_WINDOW matches it and "at start"/"1min"/"10min" are honoured
precisely, not just "30min"/"1hour". It is the ONE shared timer for every subscriber: no per-user or per-stream scheduler exists, and none is needed --
every run just compares the clock with the stored schedule.

A stream's START reminder (開播時通知) is due when its stored scheduledStart
arrives, nothing else: no Holodex request is made at that minute and no
Holodex/YouTube confirmation that the stream is live is awaited (see
live_reminder.is_start_reminder_due); the pre-start reminders (1/10/30/60
minutes) work the same way from the same stored start. A reschedule or
cancellation Holodex has reported is picked up as soon as the shared snapshot
carries it; one it has NOT reported yet cannot be known here -- the shared
snapshot is refreshed every 10 minutes (tracking/livestream_lifecycle.py), so
that is an inherent freshness limit of the data source, not of this timer.

LATE-DISCOVERY CATCH-UP (docs/late-discovery-advance-catch-up.md): an advance reminder's on-time window is only [fire_at, fire_at + 1 min), so a stream
that first appears in the shared snapshot AFTER its fire time can never be reminded on time. For exactly that case -- and only while the stream is still
upcoming, at least 2 minutes before its start, and only for a reminder the client had already enabled at the fire time -- one extra reminder may be sent,
worded with the actual minutes left. It is OFF unless the kill-switch record says otherwise, shares the on-time advance reminder's dedupe id, never
touches the on-time or start branches, and needs no extra Holodex request or schedule: the first-seen stamps it relies on are written by the derivation below.

Reminder EVALUATION (every dispatcher run) is deliberately decoupled from
how often Holodex is actually QUERIED: this module never queries Holodex.
_refresh_and_load_stream_schedule re-derives its "streamSchedule" entries from
read_api.get_live_streams() -- a read of the shared snapshot, which only the
10-minute display job refreshes from Holodex -- exactly when that snapshot is
newer than the one the stored entries were derived from (a tiny heartbeat read
per run, see live_reminder's streamSchedule note). One derivation per dispatcher
run at most, never per client, never per stream.

The "streamSchedule" snapshot is a full-replace write each derivation
(never merged), so a stream Holodex no longer returns (ended, cancelled, or
beyond its own upcoming window) naturally ages out on the next one --
no separate expiry/TTL bookkeeping needed. A failed derivation leaves the
previously stored snapshot untouched rather than wiping it (see
_refresh_and_load_stream_schedule), so a transient outage degrades to
"slightly stale schedule data", never "no reminders at all".
"""

from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone
from typing import Any

from stores import notification_delivery_log_store
from notifications import notification_payload
from notifications import notification_dispatch
from notifications import live_reminder
from notifications import new_video_dispatcher
from notifications import notification_text
from notifications import parallel
from notifications import push_sender
from notifications import push_ttl
from notifications import reminder_candidates
from notifications import simultaneous_dispatcher
from stores import remote_config_store
from api import remote_config_api
from api import read_api
from api.holodex_client import HolodexAPIError
from api.holodex_normalization import HolodexNormalizationError
from ops.config import get_vapid_credentials, MissingHolodexApiKeyError
from tracking import livestream_lifecycle
from tracking.creator_master import load_creators
from tracking.video_topics import OTHER_TOPIC, classify_video_topic

_NOTIFICATION_PREFERENCE_KEY = "notificationPreference"
_PUSH_SUBSCRIPTION_KEY = "pushSubscription"

# Matches this Lambda's own EventBridge rate (terraform/eventbridge.tf,
# rate(1 minute)) -- a reminder's fire window is
# [fire_at, fire_at + this), so it's always caught by the next run rather
# than skipped between two polls, while staying tight enough to honour
# "1min"/"10min" at their configured offset rather than merely eventually.
_REMINDER_WINDOW = timedelta(minutes=1)

# How long a LEGACY delivery row (keyed without a scheduled start, written by the previous version) still counts as "already sent for this start".
# A few reminder windows: it only has to cover the minutes around a redeploy; older rows belong to a start the stream may have moved away from.
_LEGACY_DEDUPE_WINDOW = timedelta(minutes=10)

# FALLBACK only: how old the persisted "streamSchedule" entries may get before this run re-derives them when the shared snapshot's own
# freshness cannot be read (a store hiccup, a non-DynamoDB environment). Normally the entries are re-derived exactly when the shared snapshot is
# newer than the one they came from, so this never decides anything. Equal to the display job's 10-minute cadence
# (tracking.livestream_lifecycle.DISPLAY_REFRESH_INTERVAL_SECONDS): re-deriving more often than the snapshot changes would find nothing new, and
# less often would let a start time lag the snapshot it should follow.
_SCHEDULE_REFRESH_INTERVAL = timedelta(minutes=10)

# The longest gap between two derivations of the schedule across which first-seen tracking is still trusted: the display snapshot's own freshness
# limit (two refresh intervals plus a minute). After a longer gap -- an outage -- streams Holodex had listed for hours would otherwise look newly
# discovered, so every stream without a trusted history is stamped "known" instead (live_reminder.derive_first_seen).
_FIRST_SEEN_MAX_SOURCE_GAP = timedelta(seconds=livestream_lifecycle.DISPLAY_FRESH_SECONDS)

# Recipients of one minute are served by this many threads (notifications/parallel.py). A push takes ~0.1-0.3 s (up to the 10 s request timeout), so
# one at a time a large fan-out could outlast the Lambda's 300 s and the remaining reminders -- never replayed on the on-time path -- would be lost.
_SEND_WORKERS = parallel.DEFAULT_WORKERS
# Stop STARTING recipients this close to the Lambda's deadline: a recipient already in flight needs up to 2 pushes x 10 s timeout plus its DynamoDB
# calls to finish, so the margin must exceed that. What was not started is not lost: it is recovered by the next run (see "recovery" below).
_DEADLINE_MARGIN_MS = 30_000

# RECOVERY of a missed, delayed, failed or cut-short run. A reminder's on-time window is [fire, fire + 1 min): a run that serves it late (the Scheduler
# retried a failed invocation, the Lambda was throttled, a previous run stopped at its deadline) would otherwise find the window closed and the
# reminder would be lost for a reason the user did nothing about. A run therefore also serves the minutes it can prove nobody served:
#   - its own instant is the Scheduler's scheduledTime when the schedule passes it (terraform/eventbridge.tf), else the wall clock;
#   - the minutes between the last instant THIS warm container finished and its own are served too ("recovered" instants); a cold container, which
#     knows nothing, serves the minute before its own (a cold start is exactly what follows a timeout or a deploy);
#   - never further back than _MAX_RECOVERY_LOOKBACK (0 turns recovery off).
# A recovered reminder is delivered ONLY while it is still true and only for something that was already in place when it first came due:
#   - an advance reminder while at least 2 minutes remain, worded "in about N minutes" with the real time left (the late-discovery catch-up's wording);
#   - a start reminder until _START_RECOVERY_GRACE after the scheduled start;
#   - the client's setting, subscription AND preference must all have been saved before the fire time (an unknown time fails closed), so turning
#     something on later never replays what already came due;
#   - mute / quiet hours are judged both at the fire time and now, exactly like an on-time reminder.
# Delivery is idempotent through the same atomic claim as an on-time reminder, so re-serving a minute that WAS served sends nothing twice.
_MAX_RECOVERY_LOOKBACK = timedelta(minutes=10)
_RECOVERY_TOLERANCE = timedelta(seconds=15)  # an instant served later than this after it is "recovered" (late wording and the stricter rules above)
# Two runs a little more than a minute apart are ordinary scheduling jitter, not a missed run: the pre-recovery dispatcher had the same property (a
# window as wide as its cadence), and treating a 61-second spacing as a gap would double the candidate reads of every second due minute.
_RECOVERY_JITTER = timedelta(seconds=30)
_START_RECOVERY_GRACE = timedelta(minutes=5)
# The last instant this warm container finished serving completely (epoch ms); None in a cold container.
_last_served_ms: int | None = None


class _CatchUpSwitch:
    """The late-discovery catch-up's kill switch, read lazily and at most once per run.

    The switch is the system record (live_reminder.SYSTEM_CLIENT_ID, live_reminder.CATCH_UP_FLAG_KEY) with value {"enabled": true}. Anything else --
    no record, a value that is not exactly that, a store error -- means OFF: the catch-up fails closed. It is asked only when a run has an actual
    catch-up candidate (so a run with nothing to catch up costs no extra read) and BEFORE the candidate's delivery-log lookups. It gates the
    catch-up send and nothing else: the on-time advance reminder and the start reminder never consult it.
    """

    def __init__(self) -> None:
        """Nothing is read until the first candidate asks."""
        self._enabled: bool | None = None
        self._lock = threading.Lock()  # recipients are served from several threads; the switch is still read once

    def enabled(self) -> bool:
        """Whether the catch-up may send in this run (one read, remembered)."""
        with self._lock:
            if self._enabled is None:
                self._enabled = self._read()
            return self._enabled

    @staticmethod
    def _read() -> bool:
        """The stored switch, False on any doubt."""
        try:
            record = remote_config_store.get_remote_config(live_reminder.SYSTEM_CLIENT_ID, live_reminder.CATCH_UP_FLAG_KEY)
        except Exception as exc:  # noqa: BLE001 -- a read failure must only turn the OPTIONAL catch-up off, never stop the reminders
            print(f"Warning: could not read the late-discovery catch-up switch ({type(exc).__name__}): {exc}; catch-up stays off")
            return False
        value = record.get("value") if isinstance(record, dict) else None
        return isinstance(value, dict) and value.get("enabled") is True


class UnsupportedModeError(ValueError):
    """An event's explicit `mode` this Lambda does not know -- a stale or mistyped schedule target must fail loudly, never
    silently run the reminder job instead."""


def _near_deadline(context: Any) -> bool:
    """Whether the Lambda is within _DEADLINE_MARGIN_MS of its timeout (False without a context)."""
    remaining = getattr(context, "get_remaining_time_in_millis", None)
    return remaining is not None and remaining() < _DEADLINE_MARGIN_MS


def _scheduled_instant(event: dict[str, Any] | None, now: datetime) -> datetime | None:
    """The Scheduler's own scheduledTime for this invocation when it is sane (not in the future, not older than the recovery lookback), else None.

    With it, a delayed or retried invocation serves the minute it was scheduled for instead of the minute it happened to run in.
    """
    raw = (event or {}).get("scheduledTime")
    if not isinstance(raw, str):
        return None
    try:
        scheduled = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if scheduled.tzinfo is None:
        return None
    lag = now - scheduled
    if lag < timedelta(0) or lag > max(_MAX_RECOVERY_LOOKBACK, timedelta(0)):
        return None
    return scheduled


def _evaluation_instants(event: dict[str, Any] | None, now: datetime) -> list[datetime]:
    """The instants this run serves, oldest first, the last being the run's own (see the recovery notes at the top of the module).

    A run at instant `t` serves the reminders whose fire time lies in (t - 1 min, t]. The instants before `t` tile the stretch since the last one
    this container finished (or the single previous minute in a cold container) up to t - 1 min, so consecutive runs leave no gap and a normal
    minute produces exactly one instant.
    """
    anchor = _scheduled_instant(event, now) or now
    lookback = max(_MAX_RECOVERY_LOOKBACK, timedelta(0))
    if lookback == timedelta(0):
        return [anchor]
    anchor_ms = int(anchor.timestamp() * 1000)
    step = int(_REMINDER_WINDOW.total_seconds() * 1000)
    last_ms = _last_served_ms if _last_served_ms is not None else anchor_ms - 2 * step
    last_ms = max(last_ms, anchor_ms - int(lookback.total_seconds() * 1000))
    if anchor_ms - last_ms <= step + int(_RECOVERY_JITTER.total_seconds() * 1000):
        return [anchor]
    limit = anchor_ms - step
    instants: list[datetime] = []
    candidate = last_ms + step
    while True:
        effective = min(candidate, limit)
        if effective <= last_ms:
            break
        instants.append(datetime.fromtimestamp(effective / 1000, tz=timezone.utc))
        if effective == limit:
            break
        candidate += step
    instants.append(anchor)
    return instants


_UNSERVED = object()  # a recipient the run did not start because the Lambda's deadline was close


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Run the new-video slot delivery (`mode: new_video_slots`), or else deliver every due live reminder (and any due simultaneous-livestream notice)."""
    global _last_served_ms
    mode = (event or {}).get("mode")
    if mode == new_video_dispatcher.MODE:
        return new_video_dispatcher.run(event, context)
    if mode is not None:
        raise UnsupportedModeError(f"Unsupported mode {mode!r}; expected {new_video_dispatcher.MODE!r} or omitted")

    now = datetime.now(timezone.utc)
    stream_schedule, pending_notice_ids = _load_schedule(now=now)
    window_ms = int(_REMINDER_WINDOW.total_seconds() * 1000)
    instants = _evaluation_instants(event, now)

    # Creators and the VAPID key are loaded the first time something is actually sent: an idle minute (the common one) loads neither.
    lazy: dict[str, Any] = {}

    def creators_by_id() -> dict[str, Any]:
        """The creator roster, loaded on first use."""
        if "creators" not in lazy:
            lazy["creators"] = {creator.creator_id: creator for creator in load_creators()}
        return lazy["creators"]

    def vapid_credentials() -> tuple[str, dict[str, str]]:
        """The VAPID key and claims, read on first use."""
        if "vapid" not in lazy:
            lazy["vapid"] = get_vapid_credentials()
        return lazy["vapid"]

    catch_up_switch = _CatchUpSwitch()
    checked = 0
    delivered = 0
    unserved = 0
    candidates_total = 0
    failures: list[Exception] = []
    for instant in instants:
        instant_ms = int(instant.timestamp() * 1000)
        recovered = (now - instant) > _RECOVERY_TOLERANCE
        # The late-discovery catch-up is only for the run's own on-time minute; a recovered instant is judged by the (stricter) recovery rules instead.
        due_streams, catch_up_ids = reminder_candidates.due_streams(
            stream_schedule,
            now_ms=instant_ms,
            window_ms=window_ms,
            catch_up_enabled=(lambda: False) if recovered else catch_up_switch.enabled,
        )
        if not due_streams:
            continue
        candidates = reminder_candidates.find_candidates(due_streams, catch_up_ids, now_ms=instant_ms, window_ms=window_ms)
        if not candidates:
            continue
        creators = creators_by_id()
        vapid = vapid_credentials()

        def serve(item: tuple[str, dict[str, live_reminder.ResolvedReminder]], *, instant=instant, recovered=recovered):
            """One candidate client's due reminders; _UNSERVED when the deadline is too close to start it."""
            if _near_deadline(context):
                return _UNSERVED
            client_id, reminders = item
            return _serve_client(
                client_id,
                reminders,
                now=now,
                evaluate_at=instant,
                recovered=recovered,
                creators_by_id=creators,
                vapid=vapid,
                catch_up_switch=catch_up_switch,
            )

        items = list(candidates.items())
        candidates_total += len(items)
        for (client_id, _), result in zip(items, parallel.run_ordered(serve, items, workers=_SEND_WORKERS)):
            if result is _UNSERVED:
                unserved += 1
            elif isinstance(result, BaseException):
                print(f"Warning: reminders for client {client_id!r} failed ({type(result).__name__}): {result}")
                failures.append(result)  # type: ignore[arg-type]
            else:
                checked += result[0]
                delivered += result[1]
    if candidates_total and len(failures) + unserved == candidates_total and failures:
        raise failures[-1]  # nothing worked for anybody: a systemic fault must reach the Lambda's error metric, not hide in a 200
    if unserved:
        print(
            f"Warning: {unserved} due recipient(s) were not started before the Lambda deadline; the next run serves them as recovered reminders "
            f"(an advance reminder with the real time left, a start reminder for {int(_START_RECOVERY_GRACE.total_seconds() // 60)} minutes)"
        )
    else:
        # Only a COMPLETE run moves the container's memory forward; a cut-short one leaves the gap for the next run to cover.
        anchor_ms = int(instants[-1].timestamp() * 1000)
        _last_served_ms = anchor_ms if _last_served_ms is None else max(_last_served_ms, anchor_ms)

    response: dict[str, Any] = {"statusCode": 200, "checked": checked, "delivered": delivered}
    if unserved:
        response["unserved"] = unserved
    if len(instants) > 1:
        response["recoveredInstants"] = len(instants) - 1
    try:
        simultaneous = simultaneous_dispatcher.run(
            stream_schedule,
            pending_ids=pending_notice_ids,
            now=now,
            creators_provider=creators_by_id,
            vapid_provider=vapid_credentials,
            context=context,
        )
    except Exception as exc:  # noqa: BLE001 -- the optional notice must never turn a finished reminder run into a failed one
        print(f"Warning: simultaneous-livestream notices failed ({type(exc).__name__}): {exc}")
        simultaneous = None
    if simultaneous and any(simultaneous.values()):
        response["simultaneous"] = simultaneous
    return response


def _serve_client(
    client_id: str,
    reminders: dict[str, live_reminder.ResolvedReminder],
    *,
    now: datetime,
    creators_by_id: dict[str, Any],
    vapid: tuple[str, dict[str, str]],
    catch_up_switch: _CatchUpSwitch,
    evaluate_at: datetime | None = None,
    recovered: bool = False,
) -> tuple[int, int]:
    """Deliver one candidate client's due reminders. Returns (reminders checked, delivered).

    The client's own stored preference and push subscription are read here -- only for a client whose reminder can be due this minute -- and decide
    everything the schedule cannot: the master switch, per-creator switches, mute, quiet hours, locale and where to send. `evaluate_at` is the
    instant whose on-time window is being served (the run's own, or a recovered earlier one); `recovered` applies the recovery rules.
    """
    preference_record = remote_config_store.get_remote_config(client_id, _NOTIFICATION_PREFERENCE_KEY)
    if preference_record is None:
        return 0, 0  # a reminder item without a stored preference: nothing says the client wants notifications
    try:
        preference = notification_dispatch.parse_notification_preference(preference_record["value"])
    except notification_dispatch.ClientError as exc:
        print(f"Warning: skipping client {client_id!r} with an invalid stored notification preference: {exc}")
        return 0, 0

    subscription_record = remote_config_store.get_remote_config(client_id, _PUSH_SUBSCRIPTION_KEY)
    if subscription_record is None:
        return 0, 0  # nothing to send a reminder to (a client whose global switch is OFF has its subscription removed)
    subscription = subscription_record["value"]
    subscription_updated_at = live_reminder.parse_timestamp(subscription_record.get("updatedAt"))
    preference_updated_at = live_reminder.parse_timestamp(preference_record.get("updatedAt"))
    vapid_private_key, vapid_claims = vapid

    checked = 0
    delivered = 0
    for video_id, resolved_reminder in reminders.items():
        checked += 1
        if _deliver_reminders_if_due(
            video_id,
            resolved_reminder,
            client_id=client_id,
            preference=preference,
            subscription=subscription,
            creators_by_id=creators_by_id,
            now=now,
            vapid_private_key=vapid_private_key,
            vapid_claims=vapid_claims,
            subscription_updated_at=subscription_updated_at,
            catch_up_switch=catch_up_switch,
            evaluate_at=evaluate_at,
            recovered=recovered,
            preference_updated_at=preference_updated_at,
        ):
            delivered += 1
    return checked, delivered


def _read_source_refreshed_at() -> datetime | None:
    """When the shared live/upcoming snapshot was last refreshed (livestream_lifecycle.read_display_refreshed_at -- one tiny heartbeat read), or None
    when that cannot be known: nothing persisted yet, or the store failed. A failure here must never stop reminders, so it only means "unknown",
    and the caller falls back to the time-based rule."""
    try:
        return livestream_lifecycle.read_display_refreshed_at()
    except Exception as exc:  # noqa: BLE001 -- a freshness hint; every failure mode degrades to the interval rule
        print(f"Warning: could not read the live snapshot's freshness ({type(exc).__name__}): {exc}; using the time-based schedule refresh")
        return None


def _stream_schedule_is_current(
    existing: live_reminder.StreamScheduleSnapshot, source_refreshed_at: datetime | None, *, now: datetime
) -> bool:
    """Whether the stored entries still reflect the shared snapshot, so this run can reuse them without re-deriving.

    With the snapshot's freshness known: current exactly when the entries were derived from that very refresh or a later one (a record written
    before the source was tracked is re-derived once). Unknown: the time-based fallback, _SCHEDULE_REFRESH_INTERVAL since the last derivation.
    """
    if source_refreshed_at is None:
        return (now - existing.refreshed_at) < _SCHEDULE_REFRESH_INTERVAL
    if existing.source_refreshed_at is None:
        return False
    return existing.source_refreshed_at >= source_refreshed_at


def _refresh_and_load_stream_schedule(*, now: datetime) -> dict[str, live_reminder.StreamScheduleEntry]:
    """The system-wide "streamSchedule" snapshot's entries (see _load_schedule, which also returns the pending simultaneous-livestream notice ids)."""
    return _load_schedule(now=now)[0]


def _stored_pending_notices(record: dict[str, Any] | None) -> list[str]:
    """The `pendingNotices` ids stored in a "streamSchedule" record (collision ids whose simultaneous-livestream notice is not settled), [] when absent
    or malformed."""
    value = record.get("value") if isinstance(record, dict) else None
    raw = value.get("pendingNotices") if isinstance(value, dict) else None
    return [item for item in raw if isinstance(item, str)] if isinstance(raw, list) else []


def _load_schedule(*, now: datetime) -> tuple[dict[str, live_reminder.StreamScheduleEntry], list[str]]:
    """Return the system-wide "streamSchedule" snapshot's entries and the ids of the pending simultaneous-livestream notices, re-deriving
    them from the existing live/upcoming read path (read_api.get_live_streams,
    which reads the SHARED snapshot -- never Holodex) ONLY when that shared
    snapshot is newer than the one the stored entries came from -- a
    1-minute reminder-evaluation cadence does not mean a 1-minute derivation,
    let alone a 1-minute Holodex cadence. One get_live_streams() call per
    dispatcher run AT MOST, never per client, never per stream.

    A failed read is NOT treated as "no streams": that would wipe
    every stream's reminder capability (overridden and normal alike) on a
    transient outage. Instead it reuses whatever was last successfully
    persisted, same "degrade the item, never take down the batch" posture
    read_api.py itself documents for Holodex failures.
    """
    existing_record = remote_config_store.get_remote_config(live_reminder.SYSTEM_CLIENT_ID, live_reminder.STREAM_SCHEDULE_KEY)
    existing_snapshot: live_reminder.StreamScheduleSnapshot | None = None
    if existing_record is not None:
        try:
            existing_snapshot = live_reminder.parse_stream_schedule_snapshot(existing_record["value"])
        except live_reminder.ClientError as exc:
            print(f"Warning: stored stream schedule is invalid ({exc}); treating as absent")

    # Read BEFORE deriving: if the shared snapshot is refreshed while this run derives, the entries are recorded as coming from the OLDER one
    # and the next run re-derives -- never the reverse (claiming newer data than was actually read).
    source_refreshed_at = _read_source_refreshed_at()
    existing_pending = _stored_pending_notices(existing_record)
    if existing_snapshot is not None and _stream_schedule_is_current(existing_snapshot, source_refreshed_at, now=now):
        return existing_snapshot.entries, existing_pending

    try:
        result = read_api.get_live_streams()
    except (HolodexAPIError, HolodexNormalizationError, MissingHolodexApiKeyError) as exc:
        print(f"Warning: Holodex live-stream fetch failed ({exc}); reusing the last persisted stream schedule")
        # The previous schedule AND its pending notices are reused untouched: a failed refresh destroys and invents nothing.
        return (existing_snapshot.entries if existing_snapshot is not None else {}), existing_pending

    fresh_entries: dict[str, dict[str, Any]] = {}
    for stream in result["streams"]:
        if stream.get("status") == "premiere":
            # read_api.get_live_streams now keeps a still-upcoming YouTube Premiere (status "premiere") instead of dropping it, for
            # the Schedule page -- but it is an uploaded video with a countdown, not a livestream this project reminds anyone about:
            # it never goes "live" here, so it must never enter the reminder schedule (that would fire an ordinary stream-start
            # push for a Premiere's waiting page).
            continue
        start_iso = stream["scheduledStart"] or stream["actualStart"]
        if not start_iso:
            continue
        try:
            scheduled_start_ms = int(datetime.fromisoformat(start_iso).timestamp() * 1000)
        except ValueError:
            continue
        topic = classify_video_topic(stream.get("title") or "")
        fresh_entries[stream["videoId"]] = {
            "creatorId": stream["creatorId"],
            "scheduledStartMs": scheduled_start_ms,
            # None (not "other") when no topic matched: such a stream can only
            # get creator 全部 or a stream override.
            "topic": None if topic == OTHER_TOPIC else topic,
        }
        if isinstance(stream.get("title"), str) and stream["title"].strip():
            fresh_entries[stream["videoId"]]["title"] = stream["title"]  # the original title, shown as the notification body
        if isinstance(stream.get("status"), str) and stream["status"]:
            fresh_entries[stream["videoId"]]["status"] = stream["status"]  # only a still-"upcoming" stream can get a late-discovery catch-up

    fresh_value: dict[str, Any] = {"entries": fresh_entries, "refreshedAt": now.isoformat()}
    # When each stream's CURRENT start was first observed (and its earlier starts), for the late-discovery catch-up: derived from the PREVIOUS record,
    # so it is computed on every derivation and carried forward. It never changes which streams or start times are scheduled.
    fresh_value[live_reminder.FIRST_SEEN_KEY] = live_reminder.first_seen_to_value(
        live_reminder.derive_first_seen(
            previous=existing_snapshot,
            entries=fresh_entries,
            observed_at=source_refreshed_at,
            now=now,
            max_source_gap=_FIRST_SEEN_MAX_SOURCE_GAP,
        )
    )
    if source_refreshed_at is not None:
        fresh_value["sourceRefreshedAt"] = source_refreshed_at.isoformat()
    # A monotonic revision (the shared snapshot's own refresh time, else this derivation's clock): the write below only lands if nothing at least this
    # new is stored, so an older, overlapping run can never overwrite newer schedule state.
    revision = int((source_refreshed_at or now).timestamp() * 1000)
    fresh_value["revision"] = revision
    fresh_snapshot = live_reminder.parse_stream_schedule_snapshot(fresh_value)
    # 同時開播預告: a collision that is NEW compared with the schedule being replaced gets its pending ledger BEFORE the new schedule is written, so a crash
    # in between cannot lose the notice (the next derivation still sees the same difference and finds the ledger there). The ids still waiting for their
    # notice are listed in the record itself, which the dispatcher reads every minute anyway: with none pending nothing else is ever read for this.
    try:
        new_notice_ids = simultaneous_dispatcher.register_new_collisions(
            existing_snapshot.entries if existing_snapshot is not None else None, fresh_snapshot.entries, now=now
        )
        fresh_value["pendingNotices"] = simultaneous_dispatcher.next_pending(existing_pending, new_notice_ids, fresh_snapshot.entries, now=now)
    except Exception as exc:  # noqa: BLE001 -- the optional notice must never fail the schedule refresh itself
        print(f"Warning: could not register simultaneous-livestream notices ({type(exc).__name__}): {exc}")
        fresh_value["pendingNotices"] = existing_pending
    record = remote_config_api.write_remote_config(
        {"clientId": live_reminder.SYSTEM_CLIENT_ID, "key": live_reminder.STREAM_SCHEDULE_KEY, "value": fresh_value}
    )
    if not remote_config_store.put_remote_config_if_newer(record, revision=revision):
        print("Warning: a newer stream schedule was already stored by an overlapping run; using that one")
        newer = remote_config_store.get_remote_config(live_reminder.SYSTEM_CLIENT_ID, live_reminder.STREAM_SCHEDULE_KEY)
        if newer is not None:
            try:
                return live_reminder.parse_stream_schedule_snapshot(newer["value"]).entries, _stored_pending_notices(newer)
            except live_reminder.ClientError:
                pass  # unusable: fall through to what this run derived
        return fresh_snapshot.entries, list(fresh_value["pendingNotices"])
    # The schedule changed: a simultaneous-livestream notice whose collision is gone (cancelled, rescheduled, a member added or removed) is
    # invalidated. An identical schedule has no such collision and costs nothing here.
    try:
        simultaneous_dispatcher.invalidate_removed(existing_snapshot.entries if existing_snapshot is not None else {}, fresh_snapshot.entries)
    except Exception as exc:  # noqa: BLE001 -- cleanup of derived state must never fail the schedule refresh itself
        print(f"Warning: could not invalidate superseded simultaneous-livestream notices ({type(exc).__name__}): {exc}")
    return fresh_snapshot.entries, list(fresh_value["pendingNotices"])


def _resolve_reminders_for_client(
    client_id: str, stream_schedule: dict[str, live_reminder.StreamScheduleEntry]
) -> dict[str, live_reminder.ResolvedReminder]:
    """Every (videoId -> fully-resolved reminder) pair this client has a
    reminder for this run.

    Loads the client's stored reminder items (one remote-config item per
    setting -- see live_reminder.py) and, for each stream in the system-wide
    schedule, resolves the one setting that applies: per-stream override >
    creator 全部 > creator + the stream's topic > unset
    (live_reminder.resolve_effective_setting). A stream with no applicable
    setting is simply absent from the result (unset = no reminder). The
    CURRENT scheduledStartMs always comes from stream_schedule, never from a
    stored setting. A stored item that fails validation is skipped and logged;
    it never affects the client's other settings.
    """
    creator_records = remote_config_store.list_remote_config_by_prefix(client_id, live_reminder.CREATOR_REMINDER_KEY_PREFIX)
    override_records = remote_config_store.list_remote_config_by_prefix(client_id, live_reminder.STREAM_OVERRIDE_KEY_PREFIX)
    settings = live_reminder.parse_reminder_settings(creator_records, override_records)
    for key in settings.invalid_keys:
        print(f"Warning: skipping invalid stored reminder item {key!r} for client {client_id!r}")

    resolved: dict[str, live_reminder.ResolvedReminder] = {}
    for video_id, schedule_entry in stream_schedule.items():
        setting = live_reminder.resolve_effective_setting(
            video_id=video_id, creator_id=schedule_entry.creator_id, topic=schedule_entry.topic, settings=settings
        )
        if setting is None:
            continue
        resolved[video_id] = live_reminder.ResolvedReminder(
            creator_id=schedule_entry.creator_id,
            scheduled_start_ms=schedule_entry.scheduled_start_ms,
            setting=setting,
            stream_title=schedule_entry.title,
            status=schedule_entry.status,
            first_seen=schedule_entry.first_seen,
        )
    return resolved


def _recovery_allows(kind: str, start_ms: int, fire_at_ms: int | None, now_ms: int, saved_at: tuple[datetime | None, ...]) -> bool:
    """Whether a reminder whose on-time minute was NOT served may still go out now (a recovered reminder).

    It must still be true: an advance reminder needs at least live_reminder.CATCH_UP_MIN_REMAINING_MS before the start (it is worded with the real time
    left); a start reminder is sent until _START_RECOVERY_GRACE after the start. And it must have been in place when it came due: every timestamp in
    `saved_at` (the setting, the push subscription, the notification preference) must be known and not later than the fire time, so enabling or
    editing anything afterwards never replays a reminder that already came due.
    """
    if fire_at_ms is None:
        return False
    if kind == notification_text.KIND_ADVANCE:
        if now_ms > start_ms - live_reminder.CATCH_UP_MIN_REMAINING_MS:
            return False
    elif now_ms >= start_ms + int(_START_RECOVERY_GRACE.total_seconds() * 1000):
        return False
    return all(moment is not None and int(moment.timestamp() * 1000) <= fire_at_ms for moment in saved_at)


def _deliver_reminders_if_due(
    video_id: str,
    override: live_reminder.ResolvedReminder,
    *,
    client_id: str,
    preference: notification_dispatch.NotificationPreference,
    subscription: Any,
    creators_by_id: dict[str, Any],
    now: datetime,
    vapid_private_key: str,
    vapid_claims: dict[str, str],
    subscription_updated_at: datetime | None = None,
    catch_up_switch: _CatchUpSwitch | None = None,
    evaluate_at: datetime | None = None,
    recovered: bool = False,
    preference_updated_at: datetime | None = None,
) -> bool:
    """Send whichever of this stream's start/advance reminders are currently
    due for one client. Both are evaluated independently: a single stream can
    legitimately send both in the same run. Returns whether anything was sent.

    A third, optional moment exists for a stream discovered AFTER its advance reminder's time: the late-discovery catch-up
    (_deliver_catch_up_advance_if_due, off unless the kill switch says otherwise). It is a separate branch below; the on-time advance and start
    branches are exactly what they always were and never consult the catch-up or its switch.

    Suppression: the global notifications switch being OFF or a disabled
    creator blocks both (a creator override can never re-enable a client whose
    global switch is OFF); a temporary mute or quiet
    hours block a reminder if they apply EITHER at the moment that reminder
    was meant to fire OR right now -- the reminder is skipped, never delayed
    and never replayed (a late "10 minutes before" is wrong), and nothing is
    recorded for it, so it cannot fire later either. Browser push permission
    does not enter into it: mute is a product-level preference that wins.

    `evaluate_at` is the instant whose on-time window is being served (default: now). When it is earlier than now by more than the recovery
    tolerance the run is RECOVERING a minute nobody served (`recovered`): the reminder is then sent only while still true and only if the setting,
    the subscription and the preference were all saved before its fire time -- see _recovery_allows and the recovery notes at the top of the module.
    """
    if not notification_dispatch.should_notify_now(preference, override.creator_id, now=now):
        return False

    now_ms = int(now.timestamp() * 1000)
    eval_ms = int((evaluate_at or now).timestamp() * 1000)
    window_ms = int(_REMINDER_WINDOW.total_seconds() * 1000)
    setting = override.setting
    start_ms = override.scheduled_start_ms
    sent_any = False
    advance_fire_at_ms = live_reminder.advance_reminder_fire_at_ms(setting, start_ms)
    saved_at = (setting.updated_at, subscription_updated_at, preference_updated_at)
    if (
        live_reminder.is_advance_reminder_due(setting, start_ms, now_ms=eval_ms, window_ms=window_ms)
        and not _suppressed_at(preference, override.creator_id, advance_fire_at_ms)
        and (not recovered or _recovery_allows(notification_text.KIND_ADVANCE, start_ms, advance_fire_at_ms, now_ms, saved_at))
    ):
        if _send_reminder(
            video_id,
            notification_text.KIND_ADVANCE,
            scheduled_start_ms=start_ms,
            advance=setting.advance_reminder,
            stream_title=override.stream_title,
            locale=preference.locale,
            client_id=client_id,
            creator_id=override.creator_id,
            creators_by_id=creators_by_id,
            subscription=subscription,
            now=now,
            vapid_private_key=vapid_private_key,
            vapid_claims=vapid_claims,
            remaining_minutes=live_reminder.catch_up_remaining_minutes(start_ms, now_ms) if recovered else None,
        ):
            sent_any = True
    try:
        # The late-discovery catch-up belongs to the run's own on-time minute only; a recovered instant is judged by _recovery_allows instead.
        catch_up_sent = False if recovered else _deliver_catch_up_advance_if_due(
            video_id,
            override,
            client_id=client_id,
            preference=preference,
            subscription=subscription,
            creators_by_id=creators_by_id,
            now=now,
            window_ms=window_ms,
            vapid_private_key=vapid_private_key,
            vapid_claims=vapid_claims,
            subscription_updated_at=subscription_updated_at,
            catch_up_switch=catch_up_switch,
        )
    except Exception as exc:  # noqa: BLE001 -- the catch-up is optional and new: whatever goes wrong in it must never stop the on-time and start reminders after it
        print(f"Warning: late-discovery catch-up failed for video {video_id!r} ({type(exc).__name__}): {exc}")
        catch_up_sent = False
    if catch_up_sent:
        sent_any = True
    if (
        live_reminder.is_start_reminder_due(setting, start_ms, now_ms=eval_ms, window_ms=window_ms)
        and not _suppressed_at(preference, override.creator_id, start_ms)
        and (not recovered or _recovery_allows(notification_text.KIND_START, start_ms, start_ms, now_ms, saved_at))
    ):
        if _send_reminder(
            video_id,
            notification_text.KIND_START,
            scheduled_start_ms=start_ms,
            advance=None,
            stream_title=override.stream_title,
            locale=preference.locale,
            client_id=client_id,
            creator_id=override.creator_id,
            creators_by_id=creators_by_id,
            subscription=subscription,
            now=now,
            vapid_private_key=vapid_private_key,
            vapid_claims=vapid_claims,
        ):
            sent_any = True
    return sent_any


def _deliver_catch_up_advance_if_due(
    video_id: str,
    override: live_reminder.ResolvedReminder,
    *,
    client_id: str,
    preference: notification_dispatch.NotificationPreference,
    subscription: Any,
    creators_by_id: dict[str, Any],
    now: datetime,
    window_ms: int,
    vapid_private_key: str,
    vapid_claims: dict[str, str],
    subscription_updated_at: datetime | None,
    catch_up_switch: _CatchUpSwitch | None,
) -> bool:
    """The late-discovery catch-up: ONE advance reminder, worded with the actual minutes left, for a stream that only became known after its advance
    reminder's time (docs/late-discovery-advance-catch-up.md). Returns whether it was sent.

    The checks run cheapest first, and each can only say no:

    1. live_reminder.is_advance_catch_up_due -- pure clock / first-seen / saved-before-the-fire-time rules; everything else is skipped until it passes;
    2. mute or quiet hours at the ORIGINAL fire time (the caller already checked "right now"), exactly like the on-time reminder;
    3. the kill switch (_CatchUpSwitch) -- BEFORE any delivery-log read, so a switched-off catch-up costs no BatchGetItem and writes nothing, and can
       still send later (the minutes-left cutoff keeps that honest);
    4. the earlier-reminder guard (_earlier_advance_reminder_handled): no catch-up for a stream this client already had an advance reminder handled for;
    5. the shared atomic claim in _send_reminder -- the very same dedupe id as the on-time advance reminder for this start, so the two can never both
       send, and overlapping runs or retries collapse into one delivery. A failed push releases the claim, so the next minute retries until the
       minutes-left cutoff.
    """
    start_ms = override.scheduled_start_ms
    now_ms = int(now.timestamp() * 1000)
    if not live_reminder.is_advance_catch_up_due(
        override.setting,
        start_ms,
        now_ms=now_ms,
        window_ms=window_ms,
        status=override.status,
        first_seen=override.first_seen,
        subscription_updated_at=subscription_updated_at,
    ):
        return False
    if _suppressed_at(preference, override.creator_id, live_reminder.advance_reminder_fire_at_ms(override.setting, start_ms)):
        return False
    if catch_up_switch is None or not catch_up_switch.enabled():
        return False
    if _earlier_advance_reminder_handled(video_id, override.first_seen, client_id=client_id, now=now):
        return False
    remaining_minutes = live_reminder.catch_up_remaining_minutes(start_ms, now_ms)
    sent = _send_reminder(
        video_id,
        notification_text.KIND_ADVANCE,
        scheduled_start_ms=start_ms,
        advance=override.setting.advance_reminder,
        stream_title=override.stream_title,
        locale=preference.locale,
        client_id=client_id,
        creator_id=override.creator_id,
        creators_by_id=creators_by_id,
        subscription=subscription,
        now=now,
        vapid_private_key=vapid_private_key,
        vapid_claims=vapid_claims,
        remaining_minutes=remaining_minutes,
    )
    if sent:
        print(f"Late-discovery catch-up advance reminder sent for video {video_id!r} ({remaining_minutes} minutes before its start)")
    return sent


def _earlier_advance_reminder_handled(video_id: str, first_seen: live_reminder.FirstSeen | None, *, client_id: str, now: datetime) -> bool:
    """Whether this client already had an advance reminder handled for an EARLIER start of this stream -- then no catch-up (R2).

    Each start minute is its own dedupe target, so a rescheduled stream's earlier reminder is invisible to the shared claim. The earlier start
    minutes come from the stream's FirstSeen (priorStartMinutes) and are read in one uncached BatchGetItem together with the legacy id older
    deployments used; a delivered row or a live claim counts as handled.

    LIMIT (by design): FirstSeen keeps only the last live_reminder.MAX_PRIOR_START_MINUTES earlier starts, so for a stream rescheduled more often than
    that the oldest start is forgotten and an advance reminder delivered for it is NOT found here. Fails closed: a store error counts as handled.
    """
    ids = {f"{video_id}:reminder:{notification_text.KIND_ADVANCE}"}
    ids.update(f"{video_id}:reminder:{notification_text.KIND_ADVANCE}@{minute}" for minute in (first_seen.prior_start_minutes if first_seen else ()))
    try:
        return bool(notification_delivery_log_store.handled_ids(client_id, ids, now=now))
    except Exception as exc:  # noqa: BLE001 -- the catch-up is optional: when the guard cannot be read it must not send
        print(f"Warning: could not check earlier advance reminders for video {video_id!r} ({type(exc).__name__}): {exc}; no catch-up")
        return True


def _suppressed_at(preference: notification_dispatch.NotificationPreference, creator_id: str, instant_ms: int | None) -> bool:
    """Whether a temporary mute or quiet hours applied at the given instant (epoch ms)."""
    if instant_ms is None:
        return False
    instant = datetime.fromtimestamp(instant_ms / 1000, tz=timezone.utc)
    return not notification_dispatch.should_notify_now(preference, creator_id, now=instant)


def _reminder_dedupe_ids(video_id: str, kind: str, scheduled_start_ms: int) -> tuple[str, str]:
    """(the id one reminder TARGET is deduped under, the legacy id older deployments used).

    A target is a reminder kind for one specific scheduled start, to the MINUTE (the dispatcher's own resolution, so a few seconds of jitter in a
    reported start can never mint a new target): a stream rescheduled to another time is a NEW target, so a delivery made for the superseded time
    neither blocks the new one nor can ever fire again (the old start is never due once the stored schedule has moved), while retries, overlapping
    runs and a redeploy of the SAME target still collapse into one delivery. The legacy id (no start time) is honoured only while its row is
    fresh (_LEGACY_DEDUPE_WINDOW): that is exactly "an older version just sent this for the current start" -- the redeploy minute -- and never a
    stale row that would wrongly block a reschedule.
    """
    legacy_id = f"{video_id}:reminder:{kind}"
    return f"{legacy_id}@{scheduled_start_ms // 60_000}", legacy_id


def _reminder_ttl_seconds(kind: str, scheduled_start_ms: int, now: datetime) -> int:
    """The push TTL for a reminder: a start reminder lives a short grace past the scheduled start, an advance reminder only until it (push_ttl)."""
    if kind == notification_text.KIND_START:
        return push_ttl.start_reminder_ttl_seconds(scheduled_start_ms=scheduled_start_ms, now=now)
    return push_ttl.advance_reminder_ttl_seconds(scheduled_start_ms=scheduled_start_ms, now=now)


def _send_reminder(
    video_id: str,
    kind: str,
    *,
    scheduled_start_ms: int,
    advance: str | None,
    stream_title: str | None,
    locale: str,
    client_id: str,
    creator_id: str,
    creators_by_id: dict[str, Any],
    subscription: Any,
    now: datetime,
    vapid_private_key: str,
    vapid_claims: dict[str, str],
    remaining_minutes: int | None = None,
) -> bool:
    """Send one (start or advance) reminder moment, deduped independently of
    every other reminder kind/video/target (spec section 9: clientId + videoId
    + reminder kind, here also the scheduled start the reminder is for -- see
    _reminder_dedupe_ids) by reusing notification_delivery_log_store's existing
    claimed/delivered state machine against a composite dedupe id, rather
    than a second delivery-history table -- this can never collide with that
    same store's real videoId-only rows (the discovery-notification dedupe
    above), since a real videoId never contains ":reminder:".

    The claim is an atomic conditional write made BEFORE the push is sent, so
    two overlapping dispatcher runs (or an EventBridge retry) can never both
    send; a send that fails releases the claim so a retry inside the reminder
    window can still deliver, and a confirmed delivery is permanent.
    """
    dedupe_id, legacy_id = _reminder_dedupe_ids(video_id, kind, scheduled_start_ms)
    if notification_delivery_log_store.handled_within(client_id, legacy_id, _LEGACY_DEDUPE_WINDOW, now=now):
        return False
    if notification_delivery_log_store.already_delivered(client_id, dedupe_id):
        return False
    if not notification_delivery_log_store.mark_delivered(client_id, dedupe_id, now.isoformat()):
        return False

    creator = creators_by_id.get(creator_id)
    text = notification_text.reminder_notification(
        locale=locale,
        kind=kind,
        advance=advance,
        creator_name=creator.display_name if creator else None,
        stream_title=stream_title,
        remaining_minutes=remaining_minutes,
    )
    # One immediate re-send after a plausibly transient failure (a transport error, 429/5xx); the reminder's own window is a minute, so a longer
    # retry would only be late. A failure that persists releases the claim below, exactly as before.
    result = push_sender.send_with_bounded_retry(
        subscription,
        title=text.title,
        body=text.body,
        data=notification_payload.notification_data(
            {"videoId": video_id, "reminderKind": kind}, video_id=video_id, creator_id=creator_id, creators_by_id=creators_by_id
        ),
        vapid_private_key=vapid_private_key,
        vapid_claims=vapid_claims,
        ttl_seconds=_reminder_ttl_seconds(kind, scheduled_start_ms, now),
    )
    if result.subscription_expired:
        print(f"Push subscription expired for client {client_id!r}; leaving cleanup to a future pass")
        notification_delivery_log_store.release_claim(client_id, dedupe_id)
        return False
    if not result.sent:
        print(f"Warning: reminder push send failed for client {client_id!r}, video {video_id!r} ({kind}): {result.error}")
        notification_delivery_log_store.release_claim(client_id, dedupe_id)
        return False

    try:
        notification_delivery_log_store.confirm_delivered(client_id, dedupe_id, now.isoformat())
    except notification_delivery_log_store.NotificationDeliveryLogStoreError as exc:
        # The push already went out: the claim simply stays (it expires) -- the safe side, never a resend, and never a failed run for everyone else.
        print(f"Warning: could not confirm the reminder delivery for client {client_id!r}, video {video_id!r} ({kind}): {exc}")
    return True
