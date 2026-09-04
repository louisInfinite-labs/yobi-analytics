"""DynamoDB-backed log of new-video notification events (Roadmap 4.6).

An append-only log of "this video was newly discovered" events, one row per
video, written once by main.py's discovery loop at the moment a video enters
Video Master (Roadmap 1.4/2.3) and never updated again. This is what the
Roadmap 4.6 notification dispatcher (notification_dispatcher.py) scans,
instead of Video Master itself: partitioning by the event's own calendar
date lets the dispatcher query one or a few recent date partitions directly,
rather than scanning the entire, much larger, constantly-updated Video
Master table for a handful of recently discovered_at values.

Table key: eventDate (the discoveredAt timestamp's own calendar date, in the
same Asia/Tokyo zone main.py's COLLECTION_TIMEZONE stamps discovered_at
with, as YYYY-MM-DD) as partition key, videoId as sort key — one partition
per day of discovery, at most one item per video, since a video is only
ever "newly discovered" once.
"""

from __future__ import annotations

import os
from datetime import datetime
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import BotoCoreError, ClientError

from video_master import Video

NOTIFICATION_EVENTS_TABLE = os.environ.get("YOBI_NOTIFICATION_EVENTS_TABLE") or "YobiNotificationEvents"


class NotificationEventsStoreError(Exception):
    """Raised when the DynamoDB Notification Events table is unreachable or malformed."""


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


def record_new_video_events(videos: list[Video]) -> None:
    """Append one notification event per newly discovered video.

    Every video passed in must carry a discovered_at — main.py always
    stamps one on every video it discovers (see Video.discovered_at) — this
    is called once per video, at discovery, never for an update to an
    already-known Video Master record.
    """
    if not videos:
        return
    try:
        table = _resource().Table(NOTIFICATION_EVENTS_TABLE)
        with table.batch_writer() as batch:
            for video in videos:
                batch.put_item(Item=_video_to_event_item(video))
    except (ClientError, BotoCoreError) as exc:
        # BotoCoreError (e.g. EndpointConnectionError) is a separate
        # exception family from ClientError and can surface from
        # batch_writer()'s own retries — catching only ClientError let it
        # bypass _record_new_video_events_best_effort's
        # NotificationEventsStoreError-only catch in main.py and fail an
        # otherwise-successful collection run instead of just warning.
        raise NotificationEventsStoreError(f"Failed to write to {NOTIFICATION_EVENTS_TABLE}: {exc}") from exc


def list_events_for_date(event_date: str) -> list[dict[str, Any]]:
    """Return every notification event recorded for one calendar date (YYYY-MM-DD)."""
    table = _resource().Table(NOTIFICATION_EVENTS_TABLE)
    items: list[dict] = []
    try:
        response = table.query(KeyConditionExpression=Key("eventDate").eq(event_date))
        items.extend(response.get("Items", []))
        while "LastEvaluatedKey" in response:
            response = table.query(
                KeyConditionExpression=Key("eventDate").eq(event_date),
                ExclusiveStartKey=response["LastEvaluatedKey"],
            )
            items.extend(response.get("Items", []))
    except ClientError as exc:
        raise NotificationEventsStoreError(f"Failed to query {NOTIFICATION_EVENTS_TABLE}: {exc}") from exc
    return [dict(item) for item in items]


def _video_to_event_item(video: Video) -> dict[str, Any]:
    """Build one Notification Events item from a newly discovered Video."""
    if video.discovered_at is None:
        raise NotificationEventsStoreError(
            f"Video {video.video_id!r} has no discovered_at; cannot record a notification event without one"
        )
    return {
        "eventDate": datetime.fromisoformat(video.discovered_at).date().isoformat(),
        "videoId": video.video_id,
        "creatorId": video.creator_id,
        "title": video.title,
        "discoveredAt": video.discovered_at,
    }
