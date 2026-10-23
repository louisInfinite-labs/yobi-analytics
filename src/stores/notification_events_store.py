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

Durable and idempotent: an event is written with a condition that no item for
that (eventDate, videoId) exists yet, so recording the same discovery again
(a retried run, an overlapping window) never changes the first write. An
event carries the fields the scheduled-delivery path needs: a logical
`eventId` ("new_video:<videoId>", the notification's own identity),
`publishedAt`, the `discoverySource` that found it (a discovery window id) and
`notificationEligible`. The same video can in principle be recorded again under
a LATER eventDate if a failed run rediscovers it; consumers therefore dedupe by
videoId (see notifications/new_video_dispatcher.py), never by row.
"""

from __future__ import annotations

import os
from datetime import datetime
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import BotoCoreError, ClientError

from tracking.discovery_windows import LEGACY_SOURCE
from tracking.video_master import CONTENT_TYPE_SHORT, Video

NOTIFICATION_EVENTS_TABLE = os.environ.get("YOBI_NOTIFICATION_EVENTS_TABLE") or "YobiNotificationEvents"

# The second, independent notification phase a completed YouTube Premiere gets once tracking.livestream_lifecycle verifies its
# archive available -- see record_premiere_archived_event for why its own `videoId` attribute is qualified with this suffix
# rather than reusing the video's bare id.
PREMIERE_ARCHIVED_PHASE = "premiere_archived"


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


def record_new_video_events(videos: list[Video], *, discovery_source: str = LEGACY_SOURCE, scheduled_starts: dict[str, str] | None = None) -> int:
    """Append one notification event per newly discovered video; return how many were newly recorded.

    `scheduled_starts` (videoId -> ISO scheduled start) is given only for an announced upcoming Premiere: the event then also stores `scheduledStartTime`, next to its
    unchanged `publishedAt` (YouTube's own, which for a Premiere that has not aired is its creation date). Readers that need the video's effective time use the scheduled start.

    Every video passed in must carry a discovered_at — main.py always
    stamps one on every video it discovers (see Video.discovered_at) — this
    is called once per video, at discovery, never for an update to an
    already-known Video Master record. An event that already exists is left
    exactly as first written (not an error, not counted), so the call is safe to repeat.
    """
    if not videos:
        return 0
    recorded = 0
    try:
        table = _resource().Table(NOTIFICATION_EVENTS_TABLE)
        for video in videos:
            try:
                table.put_item(
                    Item=_video_to_event_item(video, discovery_source, (scheduled_starts or {}).get(video.video_id)),
                    ConditionExpression="attribute_not_exists(videoId)",
                )
                recorded += 1
            except ClientError as exc:
                if exc.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                    raise
    except (ClientError, BotoCoreError) as exc:
        # BotoCoreError (e.g. EndpointConnectionError) is a separate exception family from ClientError -- catching only
        # ClientError let it bypass callers' NotificationEventsStoreError-only handling.
        raise NotificationEventsStoreError(f"Failed to write to {NOTIFICATION_EVENTS_TABLE}: {exc}") from exc
    return recorded


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


def _video_to_event_item(video: Video, discovery_source: str, scheduled_start: str | None = None) -> dict[str, Any]:
    """Build one Notification Events item from a newly discovered Video (plus, for an announced upcoming Premiere, its scheduled start)."""
    if video.discovered_at is None:
        raise NotificationEventsStoreError(
            f"Video {video.video_id!r} has no discovered_at; cannot record a notification event without one"
        )
    item: dict[str, Any] = {
        "eventDate": datetime.fromisoformat(video.discovered_at).date().isoformat(),
        "videoId": video.video_id,
        "eventId": new_video_event_id(video.video_id),
        "creatorId": video.creator_id,
        "title": video.title,
        "publishedAt": video.published_at,
        "discoveredAt": video.discovered_at,
        "discoverySource": discovery_source,
        "notificationEligible": True,
    }
    # A Short is told apart from an ordinary video so the dispatcher can deliver it only to clients that enabled this creator's
    # Shorts (notification_dispatch.is_new_video_wanted). Omitted otherwise -- an event written before this field existed is
    # then treated as an ordinary video.
    if video.content_type == CONTENT_TYPE_SHORT:
        item["contentType"] = CONTENT_TYPE_SHORT
    # The thumbnail URL discovery already holds for this video (YouTube's own best listed variant, from the same response as the title: no new
    # request, no probe), carried on the event so the new-video push can tell whether a Maxres thumbnail exists without looking anything up
    # (notifications/notification_payload.py validates it and falls back to HQ). Omitted when the video has none -- an event written before this
    # field existed is then simply sent with the HQ thumbnail.
    if video.thumbnail_url:
        item["thumbnailUrl"] = video.thumbnail_url
    # The announced Premiere's own scheduled start, stored as a separate optional attribute: `publishedAt` above keeps YouTube's value untouched. Omitted otherwise.
    if scheduled_start:
        item["scheduledStartTime"] = scheduled_start
    return item


def new_video_event_id(video_id: str) -> str:
    """The logical identity of a new-video notification event."""
    return f"new_video:{video_id}"


def premiere_archived_event_id(video_id: str) -> str:
    """The logical identity of a Premiere's archive-confirmation notification event -- distinct from new_video_event_id so the two
    phases of the same video are never confused by anything reading `eventId`, even though only new_video_event_id's target (the bare
    videoId) is ever used as this table's own physical sort key for the ordinary discovery-phase row."""
    return f"{PREMIERE_ARCHIVED_PHASE}:{video_id}"


def record_premiere_archived_event(*, video_id: str, creator_id: str, title: str, thumbnail_url: str | None, confirmed_at: str) -> bool:
    """Append the SECOND, independent notification event for a completed Premiere once its archive is verified available --
    distinct from the ordinary "new video discovered" event this same videoId already received at upload/announcement time
    (new_video_event_id, recorded once by main.py's discovery loop and never touched again).

    Both phases flow through the exact same new-video dispatcher and its existing 4-slot delivery schedule
    (notifications.new_video_dispatcher), independently eligible, because this phase's own `videoId` ATTRIBUTE -- this table's
    physical sort key -- carries "{video_id}#premiere_archived", a value a real YouTube videoId can never equal (a YouTube video id
    never contains "#"). That is what lets this event live at the SAME (eventDate, videoId) partition scheme without ever colliding
    with, suppressing, or being suppressed by that video's own discovery-phase row -- including when both happen to fall on the same
    calendar day. notifications.new_video_dispatcher.canonical_video_id strips the qualifier back out wherever the real id is needed
    (the push payload's deep link); the delivery-log dedup key deliberately keeps the qualified form, the same composite-id pattern
    notification_dispatcher.py's own advance/start reminder dedup already uses against this store's sibling delivery-log table.
    api.provisional_discoveries skips every event with an `eventPhase` set (never treats this as a newly-discovered, not-yet-ranked
    video -- by the time this is recorded the real archive is already visible through its own overlay).

    Idempotent: returns False, not an error, if this exact phase's event for this video was already recorded (the conditional
    write's own primary key) -- a second, independent safety net alongside tracking.livestream_lifecycle's own archive-lookup
    bookkeeping, which never revisits a video once its archive is ARCHIVE_AVAILABLE.
    """
    item: dict[str, Any] = {
        "eventDate": datetime.fromisoformat(confirmed_at).date().isoformat(),
        "videoId": f"{video_id}#{PREMIERE_ARCHIVED_PHASE}",
        "eventId": premiere_archived_event_id(video_id),
        "eventPhase": PREMIERE_ARCHIVED_PHASE,
        "creatorId": creator_id,
        "title": title,
        "publishedAt": confirmed_at,
        "discoveredAt": confirmed_at,
        "discoverySource": "premiere_archive_lookup",
        "notificationEligible": True,
    }
    if thumbnail_url:
        item["thumbnailUrl"] = thumbnail_url
    try:
        table = _resource().Table(NOTIFICATION_EVENTS_TABLE)
        table.put_item(Item=item, ConditionExpression="attribute_not_exists(videoId)")
        return True
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return False
        raise NotificationEventsStoreError(f"Failed to write to {NOTIFICATION_EVENTS_TABLE}: {exc}") from exc
    except BotoCoreError as exc:
        raise NotificationEventsStoreError(f"Failed to write to {NOTIFICATION_EVENTS_TABLE}: {exc}") from exc
