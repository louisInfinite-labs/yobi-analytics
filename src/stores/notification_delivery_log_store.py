"""DynamoDB-backed dedup log for delivered notifications (Roadmap 4.6).

Records that one specific client has already been notified about one
specific video, so notification_dispatcher.py never sends the same video's
notification to the same client twice — no matter how many scheduled runs
re-scan the same still-recent notification_events_store.py event before
every subscribed client has been reached.

Each (clientId, videoId) record moves through two states:

    claimed   -- notification_dispatcher.py has committed to sending this
                 (mark_delivered's atomic conditional write), but the push
                 hasn't been confirmed sent yet.
    delivered -- confirm_delivered() was called after a successful send.

A "claimed" record older than _CLAIM_EXPIRY is treated as abandoned — the
dispatcher invocation that claimed it terminated (Lambda timeout, crash)
before it could call confirm_delivered() or release_claim() — and a later
run may reclaim it (PR #18 CodeRabbit follow-up: the original atomic-claim
fix closed the double-send race but still left a claim stuck forever, i.e.
never delivered, if the process that claimed it died mid-flight).
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any

import boto3
from botocore.exceptions import ClientError

NOTIFICATION_DELIVERY_LOG_TABLE = os.environ.get("YOBI_NOTIFICATION_DELIVERY_LOG_TABLE") or "YobiNotificationDeliveryLog"

# Comfortably longer than a single Lambda invocation's own maximum
# execution time (15 minutes), so a claim only ever expires because the
# invocation that made it is truly gone, never because a slow-but-still-
# running one hasn't confirmed or released it yet.
_CLAIM_EXPIRY = timedelta(minutes=20)

_STATUS_CLAIMED = "claimed"
_STATUS_DELIVERED = "delivered"


class NotificationDeliveryLogStoreError(Exception):
    """Raised when the DynamoDB Notification Delivery Log table is unreachable or malformed."""


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


def already_delivered(client_id: str, video_id: str, *, now: datetime | None = None) -> bool:
    """Whether client_id has a confirmed delivery, or a still-live (unexpired) in-flight claim, for video_id.

    An expired "claimed" record (see module docstring) is reported as
    False — not yet delivered — so notification_dispatcher.py's pre-check
    lets a later run attempt this pair again instead of it looking
    permanently, silently, delivered forever.
    """
    table = _resource().Table(NOTIFICATION_DELIVERY_LOG_TABLE)
    try:
        item = table.get_item(Key={"clientId": client_id, "videoId": video_id}).get("Item")
    except ClientError as exc:
        raise NotificationDeliveryLogStoreError(f"Failed to read {NOTIFICATION_DELIVERY_LOG_TABLE}: {exc}") from exc
    if item is None:
        return False
    if item["status"] == _STATUS_DELIVERED:
        return True
    return not _is_expired(item["claimedAt"], now=now)


def mark_delivered(client_id: str, video_id: str, claimed_at: str, *, now: datetime | None = None) -> bool:
    """Atomically claim delivery of video_id to client_id. Returns True if
    this call performed the claim, False if a live (unexpired or already
    confirmed-delivered) record already existed.

    A conditional PutItem (rather than a plain overwrite) so two
    notification_dispatcher.py invocations racing on the same (client,
    video) pair — e.g. an overlapping scheduled run — can't both observe
    "not yet delivered" and both send: only one of them wins this call, and
    the loser's False return means it must not send. The condition also
    allows overwriting an *expired* claimed record (see module docstring),
    so an abandoned claim can be reclaimed rather than blocking forever.
    Call this *before* sending the push (notification_dispatcher.py does),
    pairing a losing call with "don't send", a won claim with
    confirm_delivered() after a successful send, and release_claim() if the
    send itself then fails — rather than calling this only after a
    successful send (which is what left the original race window open).
    """
    table = _resource().Table(NOTIFICATION_DELIVERY_LOG_TABLE)
    cutoff = ((now or datetime.now(timezone.utc)) - _CLAIM_EXPIRY).isoformat()
    try:
        table.put_item(
            Item={"clientId": client_id, "videoId": video_id, "status": _STATUS_CLAIMED, "claimedAt": claimed_at},
            ConditionExpression="attribute_not_exists(clientId) OR (#status = :claimed AND claimedAt < :cutoff)",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={":claimed": _STATUS_CLAIMED, ":cutoff": cutoff},
        )
        return True
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise NotificationDeliveryLogStoreError(f"Failed to write to {NOTIFICATION_DELIVERY_LOG_TABLE}: {exc}") from exc


def confirm_delivered(client_id: str, video_id: str, delivered_at: str) -> None:
    """Convert an owned claim (a True return from mark_delivered) into a confirmed, permanent delivery record.

    Unconditional: the caller already proved ownership of this (client,
    video) pair by winning mark_delivered's conditional write in the same
    invocation, so there is nothing left to race against here.
    """
    table = _resource().Table(NOTIFICATION_DELIVERY_LOG_TABLE)
    try:
        table.put_item(
            Item={"clientId": client_id, "videoId": video_id, "status": _STATUS_DELIVERED, "deliveredAt": delivered_at}
        )
    except ClientError as exc:
        raise NotificationDeliveryLogStoreError(f"Failed to write to {NOTIFICATION_DELIVERY_LOG_TABLE}: {exc}") from exc


def release_claim(client_id: str, video_id: str) -> None:
    """Undo a mark_delivered() claim whose push send did not actually
    succeed (expired subscription, send failure), so a future dispatcher
    run can retry delivering this video to this client instead of waiting
    out the full _CLAIM_EXPIRY window."""
    table = _resource().Table(NOTIFICATION_DELIVERY_LOG_TABLE)
    try:
        table.delete_item(Key={"clientId": client_id, "videoId": video_id})
    except ClientError as exc:
        raise NotificationDeliveryLogStoreError(f"Failed to release claim in {NOTIFICATION_DELIVERY_LOG_TABLE}: {exc}") from exc


def _is_expired(claimed_at: str, *, now: datetime | None = None) -> bool:
    """Whether a "claimed" record's own claimedAt is older than _CLAIM_EXPIRY.

    Strict `>`, matching mark_delivered's own `claimedAt < cutoff`
    reclaim condition exactly (cutoff = now - _CLAIM_EXPIRY, so
    `claimedAt < cutoff` <=> `now - claimedAt > _CLAIM_EXPIRY`) — an
    already_delivered() call and a mark_delivered() call an instant apart
    must agree on a claim sitting exactly at the boundary, rather than one
    calling it expired and the other refusing to reclaim it.
    """
    reference = now or datetime.now(timezone.utc)
    return reference - datetime.fromisoformat(claimed_at) > _CLAIM_EXPIRY
