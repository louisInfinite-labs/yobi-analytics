"""DynamoDB-backed dedup log for delivered notifications (Roadmap 4.6).

Records that one specific client has already been notified about one
specific video, so notification_dispatcher.py never sends the same video's
notification to the same client twice — no matter how many scheduled runs
re-scan the same still-recent notification_events_store.py event before
every subscribed client has been reached.
"""

from __future__ import annotations

import os
from typing import Any

import boto3
from botocore.exceptions import ClientError

NOTIFICATION_DELIVERY_LOG_TABLE = os.environ.get("YOBI_NOTIFICATION_DELIVERY_LOG_TABLE") or "YobiNotificationDeliveryLog"


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


def already_delivered(client_id: str, video_id: str) -> bool:
    """Whether client_id has already been notified about video_id."""
    table = _resource().Table(NOTIFICATION_DELIVERY_LOG_TABLE)
    try:
        item = table.get_item(Key={"clientId": client_id, "videoId": video_id}).get("Item")
    except ClientError as exc:
        raise NotificationDeliveryLogStoreError(f"Failed to read {NOTIFICATION_DELIVERY_LOG_TABLE}: {exc}") from exc
    return item is not None


def mark_delivered(client_id: str, video_id: str, delivered_at: str) -> None:
    """Record that client_id has now been notified about video_id."""
    table = _resource().Table(NOTIFICATION_DELIVERY_LOG_TABLE)
    try:
        table.put_item(Item={"clientId": client_id, "videoId": video_id, "deliveredAt": delivered_at})
    except ClientError as exc:
        raise NotificationDeliveryLogStoreError(f"Failed to write to {NOTIFICATION_DELIVERY_LOG_TABLE}: {exc}") from exc
