"""DynamoDB-backed slot-recipient index for scheduled new-video delivery.

Answers the dispatcher's one question -- "which clients chose THIS local slot in THIS time zone?" -- with a bounded Query instead of
reading every client's stored preference.

One item per (client, slot the client chose):

    slotKey   (HASH)   "<IANA zone>|<local half-hour slot 00..47>", see notifications.delivery_slots.zone_slot_key
    clientId  (RANGE)  the client
    zone, slot         the same two parts as plain attributes
    activeSince        ISO instant the client was first indexed in its current enabled stretch. A client that turns notifications
                       OFF and ON again gets a new value, so videos discovered while it was OFF are never replayed. It survives a
                       change of time zone, so moving between zones never replays anything either.

Plus one registry item per zone that has ever had a recipient:

    slotKey   = "zones"  (notifications.delivery_slots.ZONES_PARTITION)
    clientId  = the IANA zone name

The dispatcher lists that one small partition to learn which zones to ask about; a daylight-saving transition or a client that moved
to another zone therefore never needs a re-index, because the (zone, local slot) key does not change when the UTC offset does. A zone
stays registered once seen (an empty (zone, slot) partition costs one tiny Query), and the set is bounded by the IANA database.

A global secondary index `clientId-index` (hash clientId) lists a client's own items so a changed or cancelled selection removes
exactly its stale ones.

Rows written by the first release of this index used the bare JST slot ("16") as their slotKey. They have no zone, are never read by the
dispatcher, and are removed (or, with prune_legacy=False, left alone for a rollback) by the next sync of their client.

The remote-config table's `configKey-index` cannot serve this: it can only list EVERY client that stored a notificationPreference,
and a client has up to four slots, so a per-slot lookup would need a table scan or a full read of all preferences each tick.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Iterable

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import BotoCoreError, ClientError

from notifications.delivery_slots import ZONES_PARTITION, zone_slot_key

NOTIFICATION_SLOTS_TABLE = os.environ.get("YOBI_NOTIFICATION_SLOTS_TABLE") or "YobiNotificationDeliverySlots"
CLIENT_INDEX = "clientId-index"


class NotificationSlotStoreError(Exception):
    """Raised when the DynamoDB slot-recipient table is unreachable or malformed."""


@dataclass(frozen=True)
class SlotRecipient:
    client_id: str
    active_since: str


_cached_resource = None


def _resource():
    """A cached boto3 DynamoDB resource (see dynamodb_store._resource for why it is not built per call)."""
    global _cached_resource
    if _cached_resource is None:
        _cached_resource = boto3.resource("dynamodb")
    return _cached_resource


def _query_all(table, **kwargs) -> list[dict]:
    items: list[dict] = []
    response = table.query(**kwargs)
    items.extend(response.get("Items", []))
    while "LastEvaluatedKey" in response:
        response = table.query(ExclusiveStartKey=response["LastEvaluatedKey"], **kwargs)
        items.extend(response.get("Items", []))
    return items


def _client_items(table, client_id: str) -> list[dict]:
    return _query_all(table, IndexName=CLIENT_INDEX, KeyConditionExpression=Key("clientId").eq(client_id))


def _is_legacy_key(slot_key: str) -> bool:
    """A slotKey of the first release (the bare JST slot, no zone part)."""
    return "|" not in slot_key


def sync_client_slots(client_id: str, *, zone: str, slots: Iterable[int], now_iso: str, prune_legacy: bool = True) -> None:
    """Make `client_id` a recipient of exactly `slots` of `zone`: add what is missing, remove what is stale.

    The zone is registered first and the new items are put before anything is deleted, so a failure part-way never leaves the client
    with fewer slots than it had, and a client is never findable without its zone being listed. A client that is already indexed keeps
    its original `activeSince`, whatever zone it moves to. `prune_legacy=False` leaves first-release items (no zone) untouched.
    """
    desired = {zone_slot_key(zone, slot): slot for slot in slots}  # zone_slot_key rejects a slot outside 0..47 and an unusable zone
    try:
        table = _resource().Table(NOTIFICATION_SLOTS_TABLE)
        existing = {item["slotKey"]: item for item in _client_items(table, client_id)}
        active_since = min((item["activeSince"] for item in existing.values()), default=now_iso)
        missing = {key: slot for key, slot in desired.items() if key not in existing}
        stale = [key for key in existing if key not in desired and (prune_legacy or not _is_legacy_key(key))]
        if not missing and not stale:
            return
        if missing:
            table.put_item(Item={"slotKey": ZONES_PARTITION, "clientId": zone})
            with table.batch_writer() as batch:
                for key, slot in missing.items():
                    batch.put_item(
                        Item={"slotKey": key, "clientId": client_id, "zone": zone, "slot": slot, "activeSince": active_since}
                    )
        if stale:
            with table.batch_writer() as batch:
                for key in stale:
                    batch.delete_item(Key={"slotKey": key, "clientId": client_id})
    except (ClientError, BotoCoreError) as exc:
        raise NotificationSlotStoreError(f"Failed to write to {NOTIFICATION_SLOTS_TABLE}: {exc}") from exc


def remove_client(client_id: str) -> None:
    """Remove every slot item of `client_id` (notifications turned OFF); a no-op for an unknown client."""
    try:
        table = _resource().Table(NOTIFICATION_SLOTS_TABLE)
        items = _client_items(table, client_id)
        if not items:
            return
        with table.batch_writer() as batch:
            for item in items:
                batch.delete_item(Key={"slotKey": item["slotKey"], "clientId": client_id})
    except (ClientError, BotoCoreError) as exc:
        raise NotificationSlotStoreError(f"Failed to delete from {NOTIFICATION_SLOTS_TABLE}: {exc}") from exc


def list_zones() -> list[str]:
    """Every IANA zone that has had a recipient, sorted: the zones the dispatcher must ask about each tick."""
    try:
        table = _resource().Table(NOTIFICATION_SLOTS_TABLE)
        items = _query_all(table, KeyConditionExpression=Key("slotKey").eq(ZONES_PARTITION))
    except (ClientError, BotoCoreError) as exc:
        raise NotificationSlotStoreError(f"Failed to query {NOTIFICATION_SLOTS_TABLE}: {exc}") from exc
    return sorted(item["clientId"] for item in items)


def list_recipients(zone: str, slot: int) -> list[SlotRecipient]:
    """Every client that chose the local `slot` in `zone`, in client-id order."""
    try:
        table = _resource().Table(NOTIFICATION_SLOTS_TABLE)
        items = _query_all(table, KeyConditionExpression=Key("slotKey").eq(zone_slot_key(zone, slot)))
    except (ClientError, BotoCoreError) as exc:
        raise NotificationSlotStoreError(f"Failed to query {NOTIFICATION_SLOTS_TABLE}: {exc}") from exc
    return [SlotRecipient(client_id=item["clientId"], active_since=item["activeSince"]) for item in items]


def client_slot_keys(client_id: str) -> set[str]:
    """The slot keys `client_id` is currently indexed under (used by reconciliation and tests)."""
    try:
        table = _resource().Table(NOTIFICATION_SLOTS_TABLE)
        return {item["slotKey"] for item in _client_items(table, client_id)}
    except (ClientError, BotoCoreError) as exc:
        raise NotificationSlotStoreError(f"Failed to query {NOTIFICATION_SLOTS_TABLE}: {exc}") from exc
