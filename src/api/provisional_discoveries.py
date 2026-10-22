"""Provisional Home visibility for videos discovered AFTER the last daily ranking run.

Home's lists are served from the per-creator S3 ranking the daily 18:00 JST run writes, and a video only gets its official persisted
contentType in that same run. The five discovery windows find new videos hours earlier (and persist them to Video Master at once), so
without this overlay a video discovered at 20:00 stays invisible until the next 18:00 run. A discovered video the ranking does not hold yet
is therefore listed from what is PERSISTED about it (its Video Master record; the discovery event when that cannot be read):

- a video whose persisted contentType is missing, empty or unknown is listed in Home ALL ONLY: not in 最新影片, 最新直播, Shorts, 其他 or any
  topic tag. Nothing is inferred from its duration, title or anything else, and no contentType is ever invented or persisted;
- once a valid contentType (upload / live / short) is persisted, the video passes the filters of that type like any ranking row;
- every overlaid row is marked `provisional: true`; once the daily run's ranking holds the videoId, the persisted row wins (no duplicate).
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from tracking.video_master import VALID_CONTENT_TYPES, VALID_LIVE_STATUSES
from tracking.video_topics import classify_video_topic

JST = ZoneInfo("Asia/Tokyo")
# Never read more event dates than a ranking could possibly be behind (daily run missed twice).
_MAX_EVENT_DATES = 3

_EVENTS_TTL_SECONDS = 60.0
_RECORDS_TTL_SECONDS = 60.0

_events_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
_records_cache: dict[str, tuple[float, Any]] = {}


def clear_cache() -> None:
    """Forget every cached event list and Video Master record (tests)."""
    _events_cache.clear()
    _records_cache.clear()


def is_unclassified_provisional(row: dict[str, Any]) -> bool:
    """Whether `row` is a provisional row whose contentType is missing: the one kind of row that belongs in Home ALL and nowhere else."""
    return bool(row.get("provisional")) and not row.get("contentType")


def _event_dates(generated_at: object, today: str) -> list[str]:
    """The JST calendar dates whose discovery events can be newer than the ranking: the ranking's own date through today."""
    try:
        start = datetime.fromisoformat(str(generated_at)).astimezone(JST).date()
    except (TypeError, ValueError):
        start = datetime.fromisoformat(today).date() - timedelta(days=1)
    end = datetime.fromisoformat(today).date()
    dates = [(start + timedelta(days=offset)).isoformat() for offset in range((end - start).days + 1)]
    return dates[-_MAX_EVENT_DATES:]


def _events_for_date(event_date: str, moment: float) -> list[dict[str, Any]]:
    """Every discovery event recorded on one JST date, cached briefly so a busy Home does not re-read the table per request."""
    cached = _events_cache.get(event_date)
    if cached is not None and cached[0] > moment:
        return cached[1]
    from stores.notification_events_store import list_events_for_date

    events = list_events_for_date(event_date)
    _events_cache[event_date] = (moment + _EVENTS_TTL_SECONDS, events)
    return events


def _records_for(video_ids: list[str], moment: float) -> dict[str, Any]:
    """videoId -> persisted Video Master record for the ids that exist (one batched read, cached briefly); {} when it cannot be read."""
    for expired in [video_id for video_id, (expires_at, _) in _records_cache.items() if expires_at <= moment]:
        del _records_cache[expired]
    records = {video_id: cached[1] for video_id in video_ids if (cached := _records_cache.get(video_id)) is not None and cached[1] is not None}
    to_read = [video_id for video_id in video_ids if video_id not in _records_cache]
    if not to_read:
        return records
    try:
        from stores.dynamodb_store import get_videos

        fetched = get_videos(to_read)
    except Exception as exc:  # noqa: BLE001 -- never a reason to hide the video: it is still listed, unclassified, from its event
        print(f"Warning: could not read {len(to_read)} provisionally discovered video(s) from Video Master ({type(exc).__name__}): {exc}")
        return records
    for video_id in to_read:
        _records_cache[video_id] = (moment + _RECORDS_TTL_SECONDS, fetched.get(video_id))
        if video_id in fetched:
            records[video_id] = fetched[video_id]
    return records


def discovery_times_for(video_ids: list[str]) -> dict[str, str]:
    """videoId -> the persisted Video Master record's ORIGINAL `discovered_at`, for the ids that have a record with one; {} when unreadable.

    The same batched, briefly cached read the provisional overlay makes (`_records_for`), so ids that overlay also needs cost no extra read.
    A video with no record or no discovery time is simply absent -- callers must leave it unknown, never stand in another timestamp for it.
    """
    if not video_ids:
        return {}
    records = _records_for(video_ids, time.monotonic())
    return {video_id: record.discovered_at for video_id, record in records.items() if record is not None and record.discovered_at}


def _provisional_row(event: dict[str, Any], record: Any, creator_id: str) -> dict[str, Any]:
    """One provisional row: the persisted record's facts when it exists, else the discovery event's. A missing/unknown contentType stays None."""
    video_id = event["videoId"]
    raw_type = record.content_type if record is not None else event.get("contentType")
    content_type = raw_type if raw_type in VALID_CONTENT_TYPES else None
    live_status = record.live_status if record is not None and content_type == "live" and record.live_status in VALID_LIVE_STATUSES else None
    title = (record.title if record is not None else None) or event.get("title") or ""
    return {
        "videoId": video_id,
        "creatorId": creator_id,
        "topic": (record.topic if record is not None else None) or classify_video_topic(title),
        "contentType": content_type,
        "liveStatus": live_status,
        "currentViewCount": (record.last_view_count if record is not None else None) or 0,
        "title": title,
        "thumbnailUrl": (record.thumbnail_url if record is not None else None) or f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
        "publishedAt": (record.published_at if record is not None else None) or event.get("publishedAt"),
        "discoveredAt": (record.discovered_at if record is not None else None) or event.get("discoveredAt"),
        "provisional": True,
    }


def with_provisional_discoveries(rows: list[dict[str, Any]], creator_id: str, generated_at: object, *, now: datetime | None = None) -> list[dict[str, Any]]:
    """`rows` plus one provisional row for every video of `creator_id` that discovery recorded and the persisted ranking does not hold yet.

    Best effort: an event store failure returns `rows` unchanged, so Home is never worse than the persisted ranking alone.
    """
    moment_dt = now or datetime.now(timezone.utc)
    moment = time.monotonic()
    known = {row.get("videoId") for row in rows}
    try:
        events = [
            event
            for event_date in _event_dates(generated_at, moment_dt.astimezone(JST).date().isoformat())
            for event in _events_for_date(event_date, moment)
            # An event with an eventPhase (notification_events_store.record_premiere_archived_event) is never a "not yet ranked"
            # discovery to surface here: its own `videoId` field is phase-qualified, not a real id, and by the time it exists the
            # video is already visible through _with_verified_completed_streams' own archive overlay.
            if event.get("creatorId") == creator_id and event.get("videoId") not in known and not event.get("eventPhase")
        ]
    except Exception as exc:  # noqa: BLE001 -- never a reason to fail the Home list
        print(f"Warning: could not read the discovery events ({type(exc).__name__}): {exc}")
        return rows
    events = list({event["videoId"]: event for event in events if isinstance(event.get("videoId"), str)}.values())
    if not events:
        return rows
    records = _records_for([event["videoId"] for event in events], moment)
    return rows + [_provisional_row(event, records.get(event["videoId"]), creator_id) for event in events]
