"""DynamoDB-backed storage for Remote Config (Roadmap 4.5).

remote_config_api.py validates/shapes a (clientId, key) -> value write/read
request but has no AWS dependency of its own, mirroring dynamodb_store.py's
split from video_master.py/snapshot_store.py — this module is the
DynamoDB-specific storage layer in front of it.

`value` is opaque and can be any JSON-typed value (Roadmap 4.5), including
an arbitrarily nested dict/list that contains a float — DynamoDB's boto3
resource API requires those as Decimal rather than a native Python float.
Floats are converted to Decimal recursively on write and back on read, so
remote_config_api.py's "value is opaque" contract needs no change here.

Known limitation: DynamoDB's Number type has no int/float distinction, so a
whole-number float (e.g. `18.0`) is indistinguishable on read from an int
that was written directly, and comes back as `18`, not `18.0`. There is no
schema here to disambiguate against (unlike video_master.py's named
`_VELOCITY_FIELDS`) — acceptable since nothing currently stored under this
opaque value depends on that distinction.
"""

from __future__ import annotations

import os
from decimal import Decimal
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

REMOTE_CONFIG_TABLE = os.environ.get("YOBI_REMOTE_CONFIG_TABLE") or "YobiRemoteConfig"


class RemoteConfigStoreError(Exception):
    """Raised when the DynamoDB Remote Config table is unreachable or malformed."""


_cached_resource = None


def _resource():
    """Return a cached boto3 DynamoDB resource, using the ambient AWS credentials/region.

    Cached at module level rather than constructed fresh per call — a fresh
    `boto3.resource()` opens its own connection pool, so constructing one
    per call forces a new TLS handshake every time instead of reusing a warm
    connection (see dynamodb_store.py's own _resource() for the production
    incident this pattern caused there). boto3 resources are documented as
    safe to share across threads for the calls this module makes.
    """
    global _cached_resource
    if _cached_resource is None:
        _cached_resource = boto3.resource("dynamodb")
    return _cached_resource


def put_remote_config(record: dict[str, Any]) -> None:
    """Persist one (clientId, key) -> value record, overwriting any existing value.

    `record` is exactly remote_config_api.write_remote_config's return
    value: {clientId, key, value, updatedAt}. A write is always a full
    overwrite of the previous value for that key — Roadmap 4.5 has no
    partial-merge semantics, since `value` is opaque to this backend.
    """
    table = _resource().Table(REMOTE_CONFIG_TABLE)
    item = {
        "clientId": record["clientId"],
        "configKey": record["key"],
        "value": _floats_to_decimal(record["value"]),
        "updatedAt": record["updatedAt"],
    }
    try:
        table.put_item(Item=item)
    except ClientError as exc:
        raise RemoteConfigStoreError(f"Failed to write to {REMOTE_CONFIG_TABLE}: {exc}") from exc


def get_remote_config(client_id: str, key: str) -> dict[str, Any] | None:
    """Return one stored {clientId, key, value, updatedAt} record, or None if unset."""
    table = _resource().Table(REMOTE_CONFIG_TABLE)
    try:
        item = table.get_item(Key={"clientId": client_id, "configKey": key}).get("Item")
    except ClientError as exc:
        raise RemoteConfigStoreError(f"Failed to read {REMOTE_CONFIG_TABLE}: {exc}") from exc
    return _item_to_record(item) if item else None


def list_remote_config(client_id: str) -> list[dict[str, Any]]:
    """Return every stored record for one clientId (Roadmap 4.5's "absent key means every key" read)."""
    table = _resource().Table(REMOTE_CONFIG_TABLE)
    items: list[dict] = []
    try:
        response = table.query(KeyConditionExpression=Key("clientId").eq(client_id))
        items.extend(response.get("Items", []))
        while "LastEvaluatedKey" in response:
            response = table.query(
                KeyConditionExpression=Key("clientId").eq(client_id),
                ExclusiveStartKey=response["LastEvaluatedKey"],
            )
            items.extend(response.get("Items", []))
    except ClientError as exc:
        raise RemoteConfigStoreError(f"Failed to query {REMOTE_CONFIG_TABLE}: {exc}") from exc
    return [_item_to_record(item) for item in items]


def delete_remote_config(client_id: str, key: str) -> None:
    """Remove one stored (clientId, key) record, if it exists.

    Used for a self-service "unsubscribe"-style write (Roadmap 4.6's
    pushSubscription) where the client is retracting its own prior value
    rather than setting a new one — a no-op, not an error, if nothing was
    stored under that key to begin with.
    """
    table = _resource().Table(REMOTE_CONFIG_TABLE)
    try:
        table.delete_item(Key={"clientId": client_id, "configKey": key})
    except ClientError as exc:
        raise RemoteConfigStoreError(f"Failed to delete from {REMOTE_CONFIG_TABLE}: {exc}") from exc


def list_by_key(key: str) -> list[dict[str, Any]]:
    """Return every stored record across all clients for one config key.

    `configKey` is only the table's sort key, not a queryable index, so this
    is a filtered Scan rather than a Query — acceptable at this store's
    current small scale, the same tolerance dynamodb_store.py's own
    full-table Scan of Video Master documents (Roadmap 2.3). Used by the
    Roadmap 4.6 notification dispatcher to find every client that has ever
    stored a "notificationPreference", since a clientId is otherwise only
    reachable if you already know it.
    """
    table = _resource().Table(REMOTE_CONFIG_TABLE)
    items: list[dict] = []
    scan_kwargs = {
        "FilterExpression": "configKey = :k",
        "ExpressionAttributeValues": {":k": key},
    }
    try:
        response = table.scan(**scan_kwargs)
        items.extend(response.get("Items", []))
        while "LastEvaluatedKey" in response:
            response = table.scan(**scan_kwargs, ExclusiveStartKey=response["LastEvaluatedKey"])
            items.extend(response.get("Items", []))
    except ClientError as exc:
        raise RemoteConfigStoreError(f"Failed to scan {REMOTE_CONFIG_TABLE}: {exc}") from exc
    return [_item_to_record(item) for item in items]


def _item_to_record(item: dict[str, Any]) -> dict[str, Any]:
    """Convert a DynamoDB Remote Config item back into a {clientId, key, value, updatedAt} record."""
    return {
        "clientId": item["clientId"],
        "key": item["configKey"],
        "value": _decimal_to_number(item["value"]),
        "updatedAt": item["updatedAt"],
    }


def _floats_to_decimal(value: Any) -> Any:
    """Recursively convert every float inside an opaque JSON value into Decimal for DynamoDB.

    Checked before int, since bool is an int subclass in Python and must
    pass through unchanged rather than becoming a Decimal.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {k: _floats_to_decimal(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_floats_to_decimal(v) for v in value]
    return value


def _decimal_to_number(value: Any) -> Any:
    """Recursively convert every Decimal inside a read-back item into int or float.

    DynamoDB's Number type has no int/float distinction — boto3 always
    deserializes it as Decimal, so a whole-number Decimal is restored to
    int and anything else to float, matching whichever Python type the
    original JSON value actually had.
    """
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {k: _decimal_to_number(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_decimal_to_number(v) for v in value]
    return value
