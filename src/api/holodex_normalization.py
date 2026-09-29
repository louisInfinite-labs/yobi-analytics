"""Normalization for Holodex Live/Upcoming streams (H3).

Converts one raw Holodex API item (src/api/holodex_client.py's H2 transport
returns these decoded as-is) into HolodexLiveStream, a stable backend-owned
shape for the future Live Status / Live Schedule API (H4). Holodex is a
supplementary, best-effort data source (Roadmap Phase 9) with no schema
guarantee beyond its own documented fields, so every raw item is parsed
defensively: an item that cannot identify a stream or its channel is
skipped outright, while every other field degrades to None rather than
raising -- one malformed item must never take down the whole batch.

HolodexLiveStream.youtube_channel_id is Holodex/YouTube's own external
channel id, never this project's internal creatorId. Resolving that mapping
requires the existing Creator Master registry (tracking/creator_master.py),
which belongs at the later API/service boundary (H4), not here --
introducing a second identity here would create a second source of truth
for creator identity.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal

HolodexStreamStatus = Literal["live", "upcoming"]

# Holodex's raw `status` values (docs.holodex.net): "new" (just discovered,
# no confirmed schedule yet), "upcoming", "live", "past", "missing" (video
# removed/privated) -- and potentially others this project has never seen,
# since Holodex is an unversioned third-party API. Only "live" and
# "upcoming" are relevant to Live/Upcoming; everything else is dropped
# rather than guessed into one of the two supported statuses.
_SUPPORTED_STATUSES: frozenset[str] = frozenset({"live", "upcoming"})


class HolodexNormalizationError(RuntimeError):
    """Raised when a Holodex response's top-level shape isn't the documented list.

    Distinct from an item-level defect (silently skipped by
    normalize_holodex_stream) on purpose: a genuine empty Live/Upcoming
    result ([]) must stay distinguishable from Holodex returning something
    unexpected (an error payload, a schema change, a malformed body) --
    conflating the two would make it impossible for a caller (H4) to tell
    "nobody is live right now" apart from "Holodex is degraded right now."
    """


@dataclass(frozen=True)
class HolodexLiveStream:
    """One normalized Holodex Live/Upcoming stream.

    video_id/youtube_channel_id/status are always present -- an item
    missing any of them is skipped by normalize_holodex_live_response and
    never represented here. Every other field is None when Holodex's raw
    item didn't carry it or it failed to parse, this project's own
    established "None means no value" convention (api/read_api.py's
    _ranked_entry_to_dict).
    """

    video_id: str
    youtube_channel_id: str
    channel_name: str | None
    title: str | None
    status: HolodexStreamStatus
    scheduled_start: str | None
    actual_start: str | None
    thumbnail_url: str


def _parse_utc_timestamp(raw_value: Any) -> str | None:
    """Parse a Holodex timestamp into an absolute, offset-aware UTC ISO-8601 string.

    Never converts to JST or any local timezone -- that stays the
    frontend's job (H3's own timestamp-handling requirement). Returns None
    for anything missing, blank, or unparsable rather than raising.
    """
    if not isinstance(raw_value, str) or not raw_value.strip():
        return None
    try:
        # Holodex timestamps use a trailing "Z"; normalize it to "+00:00"
        # explicitly rather than depending on the interpreter's own
        # fromisoformat leniency, which has changed across Python versions.
        parsed = datetime.fromisoformat(raw_value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


def normalize_holodex_stream(raw_item: Any) -> HolodexLiveStream | None:
    """Normalize one raw Holodex /live item, or None if it can't be trusted enough to show.

    Skipped entirely (returns None) when the item cannot identify a stream
    (missing/blank `id`) or a channel (missing/blank `channel.id`), or when
    `status` isn't "live"/"upcoming" -- an unsupported/unrecognized status
    (e.g. "new", "past", or anything unseen) is never guessed into one of
    the two supported values. Every other field degrades to None instead of
    discarding the item.
    """
    if not isinstance(raw_item, dict):
        return None

    video_id = raw_item.get("id")
    if not isinstance(video_id, str) or not video_id.strip():
        return None

    status = raw_item.get("status")
    if status not in _SUPPORTED_STATUSES:
        return None

    channel = raw_item.get("channel")
    channel_id = channel.get("id") if isinstance(channel, dict) else None
    if not isinstance(channel_id, str) or not channel_id.strip():
        return None

    channel_name = channel.get("name") if isinstance(channel, dict) else None
    if not isinstance(channel_name, str) or not channel_name.strip():
        channel_name = None

    title = raw_item.get("title")
    if not isinstance(title, str) or not title.strip():
        title = None

    return HolodexLiveStream(
        video_id=video_id,
        youtube_channel_id=channel_id,
        channel_name=channel_name,
        title=title,
        status=status,
        scheduled_start=_parse_utc_timestamp(raw_item.get("start_scheduled")),
        actual_start=_parse_utc_timestamp(raw_item.get("start_actual")),
        # Holodex's raw /live payload has no per-video thumbnail field --
        # every existing render site (frontend's OshiStatusPanel,
        # RecentVideosSection, StreamDetailModal) already derives this same
        # URL from the video id client-side, so this ports that exact
        # existing formula server-side rather than inventing a new one.
        thumbnail_url=f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg",
    )


def normalize_holodex_live_response(raw_payload: Any) -> list[HolodexLiveStream]:
    """Normalize a raw Holodex /live response into valid Live/Upcoming streams only.

    raw_payload is whatever holodex_client.holodex_get("/live", ...) (H2)
    returned decoded as-is -- expected to be a list, per Holodex's
    documented /live response shape. Raises HolodexNormalizationError if it
    isn't a list at all: an empty list ([]) is a valid, meaningful result
    (genuinely nobody live/upcoming) and must never be produced for a
    top-level shape that doesn't match what Holodex documents, which is a
    different failure mode entirely (see HolodexNormalizationError). Within
    a valid list, one malformed item never discards its valid siblings:
    each is normalized independently and silently dropped when
    normalize_holodex_stream returns None. Returned in the same order as
    raw_payload -- no UI-specific sort order is applied here.
    """
    if not isinstance(raw_payload, list):
        raise HolodexNormalizationError(
            f"Expected a list from Holodex's /live response, got {type(raw_payload).__name__}: {raw_payload!r}"
        )
    return [stream for raw_item in raw_payload if (stream := normalize_holodex_stream(raw_item)) is not None]


@dataclass(frozen=True)
class HolodexArchivedStream:
    """One normalized, already-ended Holodex stream (GET /recent-streams' own
    source shape) -- deliberately a separate type from HolodexLiveStream, not
    that type widened to a third status: HolodexLiveStream/normalize_holodex_
    stream are scoped to live/upcoming only by design (H3's own docstring),
    and an ended stream has no scheduled_start/actual_start concept worth
    carrying -- only published_at (Holodex's `available_at`, the same field
    this project's now-retired frontend-direct Holodex client used for its
    own `publishedAt`).

    video_id/youtube_channel_id are always present -- an item missing either
    is skipped by normalize_holodex_archived_streams_response and never
    represented here, same "never fabricate identity" posture as
    HolodexLiveStream.
    """

    video_id: str
    youtube_channel_id: str
    channel_name: str | None
    title: str | None
    published_at: str | None
    thumbnail_url: str


def normalize_holodex_archived_stream(raw_item: Any) -> HolodexArchivedStream | None:
    """Normalize one raw Holodex /videos item (status=past, type=stream), or
    None if it can't be trusted enough to show.

    Skipped entirely when the item cannot identify a stream (missing/blank
    `id`) or a channel (missing/blank `channel.id`) -- this function does
    NOT check `status` itself (unlike normalize_holodex_stream): the caller
    (get_recent_streams) already constrains the Holodex request itself to
    `status=past&type=stream`, so re-validating status here would only ever
    reject exactly what the request already guaranteed, for no benefit.
    """
    if not isinstance(raw_item, dict):
        return None

    video_id = raw_item.get("id")
    if not isinstance(video_id, str) or not video_id.strip():
        return None

    channel = raw_item.get("channel")
    channel_id = channel.get("id") if isinstance(channel, dict) else None
    if not isinstance(channel_id, str) or not channel_id.strip():
        return None

    channel_name = channel.get("name") if isinstance(channel, dict) else None
    if not isinstance(channel_name, str) or not channel_name.strip():
        channel_name = None

    title = raw_item.get("title")
    if not isinstance(title, str) or not title.strip():
        title = None

    return HolodexArchivedStream(
        video_id=video_id,
        youtube_channel_id=channel_id,
        channel_name=channel_name,
        title=title,
        published_at=_parse_utc_timestamp(raw_item.get("available_at")),
        thumbnail_url=f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg",
    )


def normalize_holodex_archived_streams_response(raw_payload: Any) -> list[HolodexArchivedStream]:
    """Normalize a raw Holodex /videos (archived streams) response.

    Same top-level-shape contract as normalize_holodex_live_response: raises
    HolodexNormalizationError if raw_payload isn't a list at all (a genuine
    "no archives yet" result is a valid, meaningful empty list, never
    conflated with Holodex returning something unexpected). Returned in the
    same order Holodex sent them -- the caller's own request already asked
    for `sort=available_at&order=desc`, so no re-sorting happens here.
    """
    if not isinstance(raw_payload, list):
        raise HolodexNormalizationError(
            f"Expected a list from Holodex's /videos response, got {type(raw_payload).__name__}: {raw_payload!r}"
        )
    return [
        stream for raw_item in raw_payload if (stream := normalize_holodex_archived_stream(raw_item)) is not None
    ]
