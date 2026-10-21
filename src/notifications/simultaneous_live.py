"""同時開播預告 (simultaneous-livestream notice): the pure logic -- collision detection, who a collision is relevant to, and the
durable progress ledger's shape. No storage, no AWS, no clock of its own (simultaneous_dispatcher.py does the I/O).

A COLLISION is two or more upcoming streams of DIFFERENT creators whose scheduled start is EXACTLY the same instant, compared to the second (Holodex
reports whole seconds, and the production schedule was checked: every planned upcoming stream starts on :00 with no sub-second part, and every group of
streams sharing a start minute shares one exact timestamp, so "same second" and "same minute" agree on real data; an unplanned waiting room can carry odd
seconds, and two of those are NOT simultaneous unless they are the identical second). It is derived, in memory, from the "streamSchedule" entries the
dispatcher already holds -- nothing about collisions is stored with the schedule -- so a Holodex refresh that changes nothing relevant yields exactly
the same collisions and therefore zero extra DynamoDB work.

A collision's id is its start second plus a digest of its members, so a new stream joining the group, a member leaving or a reschedule is a DIFFERENT
collision (the old one is invalidated, see simultaneous_dispatcher.invalidate_removed), while an unchanged one keeps its id forever.

The notice is opt-in (the sparse per-client item OPT_IN_KEY, DEFAULT OFF) and per creator: a client is only told about the members of a collision
whose creators it has live reminders enabled for (any resolved reminder with notify-at-start or an advance time), and only when that is at least two
creators. The idempotency key of one client's notice is notice_key(start second, the client's relevant video ids): stable across retries, different for
every distinct relevant collision, and the SAME for a client whose relevant creators did not change when an unrelated creator joins the group.

WHEN a notice is sent is decided by schedule CHANGES, not by a clock: a collision that is new compared with the previous schedule (a new stream joined
the group, two streams came to share a start time, a stream was rescheduled onto it) is notified once to the clients it is newly relevant to, however
early or late it is discovered; nothing is sent for an unchanged one. The only time limit is the scheduled start itself: nothing is ever sent once it
has passed. There is no lead time and no minimum remaining time.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any, Mapping

from notifications import live_reminder

# The sparse per-client opt-in item: (clientId, OPT_IN_KEY) -> {"enabled": true}. ABSENT means off, like every reminder setting, so the config
# table's configKey-index lists exactly the clients that opted in.
OPT_IN_KEY = "simultaneousLiveNotice"
# One progress ledger per collision, stored under the system client (live_reminder.SYSTEM_CLIENT_ID) next to the "streamSchedule" record.
LEDGER_KEY_PREFIX = "simulNotice#"
NOTICE_KEY_PREFIX = "simul:"  # the delivery log's id for one client's notice; a real videoId never contains ":"

MAX_ATTEMPTS = 3  # transient send failures are retried at most this many times in total
RETRY_DELAYS_MS = (60_000, 3 * 60_000)  # wait before attempt 2 and attempt 3
DEFER_RECHECK_MS = 10 * 60_000  # a muted / quiet-hours client is looked at again when the suppression ends, else this much later, never every minute
DEFER_MIN_MS = 60_000  # ...and never sooner than this
LEASE_MS = 120_000  # one processing pass owns a collision for this long; a crashed pass's lease simply expires
MAX_WORK_ITEMS = 2000  # bounds the ledger item (DynamoDB's item limit is 400 KB): open RETRIES / deferrals only; beyond it a failure is given up with a warning

STATE_PENDING = "pending"
STATE_SETTLED = "settled"

REASON_SEND_FAILED = "send_failed"
REASON_CLAIM_HELD = "claim_held"
REASON_DEFERRED = "deferred"
REASON_PENDING = "pending"


@dataclass(frozen=True)
class Collision:
    """Two or more upcoming streams of different creators starting in the same minute."""

    start_second: int  # epoch seconds: the exact shared scheduled start
    members: tuple[tuple[str, str], ...]  # (creatorId, videoId), sorted

    @property
    def collision_id(self) -> str:
        """Stable identity: the exact start second and a digest of the member streams."""
        digest = hashlib.sha1("|".join(f"{creator}:{video}" for creator, video in self.members).encode("utf-8")).hexdigest()[:10]
        return f"{self.start_second}-{digest}"

    @property
    def start_ms(self) -> int:
        """The shared start, epoch ms."""
        return self.start_second * 1000

    @property
    def creator_ids(self) -> tuple[str, ...]:
        """The distinct creators, sorted."""
        return tuple(sorted({creator for creator, _ in self.members}))


def detect_collisions(
    entries: Mapping[str, live_reminder.StreamScheduleEntry], *, now_ms: int | None
) -> dict[str, Collision]:
    """Every collision among the still-upcoming streams of `entries`, by collision id.

    Only a stream whose status is exactly "upcoming" counts (a live, ended or status-less record never does: fail closed). With a `now_ms`, only
    streams that start after it; None keeps streams already past their start (used to recognise a PREVIOUS snapshot's collisions for cleanup).
    """
    by_start: dict[int, list[tuple[str, str]]] = {}
    for video_id, entry in entries.items():
        if entry.status != live_reminder.STATUS_UPCOMING:
            continue
        if now_ms is not None and entry.scheduled_start_ms <= now_ms:
            continue
        by_start.setdefault(entry.scheduled_start_ms // 1000, []).append((entry.creator_id, video_id))
    collisions: dict[str, Collision] = {}
    for second, members in by_start.items():
        if len({creator for creator, _ in members}) < 2:
            continue
        collision = Collision(start_second=second, members=tuple(sorted(members)))
        collisions[collision.collision_id] = collision
    return collisions


def ledger_key(collision_id: str) -> str:
    """The config key of one collision's progress ledger."""
    return f"{LEDGER_KEY_PREFIX}{collision_id}"


def notice_key(start_second: int, video_ids: tuple[str, ...]) -> str:
    """The delivery-log id of one client's notice: its exact start second and the client's own relevant streams, stable across retries."""
    digest = hashlib.sha1("|".join(sorted(video_ids)).encode("utf-8")).hexdigest()[:12]
    return f"{NOTICE_KEY_PREFIX}{start_second}:{digest}"


def is_reminder_enabled(setting: live_reminder.LiveReminderSetting | None) -> bool:
    """Whether a resolved reminder setting actually notifies (notify-at-start or an advance time): the stored `{false, null}` is effectively off."""
    return setting is not None and (setting.notify_at_start or setting.advance_reminder is not None)


def relevant_members(
    settings: live_reminder.ReminderSettings,
    collision: Collision,
    entries: Mapping[str, live_reminder.StreamScheduleEntry],
) -> tuple[tuple[str, str], ...]:
    """The members of `collision` this client has live notifications enabled for (resolved exactly like a reminder: per-stream override > creator
    全部 > creator + the stream's topic), or () when that is fewer than two distinct creators -- then there is nothing simultaneous to say."""
    relevant: list[tuple[str, str]] = []
    for creator_id, video_id in collision.members:
        entry = entries.get(video_id)
        topic = entry.topic if entry is not None else None
        setting = live_reminder.resolve_effective_setting(video_id=video_id, creator_id=creator_id, topic=topic, settings=settings)
        if is_reminder_enabled(setting):
            relevant.append((creator_id, video_id))
    if len({creator for creator, _ in relevant}) < 2:
        return ()
    return tuple(relevant)


def is_opted_in(record_value: Any) -> bool:
    """Whether a stored opt-in value switches the notice on: exactly {"enabled": true}; anything else is off."""
    return isinstance(record_value, dict) and record_value.get("enabled") is True


# ---------------------------------------------------------------- the progress ledger


@dataclass(frozen=True)
class WorkItem:
    """One client's still-open notice: how many sends were attempted, when to look again, and the client's own relevant streams."""

    attempts: int
    next_at_ms: int
    video_ids: tuple[str, ...]
    reason: str = REASON_PENDING


@dataclass(frozen=True)
class Ledger:
    """The durable progress of one collision's notice: the open work per client, and totals. `version` is the compare-and-set counter."""

    version: int
    state: str = STATE_PENDING
    lease_until_ms: int = 0
    resolved: bool = False  # a pass has attempted EVERY recipient once; from then on only `work` (retries / deferrals) is left
    cursor: str | None = None  # while not resolved: the last clientId a pass finished before stopping (deadline); the next pass resumes after it
    work: dict[str, WorkItem] = field(default_factory=dict)
    delivered: int = 0
    dropped: int = 0
    gave_up: int = 0


def ledger_to_value(ledger: Ledger, collision: Collision) -> dict[str, Any]:
    """The storable form of a ledger (JSON types only)."""
    return {
        "version": ledger.version,
        "state": ledger.state,
        "leaseUntilMs": ledger.lease_until_ms,
        "resolved": ledger.resolved,
        "cursor": ledger.cursor,
        "collision": {"startSecond": collision.start_second, "members": [list(member) for member in collision.members]},
        "work": {
            client_id: {"attempts": item.attempts, "nextAtMs": item.next_at_ms, "videoIds": list(item.video_ids), "reason": item.reason}
            for client_id, item in ledger.work.items()
        },
        "delivered": ledger.delivered,
        "dropped": ledger.dropped,
        "gaveUp": ledger.gave_up,
    }


def _int_or(raw: Any, default: int) -> int:
    """`raw` when it is a real integer (not a bool), else `default`."""
    return raw if isinstance(raw, int) and not isinstance(raw, bool) else default


def parse_ledger(raw: Any) -> Ledger | None:
    """A stored ledger value, or None when it is unusable (the caller then treats the collision as having no ledger and starts over safely: the
    delivery log's per-client claim still prevents any client from being notified twice)."""
    if not isinstance(raw, dict) or not isinstance(raw.get("version"), int) or isinstance(raw.get("version"), bool):
        return None
    work: dict[str, WorkItem] = {}
    raw_work = raw.get("work")
    if isinstance(raw_work, dict):
        for client_id, item in raw_work.items():
            if not isinstance(client_id, str) or not isinstance(item, dict):
                continue
            video_ids = item.get("videoIds")
            if not isinstance(video_ids, list) or not all(isinstance(v, str) for v in video_ids) or not video_ids:
                continue
            reason = item.get("reason")
            work[client_id] = WorkItem(
                attempts=_int_or(item.get("attempts"), 0),
                next_at_ms=_int_or(item.get("nextAtMs"), 0),
                video_ids=tuple(video_ids),
                reason=reason if isinstance(reason, str) else REASON_PENDING,
            )
    state = raw.get("state")
    return Ledger(
        version=raw["version"],
        state=state if state in (STATE_PENDING, STATE_SETTLED) else STATE_PENDING,
        lease_until_ms=_int_or(raw.get("leaseUntilMs"), 0),
        resolved=raw.get("resolved") is True,
        cursor=raw.get("cursor") if isinstance(raw.get("cursor"), str) else None,
        work=work,
        delivered=_int_or(raw.get("delivered"), 0),
        dropped=_int_or(raw.get("dropped"), 0),
        gave_up=_int_or(raw.get("gaveUp"), 0),
    )


def retry_delay_ms(attempts_so_far: int) -> int:
    """How long to wait before the next attempt after `attempts_so_far` failed ones (1-based)."""
    return RETRY_DELAYS_MS[min(attempts_so_far, len(RETRY_DELAYS_MS)) - 1]
