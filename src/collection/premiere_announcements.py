"""Announce upcoming YouTube Premieres from the shared livestream snapshot, as one step of the existing new-video Collector run.

Why this exists: the Collector discovers videos through each creator's uploads playlist, and YouTube does not list a scheduled Premiere there until it
starts, so a Premiere used to be discovered only AFTER its start -- days after Holodex (and so the persisted shared snapshot) already knew it. This step
lets the Collector itself, on its five daily discovery windows, turn the upcoming Premieres already present in the persisted snapshot into ordinary new-video
events. It owns the announcement; the 5-minute lifecycle and the 10-minute display refresh stay responsible only for the snapshot, and no read-only API writes.

What it never does: it makes no Holodex request (it only reads the snapshot the display job already persisted), it creates no schedule, and it sends no
push -- an event is delivered by the dispatcher's own four user-configured slots exactly like any other new-video event.

How a snapshot entry becomes an announcement:
  1. Candidates are the snapshot's `status == "upcoming"` entries of an active, discovery-enabled creator that are not yet known to Video Master / the manifest,
     have no recorded decision, and are not a completed Premiere (durable archive times). `status == "upcoming"` alone is NOT a Premiere: most upcoming
     entries are ordinary scheduled livestreams.
  2. One batched videos.list (collection.youtube_client.get_upcoming_premiere_facts, 1 quota unit per 50 ids) tells them apart with the canonical
     is_upcoming_premiere rule (no contentDetails.duration; a real stream reports "P0D"). An id YouTube gave no definitive answer for is left undecided.
  3. Each genuine Premiere (channel matches, scheduled start still ahead) is recorded as a standard new-video event through the existing events store,
     with no Video Master row (the uploads playlist adds the row when it later lists the video). Every decided id -- announced or not -- is then remembered
     (stores.premiere_announcements_store), so it is never classified or announced again, and the playlist discovery of the same Premiere later records no
     second event for it.

The whole step is best-effort: a failure here never fails or alters the ordinary uploads-playlist discovery, and a failed event write simply leaves the id
undecided for the next window to retry. It is off unless YOBI_PREMIERE_ANNOUNCEMENTS is set (it introduces the one extra YouTube request described above).
"""

from __future__ import annotations

import math
import os
from datetime import datetime
from typing import Any, Callable

from collection.youtube_client import MAX_IDS_PER_REQUEST, UPCOMING_KIND_PREMIERE, get_upcoming_premiere_facts
from googleapiclient.discovery import Resource
from stores import premiere_announcements_store
from tracking.creator_master import Creator
from tracking.video_master import Video
from tracking.video_topics import classify_video_topic

ENABLED_ENV = "YOBI_PREMIERE_ANNOUNCEMENTS"
# A safety bound on one run's classification cost (three videos.list requests at most); the snapshot only ever holds a few dozen upcoming entries.
MAX_CLASSIFIED_PER_RUN = 3 * MAX_IDS_PER_REQUEST


def announcements_enabled() -> bool:
    """Whether the Collector should run the Premiere announcement step (YOBI_PREMIERE_ANNOUNCEMENTS set to 1/true/yes/on)."""
    return os.environ.get(ENABLED_ENV, "").strip().lower() in {"1", "true", "yes", "on"}


def _parse_moment(value: Any) -> datetime | None:
    """An ISO-8601 timestamp as an aware datetime, or None when absent, unparseable, or naive."""
    if not isinstance(value, str):
        return None
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo is not None else None


def read_snapshot_streams() -> list[dict[str, Any]]:
    """The streams of the persisted shared snapshot, with the snapshot's own staleness bound (livestream_lifecycle.read_serving_snapshot); [] when there is
    no snapshot or it is too stale to trust (an unattended snapshot may describe streams that no longer exist)."""
    from tracking.livestream_lifecycle import LiveSnapshotStaleError, read_serving_snapshot

    try:
        streams = read_serving_snapshot()
    except LiveSnapshotStaleError as exc:
        print(f"Premiere announcements skipped: the shared snapshot is stale ({exc})")
        return []
    return [stream for stream in streams if isinstance(stream, dict)] if streams else []


def select_candidates(
    streams: list[dict[str, Any]],
    creators_by_id: dict[str, Creator],
    known_video_ids: set[str],
    *,
    run_time: datetime,
) -> list[dict[str, Any]]:
    """The snapshot's upcoming entries worth asking YouTube about: status "upcoming", an eligible creator, a usable videoId not already known, and a scheduled
    start that is still ahead. Each videoId once, snapshot order kept. Says nothing about being a Premiere -- that needs YouTube's own answer."""
    seen: set[str] = set()
    candidates: list[dict[str, Any]] = []
    for stream in streams:
        video_id = stream.get("videoId")
        if stream.get("status") != "upcoming" or not isinstance(video_id, str) or not video_id or video_id in seen or video_id in known_video_ids:
            continue
        if stream.get("creatorId") not in creators_by_id:
            continue
        scheduled = _parse_moment(stream.get("scheduledStart"))
        if scheduled is None or scheduled <= run_time:
            continue
        seen.add(video_id)
        candidates.append(stream)
    return candidates


def build_announcement(stream: dict[str, Any], facts: dict[str, Any], creator: Creator, *, discovered_at: str) -> Video | None:
    """The standard new-video record for one confirmed upcoming Premiere, or None when YouTube's facts do not support announcing it: not a Premiere, a
    different channel than the creator's, or a scheduled start that is no longer ahead (announcing "upcoming" after the start would mislead).

    Title, thumbnail and publishedAt are YouTube's own, from the very response that confirmed the Premiere; nothing is invented. The record is only
    used to write the event -- it is never written to Video Master.
    """
    if facts.get("kind") != UPCOMING_KIND_PREMIERE or facts.get("channelId") != creator.youtube_channel_id:
        return None
    scheduled = _parse_moment(facts.get("scheduledStartTime"))
    moment = _parse_moment(discovered_at)
    if scheduled is None or moment is None or scheduled <= moment:
        return None
    title = facts.get("title") or stream.get("title")
    if not isinstance(title, str) or not title:
        return None
    return Video(
        video_id=stream["videoId"],
        creator_id=creator.creator_id,
        title=title,
        published_at=facts.get("publishedAt") or facts["scheduledStartTime"],
        thumbnail_url=facts.get("thumbnailUrl"),
        discovered_at=discovered_at,
        topic=classify_video_topic(title),
    )


def announce_upcoming_premieres(
    youtube: Resource,
    creators: list[Creator],
    known_ids_by_creator: dict[str, set[str]],
    *,
    run_time: datetime,
    source: str,
    record_events: Callable[..., int],
    read_streams: Callable[[], list[dict[str, Any]]] | None = None,
    fetch_facts: Callable[[Resource, list[str]], dict[str, dict]] | None = None,
) -> dict[str, int]:
    """Run the announcement step once; returns counts {"candidates", "requests", "announced", "ordinary"} for the run log.

    Order matters: the events are recorded BEFORE the decisions. A failed event write raises with no decision recorded, so the next window retries the id
    (events are first-write-wins, so a retry never duplicates one); a failed decision write after the events only costs the next window one more
    classification request. Quota exhaustion and any store failure propagate to the caller, which treats the step as best-effort.
    """
    summary = {"candidates": 0, "requests": 0, "announced": 0, "ordinary": 0}
    creators_by_id = {creator.creator_id: creator for creator in creators if creator.discovery_enabled}
    known_video_ids: set[str] = set().union(*known_ids_by_creator.values()) if known_ids_by_creator else set()
    candidates = select_candidates((read_streams or read_snapshot_streams)(), creators_by_id, known_video_ids, run_time=run_time)
    if not candidates:
        return summary

    from stores.premiere_archive_times_store import read_premiere_archive_times

    decisions = premiere_announcements_store.read_decisions()
    archived = read_premiere_archive_times()
    undecided = [stream for stream in candidates if stream["videoId"] not in decisions and stream["videoId"] not in archived]
    undecided = undecided[:MAX_CLASSIFIED_PER_RUN]
    summary["candidates"] = len(undecided)
    if not undecided:
        return summary

    facts_by_id = (fetch_facts or get_upcoming_premiere_facts)(youtube, [stream["videoId"] for stream in undecided])
    summary["requests"] = math.ceil(len(undecided) / MAX_IDS_PER_REQUEST)

    discovered_at = run_time.isoformat()
    to_announce: list[Video] = []
    scheduled_by_id: dict[str, str] = {}
    new_decisions: dict[str, bool] = {}
    for stream in undecided:
        facts = facts_by_id.get(stream["videoId"])
        if facts is None:
            continue  # YouTube gave no definitive answer: stays undecided, never guessed
        video = build_announcement(stream, facts, creators_by_id[stream["creatorId"]], discovered_at=discovered_at)
        if video is None:
            new_decisions[stream["videoId"]] = False
            summary["ordinary"] += 1
        else:
            to_announce.append(video)
            scheduled_by_id[video.video_id] = facts["scheduledStartTime"]
            new_decisions[video.video_id] = True

    if to_announce:
        # Each event also carries the Premiere's scheduled start so readers can use it as the video's effective time instead of its creation date.
        record_events(to_announce, discovery_source=source, scheduled_starts={video.video_id: scheduled_by_id[video.video_id] for video in to_announce})
        summary["announced"] = len(to_announce)
    premiere_announcements_store.record_decisions(new_decisions, now=run_time)
    return summary


def without_announced(videos: list[Video], announced_ids: set[str]) -> list[Video]:
    """The newly discovered videos that still need a new-video event: those whose Premiere was not already announced by this step."""
    return [video for video in videos if video.video_id not in announced_ids]
