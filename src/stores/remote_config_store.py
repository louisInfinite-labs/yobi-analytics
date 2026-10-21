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
import threading
from decimal import Decimal
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

REMOTE_CONFIG_TABLE = os.environ.get("YOBI_REMOTE_CONFIG_TABLE") or "YobiRemoteConfig"
CONFIG_KEY_INDEX = "configKey-index"


class RemoteConfigStoreError(Exception):
    """Raised when the DynamoDB Remote Config table is unreachable or malformed."""


_local = threading.local()


def _resource():
    """Return this THREAD's cached boto3 DynamoDB resource, using the ambient AWS credentials/region.

    Cached (not constructed per call) so a warm Lambda keeps its connection pool -- see dynamodb_store.py's own _resource() for the production
    incident a per-call resource caused. Cached per THREAD because boto3 Resource objects are not documented as thread-safe and the dispatcher
    now serves recipients from a small thread pool; the low-level client underneath is thread-safe, the Resource wrapper is not guaranteed to be.
    """
    resource = getattr(_local, "resource", None)
    if resource is None:
        resource = boto3.resource("dynamodb")
        _local.resource = resource
    return resource


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


def put_remote_config_if_newer(record: dict[str, Any], *, revision: int) -> bool:
    """Persist `record` only if no record with a revision >= `revision` is stored: the write of a record that carries its own monotonic
    `value.revision` (an integer, e.g. the shared snapshot's refresh time in epoch ms).

    A dispatcher run that derived its record from an OLDER source than the one already stored (two overlapping runs, a retried event)
    loses the conditional write instead of overwriting the newer state. Returns True when written, False when a record at least as new
    already existed. A stored record without a revision (written before this existed) is always replaced.
    """
    table = _resource().Table(REMOTE_CONFIG_TABLE)
    item = {
        "clientId": record["clientId"],
        "configKey": record["key"],
        "value": _floats_to_decimal(record["value"]),
        "updatedAt": record["updatedAt"],
    }
    try:
        table.put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(clientId) OR attribute_not_exists(#value.#revision) OR #value.#revision < :revision",
            ExpressionAttributeNames={"#value": "value", "#revision": "revision"},
            ExpressionAttributeValues={":revision": revision},
        )
        return True
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise RemoteConfigStoreError(f"Failed to write to {REMOTE_CONFIG_TABLE}: {exc}") from exc


def put_remote_config_versioned(record: dict[str, Any], *, expected_version: int | None) -> bool:
    """Compare-and-set write of a record that carries its own `value.version` (an integer counter).

    `expected_version=None` creates the record and fails if it already exists; otherwise the write succeeds only while the stored
    `value.version` still equals `expected_version`. The caller writes `expected_version + 1`. Returns False when another writer got
    there first (the caller skips its work rather than overwrite). Used for the lease + progress of a simultaneous-livestream notice.
    """
    table = _resource().Table(REMOTE_CONFIG_TABLE)
    item = {
        "clientId": record["clientId"],
        "configKey": record["key"],
        "value": _floats_to_decimal(record["value"]),
        "updatedAt": record["updatedAt"],
    }
    kwargs: dict[str, Any]
    if expected_version is None:
        kwargs = {"ConditionExpression": "attribute_not_exists(clientId)"}
    else:
        kwargs = {
            "ConditionExpression": "#value.#version = :version",
            "ExpressionAttributeNames": {"#value": "value", "#version": "version"},
            "ExpressionAttributeValues": {":version": expected_version},
        }
    try:
        table.put_item(Item=item, **kwargs)
        return True
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
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


def list_remote_config_by_prefix(client_id: str, key_prefix: str) -> list[dict[str, Any]]:
    """Return every stored record for one clientId whose key starts with key_prefix.

    A Query on the table's (clientId, configKey) primary key with
    `begins_with` on the sort key -- cost scales with the matching records
    only, never the client's other keys or other clients.
    """
    table = _resource().Table(REMOTE_CONFIG_TABLE)
    condition = Key("clientId").eq(client_id) & Key("configKey").begins_with(key_prefix)
    items: list[dict] = []
    try:
        response = table.query(KeyConditionExpression=condition)
        items.extend(response.get("Items", []))
        while "LastEvaluatedKey" in response:
            response = table.query(KeyConditionExpression=condition, ExclusiveStartKey=response["LastEvaluatedKey"])
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

    AWS Cost Recovery (production-path audit): this used to be a table-wide
    Scan+FilterExpression -- O(total clients), the same failure class as
    VideoMaster's old full-catalog scan, just scaling with client count
    instead of video count. Now a Query against `configKey-index`
    (terraform/dynamodb.tf), so cost scales with how many clients actually
    stored this one key, never with the whole table. Used by the notification
    dispatcher to find the followers of one creator / stream (the reminder
    items `creatorReminder#<creator>#...` / `streamOverride#<video>` are the
    subscription edges) and the clients that opted in to the simultaneous-
    livestream notice -- never to list every client's preference.
    """
    table = _resource().Table(REMOTE_CONFIG_TABLE)
    items: list[dict] = []
    try:
        response = table.query(IndexName=CONFIG_KEY_INDEX, KeyConditionExpression=Key("configKey").eq(key))
        items.extend(response.get("Items", []))
        while "LastEvaluatedKey" in response:
            response = table.query(
                IndexName=CONFIG_KEY_INDEX,
                KeyConditionExpression=Key("configKey").eq(key),
                ExclusiveStartKey=response["LastEvaluatedKey"],
            )
            items.extend(response.get("Items", []))
    except ClientError as exc:
        raise RemoteConfigStoreError(f"Failed to query {REMOTE_CONFIG_TABLE} by configKey: {exc}") from exc
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
