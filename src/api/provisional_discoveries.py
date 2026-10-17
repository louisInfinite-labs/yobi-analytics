"""Provisional Home visibility for videos discovered AFTER the last daily ranking run.

Home's 最新影片 / ALL / Short shelves are served from the per-creator S3 ranking the daily 18:00 JST run writes, and a video only gets its
official persisted contentType in that same run. The five discovery windows find new videos hours earlier, so without this overlay a video
discovered at 20:00 stays invisible until the next 18:00 run. A discovered video the ranking does not hold yet is therefore listed provisionally:

- the facts come from what discovery persisted (a notification event per discovered video) plus ONE cached, batched YouTube lookup;
- a Short (the channel's Shorts shelf at discovery, or a known duration of 1..59 s) is listed as "short";
- a livestream is never listed here (the livestream surfaces own it);
- any other video (60 s or longer, or whose duration/classification could not be read) is listed; when the classification is unknown its
  contentType stays None and the Home content filters still treat it as an upload candidate (see row_matches_content_type);
- nothing is ever persisted: every row is marked `provisional: true`, and once the daily run's ranking holds the videoId the persisted row wins.
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from tracking.video_master import CONTENT_TYPE_SHORT
from tracking.video_topics import classify_video_topic

JST = ZoneInfo("Asia/Tokyo")
# A Short is a video of known, positive duration under one minute; 60 s or longer (or unknown) is an ordinary video.
SHORT_MAX_DURATION_SECONDS = 60
# Never read more event dates than a ranking could possibly be behind (daily run missed twice).
_MAX_EVENT_DATES = 3

_EVENTS_TTL_SECONDS = 60.0
_STABLE_FACTS_TTL_SECONDS = 3600.0
_VOLATILE_FACTS_TTL_SECONDS = 300.0

_events_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
_facts_cache: dict[str, tuple[float, dict[str, Any] | None]] = {}


def clear_cache() -> None:
    """Forget every cached event list and lookup answer (tests)."""
    _events_cache.clear()
    _facts_cache.clear()


def row_matches_content_type(row: dict[str, Any], content_type: str) -> bool:
    """Whether a catalog row passes a specific contentType filter; a provisional row with NO classification yet counts as an upload candidate."""
    if row.get("contentType") == content_type:
        return True
    return content_type == "upload" and bool(row.get("provisional")) and row.get("contentType") is None


def _fetch_facts(video_ids: list[str]) -> dict[str, dict[str, Any]]:
    """Ask the YouTube Data API (one batched videos.list) for contentType / liveStatus / duration; raises on any failure."""
    from collection.youtube_client import build_youtube_client, get_video_facts
    from ops.config import get_api_key

    return get_video_facts(build_youtube_client(get_api_key()), video_ids)


def _facts_for(video_ids: list[str], moment: float) -> dict[str, dict[str, Any]]:
    """videoId -> facts for the ids that could be looked up; an id that is missing is UNKNOWN (never a reason to hide the video)."""
    for expired in [video_id for video_id, (expires_at, _) in _facts_cache.items() if expires_at <= moment]:
        del _facts_cache[expired]
    answers: dict[str, dict[str, Any]] = {}
    to_ask: list[str] = []
    for video_id in video_ids:
        cached = _facts_cache.get(video_id)
        if cached is None:
            to_ask.append(video_id)
        elif cached[1] is not None:
            answers[video_id] = cached[1]
    if not to_ask:
        return answers
    try:
        fetched = _fetch_facts(to_ask)
    except Exception as exc:  # noqa: BLE001 -- every failure mode means "unknown", never "hide the video"
        print(f"Warning: could not look up {len(to_ask)} provisionally discovered video(s) ({type(exc).__name__}): {exc}; listing them unclassified")
        for video_id in to_ask:
            _facts_cache[video_id] = (moment + _VOLATILE_FACTS_TTL_SECONDS, None)
        return answers
    for video_id in to_ask:
        facts = fetched.get(video_id)
        if facts is None:
            _facts_cache[video_id] = (moment + _VOLATILE_FACTS_TTL_SECONDS, None)
            continue
        ttl = _VOLATILE_FACTS_TTL_SECONDS if facts.get("contentType") == "live" else _STABLE_FACTS_TTL_SECONDS
        _facts_cache[video_id] = (moment + ttl, facts)
        answers[video_id] = facts
    return answers


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


def _provisional_content_type(event: dict[str, Any], facts: dict[str, Any] | None) -> tuple[bool, str | None]:
    """(listed, contentType) for one discovered video; listed is False for a livestream."""
    if event.get("contentType") == CONTENT_TYPE_SHORT:
        return True, CONTENT_TYPE_SHORT
    if facts is None:
        return True, None
    if facts.get("contentType") == "live":
        return False, None
    duration = facts.get("durationSeconds")
    if isinstance(duration, int) and 0 < duration < SHORT_MAX_DURATION_SECONDS:
        return True, CONTENT_TYPE_SHORT
    return True, "upload"


def with_provisional_discoveries(rows: list[dict[str, Any]], creator_id: str, generated_at: object, *, now: datetime | None = None) -> list[dict[str, Any]]:
    """`rows` plus one provisional row for every video of `creator_id` that discovery recorded and the persisted ranking does not hold yet.

    Best effort: a store or lookup failure returns `rows` unchanged, so Home is never worse than the persisted ranking alone.
    """
    moment_dt = now or datetime.now(timezone.utc)
    moment = time.monotonic()
    known = {row.get("videoId") for row in rows}
    try:
        events = [
            event
            for event_date in _event_dates(generated_at, moment_dt.astimezone(JST).date().isoformat())
            for event in _events_for_date(event_date, moment)
            if event.get("creatorId") == creator_id and event.get("videoId") not in known
        ]
    except Exception as exc:  # noqa: BLE001 -- never a reason to fail the Home list
        print(f"Warning: could not read the discovery events ({type(exc).__name__}): {exc}")
        return rows
    events = list({event["videoId"]: event for event in events if isinstance(event.get("videoId"), str)}.values())
    if not events:
        return rows
    lookup_ids = [event["videoId"] for event in events if event.get("contentType") != CONTENT_TYPE_SHORT]
    facts = _facts_for(lookup_ids, moment) if lookup_ids else {}
    overlaid = list(rows)
    for event in events:
        video_id = event["videoId"]
        listed, content_type = _provisional_content_type(event, facts.get(video_id))
        if not listed:
            continue
        title = event.get("title") or ""
        overlaid.append(
            {
                "videoId": video_id,
                "creatorId": creator_id,
                "topic": classify_video_topic(title),
                "contentType": content_type,
                "liveStatus": None,
                "currentViewCount": 0,
                "title": title,
                "thumbnailUrl": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
                "publishedAt": event.get("publishedAt"),
                "discoveredAt": event.get("discoveredAt"),
                "provisional": True,
            }
        )
    return overlaid
