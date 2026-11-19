"""A durable, per-recipient retry for livestream reminders whose push failed for a reason that may pass (a push-service 429/5xx, a transport error, a store hiccup).

Why it exists: a reminder's on-time window is one minute, and a failed send releases its delivery claim but nothing ever re-served that minute -- so one
recipient's failure was permanent whenever another recipient of the same run succeeded (the Lambda only raises when EVERY candidate failed).

Design (kept deliberately small):

- ONE system record (`__system__` / `reminderRetry`) holds the open retries, at most MAX_ITEMS. It is written with the same compare-and-set `version` the
  simultaneous-livestream ledger uses, only when a run adds, advances or settles an item, and is read only by a container that knows (or does not yet
  know) that something is open -- an idle minute in a warm container reads nothing.
- An item is (client, video, the instant whose on-time window failed). A retry is NOT a replay of a stored message: it re-resolves the client's current
  setting, preference and subscription and runs the unchanged delivery code at that original instant in RECOVERED mode, so every existing rule applies
  again -- mute / quiet hours at the fire time and now, "saved before it came due", the advance reminder's 2-minute floor with the real minutes left in
  its wording, the start reminder's 5-minute grace -- and the delivery claim (one atomic row per client, video, kind and start minute) makes a second
  attempt for something already delivered a no-op.
- Backoff 30 s, 1 min, 2 min, 4 min (RETRY_DELAYS_MS), at most len() retries; an item also dies at its expiry (the reminder is no longer true), when the
  stream is gone or was rescheduled, when the client no longer wants it, and on any permanent outcome (an expired subscription, a 4xx rejection, a
  malformed subscription). A claim another worker still holds is waited for without spending an attempt.
- Not retried on purpose: a read timeout (the push may have been accepted; a resend could show twice -- the service worker sets no notification tag).
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
from typing import Any

from api import remote_config_api
from notifications import live_reminder
from stores import remote_config_store

RETRY_KEY = "reminderRetry"
MAX_ITEMS = 300  # bounds the one record (~150 bytes per item, far below DynamoDB's 400 KB item limit); beyond it the oldest-expiring items are dropped
RETRY_DELAYS_MS = (30_000, 60_000, 120_000, 240_000)  # wait before retry 1, 2, 3, 4
MAX_RETRIES = len(RETRY_DELAYS_MS)
DUE_SLACK_MS = 15_000  # a run arriving up to this early still takes an item (invocation jitter must not push a retry a whole minute later)
HELD_RECHECK_MS = 60_000  # a live claim held by another worker: look again in a minute, without spending a retry
START_GRACE_MS = 5 * 60_000  # == notification_dispatcher._START_RECOVERY_GRACE: a start reminder is no longer sent after this
ADVANCE_FLOOR_MS = live_reminder.CATCH_UP_MIN_REMAINING_MS  # an advance reminder is no longer sent with less than this left
_CAS_ATTEMPTS = 3


@dataclass(frozen=True)
class RetryItem:
    """One open retry: the reminder moment (instant) of one client's stream whose delivery has to be attempted again."""

    client_id: str
    video_id: str
    instant_ms: int  # the evaluation instant whose on-time window failed -- the retry is judged exactly at it
    start_ms: int  # the stream's scheduled start the failure was for; a rescheduled stream is a different target
    attempts: int  # retries already made (0 = none yet)
    next_at_ms: int
    expires_at_ms: int
    reason: str

    @property
    def key(self) -> str:
        """The item's id inside the record."""
        return item_key(self.client_id, self.video_id, self.instant_ms)

    def to_value(self) -> dict[str, Any]:
        """The stored form (short keys: ~150 bytes an item)."""
        return {"c": self.client_id, "v": self.video_id, "i": self.instant_ms, "s": self.start_ms, "a": self.attempts, "n": self.next_at_ms, "x": self.expires_at_ms, "r": self.reason}


def item_key(client_id: str, video_id: str, instant_ms: int) -> str:
    """Stable id of one (client, video, instant)."""
    return f"{client_id}|{video_id}|{instant_ms // 60_000}"


def _parse_item(raw: Any) -> RetryItem | None:
    """A stored item, or None when it is malformed (it is then simply dropped at the next write)."""
    try:
        return RetryItem(str(raw["c"]), str(raw["v"]), int(raw["i"]), int(raw["s"]), int(raw["a"]), int(raw["n"]), int(raw["x"]), str(raw.get("r", "")))
    except (KeyError, TypeError, ValueError):
        return None


def expiry_ms(start_ms: int, kinds: set[str]) -> int:
    """When the reminder is no longer true: a start reminder at start + grace, an advance reminder at start - 2 minutes; the later of the kinds involved."""
    moments = []
    if "start" in kinds or not kinds:
        moments.append(start_ms + START_GRACE_MS)
    if "advance" in kinds:
        moments.append(start_ms - ADVANCE_FLOOR_MS)
    return max(moments)


def delay_after(attempts_done: int) -> int | None:
    """Milliseconds to wait before the NEXT retry after `attempts_done` retries have already been made; None when the retries are used up."""
    if attempts_done >= MAX_RETRIES:
        return None
    return RETRY_DELAYS_MS[attempts_done]


def first_item(client_id: str, video_id: str, instant_ms: int, start_ms: int, kinds: set[str], now_ms: int, reason: str) -> RetryItem | None:
    """The item for a reminder that just failed for the first time, or None when it already expired."""
    expires = expiry_ms(start_ms, kinds)
    if expires <= now_ms + RETRY_DELAYS_MS[0]:
        return None  # no retry could still be on time
    return RetryItem(client_id, video_id, instant_ms, start_ms, 0, now_ms + RETRY_DELAYS_MS[0], expires, reason)


def failed_again(item: RetryItem, now_ms: int, reason: str) -> RetryItem | None:
    """The item after one more failed retry, or None when the retries are used up or the reminder would expire before the next one."""
    wait = delay_after(item.attempts + 1)
    if wait is None:
        return None
    nxt = now_ms + wait
    if nxt >= item.expires_at_ms:
        return None
    return replace(item, attempts=item.attempts + 1, next_at_ms=nxt, reason=reason)


def held(item: RetryItem, now_ms: int) -> RetryItem | None:
    """The item after finding its claim held by another worker (no retry spent), or None if it would expire first."""
    nxt = now_ms + HELD_RECHECK_MS
    return replace(item, next_at_ms=nxt) if nxt < item.expires_at_ms else None


def read_state() -> tuple[int | None, dict[str, RetryItem]]:
    """(the record's version or None when it does not exist, its open items by key)."""
    record = remote_config_store.get_remote_config(live_reminder.SYSTEM_CLIENT_ID, RETRY_KEY)
    value = record.get("value") if isinstance(record, dict) else None
    if not isinstance(value, dict):
        return None, {}
    items = {}
    raw_items = value.get("items")
    for raw in (raw_items.values() if isinstance(raw_items, dict) else []):
        item = _parse_item(raw)
        if item is not None:
            items[item.key] = item
    return int(value.get("version", 0)), items


def commit(changes: dict[str, RetryItem | None], now: datetime) -> dict[str, RetryItem]:
    """Apply `changes` ({key: new item, or None to remove}) to the stored record with a compare-and-set, re-reading and re-applying on a lost race.

    Returns the open items after the write. A change to an item some other writer already settled is applied anyway: removing is idempotent, and an
    update of a vanished item re-creates it only if the caller passed one (the caller never does for an item it did not read)."""
    now_ms = int(now.timestamp() * 1000)
    items: dict[str, RetryItem] = {}
    for _ in range(_CAS_ATTEMPTS):
        version, items = read_state()
        for key, item in changes.items():
            if item is None:
                items.pop(key, None)
            else:
                items[key] = item
        items = {key: item for key, item in items.items() if item.expires_at_ms > now_ms}
        if len(items) > MAX_ITEMS:
            for key in sorted(items, key=lambda k: items[k].expires_at_ms)[: len(items) - MAX_ITEMS]:
                items.pop(key)
            print(f"Warning: reminder retry queue over {MAX_ITEMS} items; the oldest-expiring were dropped")
        record = remote_config_api.write_remote_config(
            {
                "clientId": live_reminder.SYSTEM_CLIENT_ID,
                "key": RETRY_KEY,
                "value": {"version": (version or 0) + 1, "items": {key: item.to_value() for key, item in items.items()}},
            },
            now=now,
        )
        if remote_config_store.put_remote_config_versioned(record, expected_version=version):
            return items
    print("Warning: could not store the reminder retry queue after concurrent writers; the changes are retried next run")
    return items
