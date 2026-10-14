"""DynamoDB-backed storage for Device Sync's Sync Profile / Sync Device model.

Two tables (terraform/dynamodb.tf): `YobiSyncProfiles` (one item per
profile, hash key `profileId`) and `YobiSyncDevices` (one item per attached
device, hash key `profileId` + range key `deviceId`, with a `deviceId-index`
GSI for the reverse "which profile is MY deviceId attached to" lookup every
device needs before it can read/write its shared preferences). Mirrors
remote_config_store.py's split from remote_config_api.py: this module is
the only one with a boto3 dependency.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

import boto3
from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import ClientError

SYNC_PROFILES_TABLE = os.environ.get("YOBI_SYNC_PROFILES_TABLE") or "YobiSyncProfiles"
SYNC_DEVICES_TABLE = os.environ.get("YOBI_SYNC_DEVICES_TABLE") or "YobiSyncDevices"
DEVICE_ID_INDEX = "deviceId-index"


class SyncProfileStoreError(Exception):
    """Raised when either Device Sync DynamoDB table is unreachable or malformed."""


_cached_resource = None


def _resource():
    global _cached_resource
    if _cached_resource is None:
        _cached_resource = boto3.resource("dynamodb")
    return _cached_resource


def create_profile(record: dict[str, Any]) -> None:
    """Persist a brand-new Sync Profile. `record` is sync_profile_api.new_profile_record's return value.

    A conditional PutItem: profileId is a fresh random uuid4, so this only
    ever guards against the practically-impossible collision case, the
    same defensive posture pairing_token_store.create_pairing_session uses.
    """
    table = _resource().Table(SYNC_PROFILES_TABLE)
    try:
        table.put_item(Item=dict(record), ConditionExpression=Attr("profileId").not_exists())
    except ClientError as exc:
        raise SyncProfileStoreError(f"Failed to write to {SYNC_PROFILES_TABLE}: {exc}") from exc


def profile_exists(profile_id: str) -> bool:
    table = _resource().Table(SYNC_PROFILES_TABLE)
    try:
        item = table.get_item(Key={"profileId": profile_id}).get("Item")
    except ClientError as exc:
        raise SyncProfileStoreError(f"Failed to read {SYNC_PROFILES_TABLE}: {exc}") from exc
    return item is not None


def attach_device(record: dict[str, Any]) -> None:
    """Upsert one SyncDevice item. `record` is sync_profile_api.attach_device_record's return value.

    `createdAt` is only ever set the FIRST time a given (profileId,
    deviceId) pair is attached (`if_not_exists`) -- a re-attach (the same
    device re-scanning a fresh QR for a profile it already belongs to)
    refreshes deviceLabel/deviceType/lastSeenAt without losing when it was
    originally paired.
    """
    table = _resource().Table(SYNC_DEVICES_TABLE)
    try:
        table.update_item(
            Key={"profileId": record["profileId"], "deviceId": record["deviceId"]},
            UpdateExpression=(
                "SET deviceLabel = :label, deviceType = :type, lastSeenAt = :now, "
                "createdAt = if_not_exists(createdAt, :now)"
            ),
            ExpressionAttributeValues={
                ":label": record["deviceLabel"],
                ":type": record["deviceType"],
                ":now": record["lastSeenAt"],
            },
        )
    except ClientError as exc:
        raise SyncProfileStoreError(f"Failed to write to {SYNC_DEVICES_TABLE}: {exc}") from exc


def get_profile_id_for_device(device_id: str) -> str | None:
    """Reverse lookup: which profileId (if any) this deviceId currently belongs to. Queried via `DEVICE_ID_INDEX`."""
    table = _resource().Table(SYNC_DEVICES_TABLE)
    try:
        response = table.query(IndexName=DEVICE_ID_INDEX, KeyConditionExpression=Key("deviceId").eq(device_id), Limit=1)
    except ClientError as exc:
        raise SyncProfileStoreError(f"Failed to query {SYNC_DEVICES_TABLE} by deviceId: {exc}") from exc
    items = response.get("Items", [])
    return items[0]["profileId"] if items else None


def list_devices(profile_id: str) -> list[dict[str, Any]]:
    """Every device currently attached to one Sync Profile, for the Connected Devices UI."""
    table = _resource().Table(SYNC_DEVICES_TABLE)
    items: list[dict] = []
    try:
        response = table.query(KeyConditionExpression=Key("profileId").eq(profile_id))
        items.extend(response.get("Items", []))
        while "LastEvaluatedKey" in response:
            response = table.query(KeyConditionExpression=Key("profileId").eq(profile_id), ExclusiveStartKey=response["LastEvaluatedKey"])
            items.extend(response.get("Items", []))
    except ClientError as exc:
        raise SyncProfileStoreError(f"Failed to query {SYNC_DEVICES_TABLE}: {exc}") from exc
    return [dict(item) for item in items]


def device_belongs_to_profile(profile_id: str, device_id: str) -> bool:
    table = _resource().Table(SYNC_DEVICES_TABLE)
    try:
        item = table.get_item(Key={"profileId": profile_id, "deviceId": device_id}).get("Item")
    except ClientError as exc:
        raise SyncProfileStoreError(f"Failed to read {SYNC_DEVICES_TABLE}: {exc}") from exc
    return item is not None


def delete_device(profile_id: str, device_id: str) -> None:
    """Detach/revoke one device from a Sync Profile. A no-op, not an error, if it wasn't attached."""
    table = _resource().Table(SYNC_DEVICES_TABLE)
    try:
        table.delete_item(Key={"profileId": profile_id, "deviceId": device_id})
    except ClientError as exc:
        raise SyncProfileStoreError(f"Failed to delete from {SYNC_DEVICES_TABLE}: {exc}") from exc
