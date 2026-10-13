"""DynamoDB-backed slot-recipient index for scheduled new-video delivery.

Answers the dispatcher's one question -- "which clients chose THIS JST delivery slot?" -- with a bounded Query instead of reading
every client's stored preference.

One item per (client, slot the client chose):

    slotKey   (HASH)   the JST slot "00".."47", see notifications.delivery_slots.slot_key
    clientId  (RANGE)  the client
    slot               the same slot as a number
    activeSince        ISO instant the client was first indexed in its current enabled stretch. A client that turns notifications
                       OFF and ON again gets a new value, so videos discovered while it was OFF are never replayed.

A global secondary index `clientId-index` (hash clientId) lists a client's own items so a changed or cancelled selection removes
exactly its stale ones.

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

from notifications.delivery_slots import slot_key

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


def sync_client_slots(client_id: str, *, slots: Iterable[int], now_iso: str) -> None:
    """Make `client_id` a recipient of exactly `slots`: add what is missing, remove what is stale.

    Puts happen before deletes, so a failure part-way never leaves the client with fewer slots than it had. A client that is
    already indexed keeps its original `activeSince`.
    """
    desired = {slot_key(slot): slot for slot in slots}  # slot_key rejects a slot outside 0..47
    try:
        table = _resource().Table(NOTIFICATION_SLOTS_TABLE)
        existing = {item["slotKey"]: item for item in _client_items(table, client_id)}
        active_since = min((item["activeSince"] for item in existing.values()), default=now_iso)
        missing = {key: slot for key, slot in desired.items() if key not in existing}
        stale = [key for key in existing if key not in desired]
        if not missing and not stale:
            return
        with table.batch_writer() as batch:
            for key, slot in missing.items():
                batch.put_item(Item={"slotKey": key, "clientId": client_id, "slot": slot, "activeSince": active_since})
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


def list_recipients(slot: int) -> list[SlotRecipient]:
    """Every client that chose the JST `slot`, in client-id order."""
    try:
        table = _resource().Table(NOTIFICATION_SLOTS_TABLE)
        items = _query_all(table, KeyConditionExpression=Key("slotKey").eq(slot_key(slot)))
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
