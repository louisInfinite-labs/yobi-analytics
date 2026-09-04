"""DynamoDB-backed storage for Heartbeat / Online Status (Roadmap 4.4).

heartbeat_api.py validates a heartbeat POST body and computes the
online/offline classification, but has no AWS dependency of its own,
mirroring dynamodb_store.py's split from video_master.py/snapshot_store.py
— this module is the DynamoDB-specific storage layer in front of it.
"""

from __future__ import annotations

import os
from typing import Any

import boto3
from botocore.exceptions import ClientError

HEARTBEAT_TABLE = os.environ.get("YOBI_HEARTBEAT_TABLE") or "YobiHeartbeat"


class HeartbeatStoreError(Exception):
    """Raised when the DynamoDB Heartbeat table is unreachable or malformed."""


_cached_resource = None


def _resource():
    """Return a cached boto3 DynamoDB resource, using the ambient AWS credentials/region.

    Cached at module level rather than constructed fresh per call — see
    dynamodb_store.py's own _resource() for why (a fresh boto3.resource()
    per call forces a new TLS handshake every time instead of reusing a
    warm connection). boto3 resources are documented as safe to share
    across threads for the calls this module makes.
    """
    global _cached_resource
    if _cached_resource is None:
        _cached_resource = boto3.resource("dynamodb")
    return _cached_resource


def put_heartbeat(record: dict[str, Any]) -> None:
    """Persist one client's latest heartbeat, overwriting its previous record.

    `record` is exactly heartbeat_api.record_heartbeat's return value:
    {clientId, lastSeenAt, appVersion}. A heartbeat write always overwrites
    the previous one — only the most recent lastSeenAt/appVersion matters
    for Roadmap 4.4's online/offline classification, so no history is kept.
    """
    table = _resource().Table(HEARTBEAT_TABLE)
    try:
        table.put_item(Item=dict(record))
    except ClientError as exc:
        raise HeartbeatStoreError(f"Failed to write to {HEARTBEAT_TABLE}: {exc}") from exc


def get_heartbeat(client_id: str) -> dict[str, Any] | None:
    """Return one client's stored {clientId, lastSeenAt, appVersion}, or None if it never sent one."""
    table = _resource().Table(HEARTBEAT_TABLE)
    try:
        item = table.get_item(Key={"clientId": client_id}).get("Item")
    except ClientError as exc:
        raise HeartbeatStoreError(f"Failed to read {HEARTBEAT_TABLE}: {exc}") from exc
    return dict(item) if item else None


def list_all() -> list[dict[str, Any]]:
    """Return every client's stored heartbeat record.

    A full-table Scan, the same "acceptable at current small scale"
    tolerance dynamodb_store.py's own Video Master Scan documents (Roadmap
    2.3) — used for an admin-facing aggregate view (Roadmap 4.4's "how many
    clients, how many currently online"), not a per-request hot path.
    """
    table = _resource().Table(HEARTBEAT_TABLE)
    items: list[dict] = []
    try:
        response = table.scan()
        items.extend(response.get("Items", []))
        while "LastEvaluatedKey" in response:
            response = table.scan(ExclusiveStartKey=response["LastEvaluatedKey"])
            items.extend(response.get("Items", []))
    except ClientError as exc:
        raise HeartbeatStoreError(f"Failed to scan {HEARTBEAT_TABLE}: {exc}") from exc
    return [dict(item) for item in items]
