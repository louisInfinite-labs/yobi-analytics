"""同時開播預告 delivery: the part of the shared notification dispatcher that tells an opted-in client that several creators it follows are
scheduled to start at exactly the same time. The pure rules (what a collision is, who it is relevant to, the ledger's shape) are in
simultaneous_live.py; this module does the storage and the sending.

TRIGGERED BY SCHEDULE CHANGES, never polled, and with no time window of its own. The notice follows the existing ~10-minute Holodex refresh: when the
dispatcher re-derives its "streamSchedule" (only when the shared snapshot is newer; nothing here adds a refresh or a poll) it compares the collisions of
the previous and the new schedule IN MEMORY (simultaneous_live.detect_collisions). A collision that is NEW (A+B when B is discovered, A+B+C when C is
discovered, a stream rescheduled onto a group) gets a PROGRESS LEDGER (register_new_collisions) and is notified at once -- 20:55 for a 21:00 start is as
eligible as a discovery a day ahead. The only limit is the scheduled start: nothing is sent once it has passed. An unchanged schedule has no new
collision, so this module performs NO DynamoDB read or write at all; a removed one costs one ledger delete.

PENDING work is found without polling: the ids of collisions whose notice is not settled yet ride in the "streamSchedule" record the dispatcher already
reads every minute (`pendingNotices`, rewritten by the derivation that writes the record anyway). With none listed nothing is read -- not even by a cold
container. A listed one is read (its ledger) only when its next retry or its end-of-suppression is due.

Recipients of a new collision, per client (nothing is stored about them beyond the client's own retry state):

1. the clients that opted in (the sparse OPT_IN_KEY item, DEFAULT OFF; one configKey-index Query), intersected with the followers of the member
   creators (the reminder items themselves are the subscription edges: one configKey-index Query per creator / topic / stream, never a scan and never
   per client), kept only when at least two distinct creators have live notifications enabled for them. Nothing is queried when nobody opted in.
2. each client's notice is keyed by ITS OWN relevant streams and the exact start (notice_key): a client that only follows A+B has the same key for the
   A+B and the A+B+C collision, so it is notified once; a client following A+C becomes eligible when C is discovered; one following A+B+C is told about
   the expanded group. The delivery-log row is checked first (already delivered = done), then opt-in, preference and push subscription are re-read (an
   opt-out, a master-OFF, a muted or quiet-hours client is respected at the moment of sending), the notice is CLAIMED atomically, pushed (one immediate
   retry for a plausibly transient failure) and confirmed or released.
3. a transient failure is retried after a delay, at most MAX_ATTEMPTS in total; a muted or quiet client is looked at again exactly when its
   suppression ends (never polled every minute) as long as the start has not passed; a held claim is waited for. Concurrent dispatcher runs are
   serialised per collision by a compare-and-set LEASE; a pass that reaches the Lambda's deadline records a CURSOR and the next pass resumes after it; a
   crashed pass loses only its progress, because the delivery log skips everyone already served.

A collision removed or changed by a later refresh gets its ledger deleted (invalidate_removed) and, because delivery always works from the CURRENT
collisions, can no longer be delivered even if that cleanup failed. A refresh that FAILS keeps the previous schedule and its pending notices untouched.

DELIVERY AMBIGUITY, unavoidable with Web Push: the push service accepting a message does not prove the browser showed it, and a crash between "the push
service accepted it" and "the delivery log says delivered" leaves a claim that expires (20 minutes) and is then attempted again -- at-least-once, never
silently lost, at the price of a possible duplicate in that one narrow case. Everything else (overlapping runs, retries, redeploys) collapses into one
notification per client and relevant creator/stream group through the claim.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterable, Mapping
from zoneinfo import ZoneInfo

from notifications import live_reminder
from notifications import notification_dispatch
from notifications import notification_payload
from notifications import notification_text
from notifications import parallel
from notifications import push_sender
from notifications import push_ttl
from notifications import simultaneous_live as sim
from stores import notification_delivery_log_store
from stores import remote_config_store

_PREFERENCE_KEY = "notificationPreference"
_PUSH_SUBSCRIPTION_KEY = "pushSubscription"
_SCHEDULE_PATH = "/schedule"  # where a click on the notice goes: the existing Schedule page's 24-hour timeline

# Stop starting new clients this close to the Lambda's deadline (a client in flight needs up to 2 pushes x 10 s plus its DynamoDB calls); the cursor
# records how far the pass got and the next run resumes after it.
_DEADLINE_MARGIN_MS = 30_000

# Recipients are attempted in chunks of this many threads' worth (notifications/parallel.py): one at a time, thousands of recipients would need many
# invocations. A chunk finishes completely before the cursor moves past it, so the cursor is always exact.
_ATTEMPT_WORKERS = parallel.DEFAULT_WORKERS

# Per warm container: collisions known to be settled (never read again) and, for a pending ledger, the earliest instant it is worth reading again.
_settled: set[str] = set()
_next_check_ms: dict[str, int] = {}


def reset_cache() -> None:
    """Forget this container's memory of settled / waiting collisions (tests, and nothing else)."""
    _settled.clear()
    _next_check_ms.clear()


@dataclass(frozen=True)
class _Outcome:
    """What one attempt to notify one client came to: `done` (delivered or dropped for good) or `again` (the work item to keep)."""

    kind: str  # "delivered" | "dropped" | "again" | "gave_up"
    work: sim.WorkItem | None = None
    reason: str = ""


def _near_deadline(context: Any) -> bool:
    """Whether the Lambda is within _DEADLINE_MARGIN_MS of its timeout (False without a context)."""
    remaining = getattr(context, "get_remaining_time_in_millis", None)
    return remaining is not None and remaining() < _DEADLINE_MARGIN_MS


def _record(collision: sim.Collision, ledger: sim.Ledger, now: datetime) -> dict[str, Any]:
    """The remote-config record of one ledger write."""
    return {
        "clientId": live_reminder.SYSTEM_CLIENT_ID,
        "key": sim.ledger_key(collision.collision_id),
        "value": sim.ledger_to_value(ledger, collision),
        "updatedAt": now.isoformat(),
    }


def run(
    entries: Mapping[str, live_reminder.StreamScheduleEntry],
    *,
    pending_ids: Iterable[str],
    now: datetime,
    creators_provider: Callable[[], Mapping[str, Any]],
    vapid_provider: Callable[[], tuple[str, dict[str, str]]],
    context: Any = None,
) -> dict[str, int]:
    """Process the collisions whose notice is PENDING (`pending_ids`, from the schedule record) and due. Returns {"collisions", "delivered", "dropped",
    "pending"}.

    With nothing pending this does nothing and reads nothing. A pending id whose collision is no longer upcoming in `entries` (cancelled, rescheduled,
    started) is ignored: nothing is ever sent for it. `creators_provider` and `vapid_provider` are only called when a collision is actually processed.
    Never raises for one collision's failure: the rest still run and the failed one is simply looked at again by the next run.
    """
    now_ms = int(now.timestamp() * 1000)
    ids = sorted(set(pending_ids))
    stats = {"collisions": 0, "delivered": 0, "dropped": 0, "pending": 0}
    current = sim.detect_collisions(entries, now_ms=now_ms) if ids else {}
    # This container's memory is only valid while the schedule record still lists the id: once the next derivation drops it, a LATER pending episode
    # of the same collision (it disappeared and came back) must be judged afresh, not skipped as "settled" from an earlier one.
    for cache_id in [cid for cid in (*_settled, *_next_check_ms) if cid not in current or cid not in ids]:
        _settled.discard(cache_id)
        _next_check_ms.pop(cache_id, None)
    if not ids:
        return stats
    todo = [current[cid] for cid in ids if cid in current and cid not in _settled and now_ms >= _next_check_ms.get(cid, 0)]
    if not todo:
        return stats

    vapid: tuple[str, dict[str, str]] | None = None
    creators_by_id: Mapping[str, Any] | None = None
    for collision in todo:
        if _near_deadline(context):
            print("Warning: stopping simultaneous-livestream notices before the Lambda deadline; the rest are served by the next run")
            break
        try:
            if vapid is None:
                vapid = vapid_provider()
            if creators_by_id is None:
                creators_by_id = creators_provider()
            counts = _process_collision(collision, entries, now=now, creators_by_id=creators_by_id, vapid=vapid, context=context)
        except Exception as exc:  # noqa: BLE001 -- one collision's trouble must never stop the reminders or the other collisions; it is retried next run
            print(f"Warning: simultaneous-livestream notice {collision.collision_id!r} failed ({type(exc).__name__}): {exc}")
            continue
        if counts is None:
            continue
        stats["collisions"] += 1
        stats["delivered"] += counts[0]
        stats["dropped"] += counts[1]
        stats["pending"] += counts[2]
    return stats


def register_new_collisions(
    previous: Mapping[str, live_reminder.StreamScheduleEntry] | None,
    fresh: Mapping[str, live_reminder.StreamScheduleEntry],
    *,
    now: datetime,
) -> list[str]:
    """The collisions that are NEW in `fresh` compared with `previous` (the schedule the refresh replaced), each given a pending ledger. Returns their ids.

    Called by the schedule derivation BEFORE it writes the new schedule record, so a crash in between leaves the ledger behind and the next derivation --
    which still sees the same difference -- simply finds it already there; it can never lose a notice. A first-ever schedule (`previous` is None) is the
    baseline: nothing that already existed is announced. Only upcoming collisions count (a started one is never announced). An unchanged schedule has
    no new collision and performs no write. A failed ledger write is logged and the id is still returned: the pass that processes it creates the ledger.
    """
    if previous is None:
        return []
    now_ms = int(now.timestamp() * 1000)
    before = sim.detect_collisions(previous, now_ms=None)
    known: dict[int, set[tuple[str, str]]] = {}
    for old_collision in before.values():
        known.setdefault(old_collision.start_second, set()).update(old_collision.members)
    # NEW means the group brings something that was not part of any collision at that start before: a stream joined it, two streams came to share the start,
    # a stream was rescheduled onto it. A group that merely SHRANK (A+B+C -> A+B after C was cancelled or dropped out) tells nobody anything new, so it is not
    # announced and costs no lookup.
    new = [
        collision
        for cid, collision in sorted(sim.detect_collisions(fresh, now_ms=now_ms).items())
        if cid not in before and any(member not in known.get(collision.start_second, ()) for member in collision.members)
    ]
    for collision in new:
        _settled.discard(collision.collision_id)  # a new episode of this id (it vanished and returned): never trust an earlier "settled"
        _next_check_ms.pop(collision.collision_id, None)
        try:
            remote_config_store.put_remote_config_versioned(_record(collision, sim.Ledger(version=1), now), expected_version=None)  # False: it exists already
        except Exception as exc:  # noqa: BLE001 -- the processing pass creates a missing ledger
            print(f"Warning: could not create the ledger of new notice {collision.collision_id!r} ({type(exc).__name__}): {exc}")
    return [collision.collision_id for collision in new]


def next_pending(
    previous_pending: Iterable[str],
    new_ids: Iterable[str],
    fresh: Mapping[str, live_reminder.StreamScheduleEntry],
    *,
    now: datetime,
) -> list[str]:
    """The ids to list as pending in the schedule record being written: the new collisions, plus the earlier pending ones that are still upcoming and
    whose ledger is not settled. Only an earlier pending id costs a read (its ledger, skipped when this container already knows it settled); with
    none pending this reads nothing."""
    current = sim.detect_collisions(fresh, now_ms=int(now.timestamp() * 1000))
    keep = {cid for cid in new_ids if cid in current}
    for collision_id in previous_pending:
        if collision_id in keep or collision_id not in current or collision_id in _settled:
            continue
        try:
            stored = remote_config_store.get_remote_config(live_reminder.SYSTEM_CLIENT_ID, sim.ledger_key(collision_id))
        except Exception as exc:  # noqa: BLE001 -- unknown: stay pending, the processing pass finds out
            print(f"Warning: could not read the ledger of pending notice {collision_id!r} ({type(exc).__name__}): {exc}")
            keep.add(collision_id)
            continue
        ledger = sim.parse_ledger(stored["value"]) if stored is not None else None
        if ledger is None or ledger.state != sim.STATE_SETTLED:
            if stored is not None:
                keep.add(collision_id)
        else:
            _settled.add(collision_id)
    return sorted(keep)


def _process_collision(
    collision: sim.Collision,
    entries: Mapping[str, live_reminder.StreamScheduleEntry],
    *,
    now: datetime,
    creators_by_id: Mapping[str, Any],
    vapid: tuple[str, dict[str, str]],
    context: Any,
) -> tuple[int, int, int] | None:
    """One pass over one collision. Returns (delivered, dropped, still pending) of THIS pass, or None when it did nothing (settled, not due, lease
    held by another pass, or a lost compare-and-set)."""
    now_ms = int(now.timestamp() * 1000)
    collision_id = collision.collision_id
    stored = remote_config_store.get_remote_config(live_reminder.SYSTEM_CLIENT_ID, sim.ledger_key(collision_id))
    ledger = sim.parse_ledger(stored["value"]) if stored is not None else None
    if stored is not None and ledger is None:
        print(f"Warning: unusable ledger for simultaneous-livestream notice {collision_id!r}; starting it over")
        remote_config_store.delete_remote_config(live_reminder.SYSTEM_CLIENT_ID, sim.ledger_key(collision_id))
    if ledger is not None and ledger.state == sim.STATE_SETTLED:
        _settled.add(collision_id)
        return None
    if ledger is not None and ledger.lease_until_ms > now_ms:
        return None  # another dispatcher pass owns this collision right now
    if ledger is not None and ledger.resolved:
        due_at = min((item.next_at_ms for item in ledger.work.values()), default=0)
        if due_at > now_ms:
            _next_check_ms[collision_id] = due_at  # nothing to do before then; do not read it again until then
            return None

    base = ledger or sim.Ledger(version=0)
    leased = replace(base, version=base.version + 1, lease_until_ms=now_ms + sim.LEASE_MS)
    if not remote_config_store.put_remote_config_versioned(
        _record(collision, leased, now), expected_version=ledger.version if ledger is not None else None
    ):
        return None  # lost the race for this collision to another pass

    work = dict(leased.work)
    queue: dict[str, tuple[sim.WorkItem, bool]] = {}  # clientId -> (item, a first attempt found by resolution rather than an open retry)
    if not leased.resolved:
        for client_id, item in _resolve_recipients(collision, entries, now_ms=now_ms).items():
            if (leased.cursor is None or client_id > leased.cursor) and client_id not in work:
                queue[client_id] = (item, True)
    for client_id, item in work.items():
        if item.next_at_ms <= now_ms:
            queue[client_id] = (item, False)

    delivered = dropped = gave_up = 0
    cursor = leased.cursor
    stopped = False
    ordered = sorted(queue.items())
    chunk_size = max(_ATTEMPT_WORKERS, 1)  # one round of attempts per chunk, so the deadline is checked between rounds
    for offset in range(0, len(ordered), chunk_size):
        if _near_deadline(context):
            print(f"Warning: stopping notice {collision_id!r} before the Lambda deadline; the next run resumes after {cursor!r}")
            stopped = True
            break
        chunk = ordered[offset : offset + chunk_size]
        outcomes = parallel.run_ordered(
            lambda entry: _attempt_safely(entry[0], entry[1][0], collision, entries, now=now, creators_by_id=creators_by_id, vapid=vapid),
            chunk,
            workers=_ATTEMPT_WORKERS,
        )
        for (client_id, (item, fresh)), outcome in zip(chunk, outcomes):
            if isinstance(outcome, BaseException):  # _attempt_safely never raises for an Exception; kept so one surprise cannot lose the chunk's others
                outcome = _retry_or_give_up(item, now, sim.REASON_SEND_FAILED)
            if fresh:
                cursor = client_id
            if outcome.kind == "again" and len(work) >= sim.MAX_WORK_ITEMS and client_id not in work:
                print(f"Warning: notice {collision_id!r} has more than {sim.MAX_WORK_ITEMS} open retries; this one is given up")
                outcome = _Outcome("gave_up")
            if outcome.kind == "again":
                work[client_id] = outcome.work  # type: ignore[assignment]
                continue
            work.pop(client_id, None)
            if outcome.kind == "delivered":
                delivered += 1
            elif outcome.kind == "gave_up":
                gave_up += 1
            else:
                dropped += 1

    resolved = leased.resolved or not stopped
    settled = resolved and not work
    final = replace(
        leased,
        version=leased.version + 1,
        state=sim.STATE_SETTLED if settled else sim.STATE_PENDING,
        lease_until_ms=0,
        resolved=resolved,
        cursor=None if resolved else cursor,
        work=work,
        delivered=leased.delivered + delivered,
        dropped=leased.dropped + dropped,
        gave_up=leased.gave_up + gave_up,
    )
    if not remote_config_store.put_remote_config_versioned(_record(collision, final, now), expected_version=leased.version):
        print(f"Warning: could not record the progress of notice {collision_id!r}; the next run re-reads it (the delivery log prevents repeats)")
        return (delivered, dropped, len(work))
    if settled:
        _settled.add(collision_id)
        _next_check_ms.pop(collision_id, None)
    elif resolved and work:
        _next_check_ms[collision_id] = min(item.next_at_ms for item in work.values())
    return (delivered, dropped, len(work) + (0 if resolved else 1))


def _resolve_recipients(
    collision: sim.Collision, entries: Mapping[str, live_reminder.StreamScheduleEntry], *, now_ms: int
) -> dict[str, sim.WorkItem]:
    """Who this collision is relevant to: opted-in clients with live notifications enabled for at least two of its creators.

    One Query of the sparse opt-in index first -- with nobody opted in nothing else is read. Then one Query per creator 全部 / creator + topic /
    stream override item (the reminder items are the creator subscription edges), keeping only opted-in clients, and the same resolution a
    reminder uses (live_reminder.resolve_effective_setting) decides which members each client has enabled.
    """
    opted_in = {
        record["clientId"] for record in remote_config_store.list_by_key(sim.OPT_IN_KEY) if sim.is_opted_in(record.get("value"))
    }
    if not opted_in:
        return {}
    creator_records: dict[str, list[dict[str, Any]]] = {}
    override_records: dict[str, list[dict[str, Any]]] = {}
    queried: set[str] = set()

    def collect(key: str, target: dict[str, list[dict[str, Any]]]) -> None:
        """Query the configKey-index for `key` once and keep only the opted-in clients' items in `target`."""
        if key in queried:
            return
        queried.add(key)
        for record in remote_config_store.list_by_key(key):
            if record["clientId"] in opted_in:
                target.setdefault(record["clientId"], []).append(record)

    for creator_id, video_id in collision.members:
        entry = entries.get(video_id)
        collect(live_reminder.creator_reminder_key(creator_id, live_reminder.ALL_TOPICS_SCOPE), creator_records)
        if entry is not None and entry.topic is not None:
            try:
                collect(live_reminder.creator_reminder_key(creator_id, entry.topic), creator_records)
            except live_reminder.ClientError:
                pass  # a topic the backend no longer reminds on: nothing can be stored under it
        collect(live_reminder.stream_override_key(video_id), override_records)

    work: dict[str, sim.WorkItem] = {}
    for client_id in sorted(set(creator_records) | set(override_records)):
        settings = live_reminder.parse_reminder_settings(creator_records.get(client_id, []), override_records.get(client_id, []))
        relevant = sim.relevant_members(settings, collision, entries)
        if not relevant:
            continue
        work[client_id] = sim.WorkItem(attempts=0, next_at_ms=now_ms, video_ids=tuple(video_id for _, video_id in relevant))
    return work


def _attempt_safely(
    client_id: str,
    item: sim.WorkItem,
    collision: sim.Collision,
    entries: Mapping[str, live_reminder.StreamScheduleEntry],
    *,
    now: datetime,
    creators_by_id: Mapping[str, Any],
    vapid: tuple[str, dict[str, str]],
) -> _Outcome:
    """_attempt, with any unexpected failure (a store error) turned into a counted, delayed retry so one client never stops the others."""
    try:
        return _attempt(client_id, item, collision, entries, now=now, creators_by_id=creators_by_id, vapid=vapid)
    except Exception as exc:  # noqa: BLE001 -- isolate the client; the attempt counts toward the bound like any other failed one
        print(f"Warning: simultaneous-livestream notice for client {client_id!r} failed ({type(exc).__name__}): {exc}")
        return _retry_or_give_up(item, now, sim.REASON_SEND_FAILED)


def _retry_or_give_up(item: sim.WorkItem, now: datetime, reason: str, *, count_attempt: bool = True) -> _Outcome:
    """The outcome of a failed attempt: a delayed retry, or (at MAX_ATTEMPTS) giving up for good. With `count_attempt=False` (a claim another worker
    holds) it is only a delayed look-again, never a give-up: the start passing ends it."""
    attempts = item.attempts + (1 if count_attempt else 0)
    if attempts >= sim.MAX_ATTEMPTS:
        print(f"Warning: giving up on a simultaneous-livestream notice after {attempts} attempts ({reason})")
        return _Outcome("gave_up")
    next_at = int(now.timestamp() * 1000) + sim.retry_delay_ms(max(attempts, 1))
    return _Outcome("again", sim.WorkItem(attempts=attempts, next_at_ms=next_at, video_ids=item.video_ids, reason=reason))


def _attempt(
    client_id: str,
    item: sim.WorkItem,
    collision: sim.Collision,
    entries: Mapping[str, live_reminder.StreamScheduleEntry],
    *,
    now: datetime,
    creators_by_id: Mapping[str, Any],
    vapid: tuple[str, dict[str, str]],
) -> _Outcome:
    """Notify one client of the collision now, or say why not. Everything the decision depends on is read fresh first."""
    now_ms = int(now.timestamp() * 1000)
    if now_ms >= collision.start_ms:
        return _Outcome("dropped", reason="started")  # the one limit: never a warning for a start that has already come

    # Cheapest check first: a resumed or repeated pass finds everyone already served with one read each, before any preference is read.
    first_key = sim.notice_key(collision.start_second, item.video_ids)
    first_status = notification_delivery_log_store.row_status(client_id, first_key, now=now)
    if first_status in ("delivered", "suppressed"):
        return _Outcome("dropped", reason="already_delivered")

    opt_in = remote_config_store.get_remote_config(client_id, sim.OPT_IN_KEY)
    if opt_in is None or not sim.is_opted_in(opt_in.get("value")):
        return _Outcome("dropped", reason="opted_out")
    preference_record = remote_config_store.get_remote_config(client_id, _PREFERENCE_KEY)
    if preference_record is None:
        return _Outcome("dropped", reason="no_preference")
    try:
        preference = notification_dispatch.parse_notification_preference(preference_record["value"])
    except notification_dispatch.ClientError as exc:
        print(f"Warning: skipping client {client_id!r} with an invalid stored notification preference: {exc}")
        return _Outcome("dropped", reason="invalid_preference")
    if not preference.enabled:
        return _Outcome("dropped", reason="notifications_off")
    subscription_record = remote_config_store.get_remote_config(client_id, _PUSH_SUBSCRIPTION_KEY)
    if subscription_record is None:
        return _Outcome("dropped", reason="no_subscription")

    relevant = [(creator_id, video_id) for creator_id, video_id in collision.members if video_id in item.video_ids]
    if item.reason != sim.REASON_PENDING:
        # A retry or a deferral: the client may have changed its reminders since the recipients were found, so the relevance is judged again.
        creator_items = remote_config_store.list_remote_config_by_prefix(client_id, live_reminder.CREATOR_REMINDER_KEY_PREFIX)
        override_items = remote_config_store.list_remote_config_by_prefix(client_id, live_reminder.STREAM_OVERRIDE_KEY_PREFIX)
        settings = live_reminder.parse_reminder_settings(creator_items, override_items)
        relevant = list(sim.relevant_members(settings, collision, entries))
    # The client's own per-creator switch (master switch ON, creator not disabled) narrows it further; fewer than two creators left = nothing to say.
    relevant = [(creator_id, video_id) for creator_id, video_id in relevant if notification_dispatch.is_creator_enabled(preference, creator_id)]
    if len({creator_id for creator_id, _ in relevant}) < 2:
        return _Outcome("dropped", reason="not_relevant")

    if notification_dispatch.is_temporarily_muted(preference, now=now) or notification_dispatch.is_within_quiet_hours(preference, now=now):
        # Looked at again exactly when the suppression ends (a known mute end / quiet-hours end), not by polling; if that is not before the start the
        # notice can no longer be true and is dropped.
        ends_at = _suppression_end_ms(preference, now)
        recheck = max(ends_at if ends_at is not None else now_ms + sim.DEFER_RECHECK_MS, now_ms + sim.DEFER_MIN_MS)
        if recheck >= collision.start_ms:
            return _Outcome("dropped", reason="suppressed_until_start")
        return _Outcome("again", sim.WorkItem(item.attempts, recheck, tuple(v for _, v in relevant), sim.REASON_DEFERRED))

    video_ids = tuple(video_id for _, video_id in relevant)
    key = sim.notice_key(collision.start_second, video_ids)
    status = first_status if key == first_key else notification_delivery_log_store.row_status(client_id, key, now=now)
    if status in ("delivered", "suppressed"):
        return _Outcome("dropped", reason="already_delivered")
    if status == "claimed" or not notification_delivery_log_store.mark_delivered(client_id, key, now.isoformat()):
        # Another worker holds the claim (or a crashed one's, until it expires): look again later rather than assume it was delivered.
        # Not an attempt (nothing was sent): look again until that claim is settled or expires (20 minutes), or the start passes.
        return _retry_or_give_up(replace(item, video_ids=video_ids), now, sim.REASON_CLAIM_HELD, count_attempt=False)

    text = notification_text.simultaneous_notification(
        locale=preference.locale,
        creator_names=[creators_by_id[c].display_name if c in creators_by_id else None for c in dict.fromkeys(c for c, _ in relevant)],
        start_label=datetime.fromtimestamp(collision.start_ms / 1000, tz=ZoneInfo(preference.time_zone)).strftime("%H:%M"),
        stream_titles=[entries[v].title if v in entries else None for v in video_ids],
    )
    data: dict[str, Any] = {"simultaneous": True, "startMs": collision.start_ms, "videoIds": list(video_ids), "url": _SCHEDULE_PATH}
    image = notification_payload.youtube_thumbnail_url(video_ids[0])
    if image:
        data["image"] = image
    vapid_private_key, vapid_claims = vapid
    result = push_sender.send_with_bounded_retry(
        subscription_record["value"],
        title=text.title,
        body=text.body,
        data=data,
        vapid_private_key=vapid_private_key,
        vapid_claims=vapid_claims,
        ttl_seconds=push_ttl.advance_reminder_ttl_seconds(scheduled_start_ms=collision.start_ms, now=now),
    )
    if result.subscription_expired:
        print(f"Push subscription expired for client {client_id!r}; leaving cleanup to a future pass")
        _release(client_id, key)
        return _Outcome("dropped", reason="subscription_expired")
    if not result.sent:
        print(f"Warning: simultaneous-livestream push failed for client {client_id!r} ({key}): {result.error}")
        _release(client_id, key)
        return _retry_or_give_up(replace(item, video_ids=video_ids), now, sim.REASON_SEND_FAILED)
    try:
        notification_delivery_log_store.confirm_delivered(client_id, key, now.isoformat())
    except Exception as exc:  # noqa: BLE001 -- the push already went out: leaving the claim in place (it expires) is the safe side, never a resend
        print(f"Warning: could not confirm the delivery of {key} to client {client_id!r} ({type(exc).__name__}): {exc}")
    return _Outcome("delivered")


def _suppression_end_ms(preference: notification_dispatch.NotificationPreference, now: datetime) -> int | None:
    """When the mute and / or the quiet hours in force at `now` end (epoch ms; the later of the two), or None if neither is in force."""
    ends: list[datetime] = []
    if notification_dispatch.is_temporarily_muted(preference, now=now) and preference.temporary_mute_until is not None:
        ends.append(preference.temporary_mute_until)
    if notification_dispatch.is_within_quiet_hours(preference, now=now) and preference.quiet_hours is not None:
        zone = ZoneInfo(preference.time_zone)
        local = now.astimezone(zone)
        end = datetime.combine(local.date(), preference.quiet_hours[1], tzinfo=zone)
        if end.astimezone(timezone.utc) <= now:
            end = datetime.combine(local.date() + timedelta(days=1), preference.quiet_hours[1], tzinfo=zone)
        ends.append(end)
    return int(max(ends).timestamp() * 1000) if ends else None


def _release(client_id: str, key: str) -> None:
    """Give a claim back after a failed send; if even that fails the claim just expires (a later attempt then finds it held and waits)."""
    try:
        notification_delivery_log_store.release_claim(client_id, key)
    except Exception as exc:  # noqa: BLE001 -- see docstring
        print(f"Warning: could not release the claim {key} of client {client_id!r} ({type(exc).__name__}): {exc}")


def invalidate_removed(
    previous: Mapping[str, live_reminder.StreamScheduleEntry],
    fresh: Mapping[str, live_reminder.StreamScheduleEntry],
) -> int:
    """After a refresh replaced the schedule: delete the ledger of every collision the OLD schedule had that the NEW one no longer has (cancelled,
    rescheduled, a member added or removed, started, ended). Returns how many ledgers it tried to delete.

    Best effort: a failed delete leaves a harmless orphan, because delivery works from the CURRENT collisions only and can never act on a removed one.
    An identical schedule has no removed collision and performs no write.
    """
    old = sim.detect_collisions(previous, now_ms=None)
    if not old:
        return 0
    current = sim.detect_collisions(fresh, now_ms=None)
    deleted = 0
    for collision_id in old:
        if collision_id in current:
            continue
        _settled.discard(collision_id)
        _next_check_ms.pop(collision_id, None)
        try:
            remote_config_store.delete_remote_config(live_reminder.SYSTEM_CLIENT_ID, sim.ledger_key(collision_id))
            deleted += 1
        except Exception as exc:  # noqa: BLE001 -- cleanup only
            print(f"Warning: could not delete the ledger of removed notice {collision_id!r} ({type(exc).__name__}): {exc}")
    return deleted
