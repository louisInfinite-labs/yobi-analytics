"""DynamoDB-backed storage for per-client secrets (Roadmap 4.1 hardening on Roadmap 4.3's clientId).

One item per clientId: {clientId, secretHash, createdAt}. Only the SHA-256
hash of a client's secret is ever stored — client_credential_api.py
generates and hashes it, api_handler.py's registration route returns the
raw value to the caller exactly once, and nothing here can reconstruct it
afterward. See client_credential_api.py's module docstring for why this
exists (PR #18 CodeRabbit finding: a clientId alone isn't proof of
ownership).
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

import boto3
from botocore.exceptions import ClientError

CLIENT_CREDENTIALS_TABLE = os.environ.get("YOBI_CLIENT_CREDENTIALS_TABLE") or "YobiClientCredentials"


class ClientCredentialStoreError(Exception):
    """Raised when the DynamoDB Client Credentials table is unreachable or malformed."""


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


def create_secret(client_id: str, secret_hash: str) -> bool:
    """Atomically issue a credential for client_id. Returns True if this
    call created it, False if one already existed.

    A conditional PutItem, not a plain overwrite: a client_id that already
    has a credential must not silently get a new one from a second
    registration call (whether a genuine retry or someone else probing) —
    the caller (api_handler.py's registration handler) turns a False here
    into a clean 4xx instead of ever returning a second raw secret for the
    same clientId.
    """
    table = _resource().Table(CLIENT_CREDENTIALS_TABLE)
    try:
        table.put_item(
            Item={
                "clientId": client_id,
                "secretHash": secret_hash,
                "createdAt": datetime.now(timezone.utc).isoformat(),
            },
            ConditionExpression="attribute_not_exists(clientId)",
        )
        return True
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise ClientCredentialStoreError(f"Failed to write to {CLIENT_CREDENTIALS_TABLE}: {exc}") from exc


def get_secret_hash(client_id: str) -> str | None:
    """Return the stored secret hash for client_id, or None if it has never registered one."""
    table = _resource().Table(CLIENT_CREDENTIALS_TABLE)
    try:
        item = table.get_item(Key={"clientId": client_id}).get("Item")
    except ClientError as exc:
        raise ClientCredentialStoreError(f"Failed to read {CLIENT_CREDENTIALS_TABLE}: {exc}") from exc
    return item["secretHash"] if item else None
