"""DynamoDB-backed storage for Device Sync pairing sessions.

One item per pairing session, keyed by `tokenHash` (the QR's own secret,
hashed) -- the same "only the store layer touches AWS, pairing_token_api.py
has no boto3 dependency of its own" split as remote_config_store.py/
remote_config_api.py. `humanCodeHash` is looked up via a GSI rather than a
second item, so a QR scan and a typed code both resolve to exactly one
session record and can never drift out of sync with each other.

Single-use is enforced here, not in pairing_token_api.py: `mark_consumed`
is a conditional update that only succeeds while `consumed` is still
false, so two near-simultaneous consume attempts for the same session (a
race, or a replay of an already-used code) can never both succeed --
DynamoDB's own conditional-write atomicity is the actual enforcement, not
an application-level read-then-write check.

`expiresAt` is a DynamoDB TTL attribute (terraform/dynamodb.tf): background
cleanup only, same as history_execution_lock.py's `ttlAt` -- TTL deletion
is best-effort and not instant, so `get_live_session` still checks
`expiresAt` itself rather than trusting a session's mere presence to mean
"still valid".
"""

from __future__ import annotations

import os
import time
from datetime import datetime, timezone
from typing import Any

import boto3
from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import ClientError

PAIRING_TOKENS_TABLE = os.environ.get("YOBI_PAIRING_TOKENS_TABLE") or "YobiPairingTokens"
HUMAN_CODE_INDEX = "humanCodeHash-index"


class PairingTokenStoreError(Exception):
    """Raised when the DynamoDB Pairing Tokens table is unreachable or malformed."""


class PairingSessionConflictError(Exception):
    """Raised when a freshly generated token/code hash collides with an existing, still-live session (practically never)."""


_cached_resource = None


def _resource():
    """Return a cached boto3 DynamoDB resource -- see remote_config_store.py's own `_resource()` for why it's cached, not per-call."""
    global _cached_resource
    if _cached_resource is None:
        _cached_resource = boto3.resource("dynamodb")
    return _cached_resource


def create_pairing_session(record: dict[str, Any]) -> None:
    """Persist one pairing session. `record` is exactly pairing_token_api.create_pairing_session's return value.

    A conditional PutItem (never overwrites an existing tokenHash item) --
    see module docstring for why a collision here would be a near-zero-
    probability event rather than an expected retry path.
    """
    table = _resource().Table(PAIRING_TOKENS_TABLE)
    item = {
        "tokenHash": record["tokenHash"],
        "humanCodeHash": record["humanCodeHash"],
        "profileId": record["profileId"],
        "createdByDeviceId": record["createdByDeviceId"],
        "createdAt": record["createdAt"],
        "expiresAt": record["expiresAt"],
        "consumed": False,
    }
    try:
        table.put_item(Item=item, ConditionExpression=Attr("tokenHash").not_exists())
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            raise PairingSessionConflictError("Generated pairing token collided with an existing session") from exc
        raise PairingTokenStoreError(f"Failed to write to {PAIRING_TOKENS_TABLE}: {exc}") from exc


def get_live_session_by_token_hash(token_hash: str, *, now: datetime | None = None) -> dict[str, Any] | None:
    """Return the live (not expired, not consumed) session for a QR-scanned token hash, or None."""
    table = _resource().Table(PAIRING_TOKENS_TABLE)
    try:
        item = table.get_item(Key={"tokenHash": token_hash}).get("Item")
    except ClientError as exc:
        raise PairingTokenStoreError(f"Failed to read {PAIRING_TOKENS_TABLE}: {exc}") from exc
    return _item_if_live(item, now)


def get_live_session_by_code_hash(code_hash: str, *, now: datetime | None = None) -> dict[str, Any] | None:
    """Return the live (not expired, not consumed) session for a typed-code hash, or None. Looked up via `HUMAN_CODE_INDEX`."""
    table = _resource().Table(PAIRING_TOKENS_TABLE)
    try:
        response = table.query(IndexName=HUMAN_CODE_INDEX, KeyConditionExpression=Key("humanCodeHash").eq(code_hash))
    except ClientError as exc:
        raise PairingTokenStoreError(f"Failed to query {PAIRING_TOKENS_TABLE} by humanCodeHash: {exc}") from exc
    items = response.get("Items", [])
    # humanCodeHash is not the table's own key (tokenHash is) -- a fresh GSI query can in principle return more than one
    # item if an extremely unlikely hash collision ever happened; the first live one is used, exactly as if it were unique.
    for item in items:
        live = _item_if_live(item, now)
        if live is not None:
            return live
    return None


def mark_consumed(token_hash: str, *, resolved_profile_id: str, now: datetime | None = None) -> bool:
    """Atomically mark a session consumed and (if it had none yet) record the Sync Profile it resolved to.

    Returns True if this call performed the consumption, False if the
    session was already consumed (a replay/race) -- the caller treats
    False as "this token/code is no longer valid", never as success.
    Conditioned on `consumed = false` only (not on expiry): an
    already-expired-but-unconsumed session is still rejected by the
    caller's own `get_live_session_by_*` check before this is ever called,
    so this update only needs to guard against a double-consume race.
    """
    table = _resource().Table(PAIRING_TOKENS_TABLE)
    try:
        table.update_item(
            Key={"tokenHash": token_hash},
            # "consumed" is a DynamoDB reserved keyword -- #consumed aliases it via ExpressionAttributeNames so the
            # raw UpdateExpression string can reference it (Attr()-built ConditionExpressions auto-alias internally,
            # but a hand-written UpdateExpression string does not).
            UpdateExpression="SET #consumed = :true, consumedAt = :now, profileId = :profileId",
            ConditionExpression=Attr("consumed").eq(False),
            ExpressionAttributeNames={"#consumed": "consumed"},
            ExpressionAttributeValues={
                ":true": True,
                ":now": (now or datetime.now(timezone.utc)).isoformat(),
                ":profileId": resolved_profile_id,
            },
        )
        return True
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return False
        raise PairingTokenStoreError(f"Failed to update {PAIRING_TOKENS_TABLE}: {exc}") from exc


def _item_if_live(item: dict[str, Any] | None, now: datetime | None) -> dict[str, Any] | None:
    if item is None or item.get("consumed"):
        return None
    now_epoch = (now or datetime.now(timezone.utc)).timestamp() if now else time.time()
    if int(item["expiresAt"]) < now_epoch:
        return None
    return dict(item)
