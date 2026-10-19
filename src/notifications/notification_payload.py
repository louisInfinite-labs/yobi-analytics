"""The `data` object of a creator-level push notification: the video it is about, the Creator Home route to open, and a thumbnail image.

One place builds it for every kind (start / advance / late-discovery catch-up reminders and new videos), so the kinds can never drift apart:

- `url`: the creator's Home route (notifications/creator_route.py), only for an active, known creator.
- `image`: the video's own YouTube thumbnail, never fetched or probed here. The default is `https://i.ytimg.com/vi/<videoId>/hqdefault.jpg` (480x360),
  the form the read API and the dashboard already use, which exists for every video. It is upgraded to `maxresdefault.jpg` (1280x720, 16:9) ONLY when
  the caller passes a thumbnail URL that CONFIRMS Maxres exists for this very video: YouTube's own snippet.thumbnails lists the maxres variant only
  when the file exists, and discovery stores the best listed variant as the Video Master's `thumbnailUrl`, so a stored `.../maxresdefault.jpg` is
  proof and any other stored size means Maxres was not available. A generated Maxres URL is never assumed to exist, and the Holodex live-stream
  snapshot's thumbnail (itself generated from the videoId) confirms nothing. A videoId that is not a well-formed 11-character YouTube id yields no
  image, so only a validated YouTube thumbnail URL can ever be sent. No YouTube Data API call, no HEAD/GET probe and no AWS access happens here; the
  service worker (frontend/dashboard/public/sw.js) validates the URL again, and a thumbnail the browser cannot load just means no picture.

`videoId` and `reminderKind` are passed through exactly as given; this module only ADDS fields and never changes the notification text, its
eligibility, its dedupe or who receives it.
"""

from __future__ import annotations

import re
from typing import Any

from notifications.creator_route import with_creator_route

# A YouTube video id: exactly 11 characters of [A-Za-z0-9_-].
_YOUTUBE_VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}")
# The one stored form that proves Maxres exists: the canonical maxresdefault.jpg URL (either YouTube image host), capturing the video id it belongs to.
_CONFIRMED_MAXRES = re.compile(r"https://(?:i\.ytimg\.com|img\.youtube\.com)/vi/([A-Za-z0-9_-]{11})/maxresdefault\.jpg")


def youtube_thumbnail_url(video_id: Any, known_thumbnail_url: Any = None) -> str | None:
    """Maxres when `known_thumbnail_url` confirms it for this video, else the always-available HQ thumbnail; None for a malformed video id."""
    if not isinstance(video_id, str) or not _YOUTUBE_VIDEO_ID.fullmatch(video_id):
        return None
    if isinstance(known_thumbnail_url, str):
        confirmed = _CONFIRMED_MAXRES.fullmatch(known_thumbnail_url)
        if confirmed and confirmed.group(1) == video_id:
            return f"https://i.ytimg.com/vi/{video_id}/maxresdefault.jpg"
    return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"


def notification_data(
    data: dict[str, Any], *, video_id: Any, creator_id: Any, creators_by_id: dict[str, Any], known_thumbnail_url: Any = None
) -> dict[str, Any]:
    """`data` plus the creator's Home route (`url`) and the video's thumbnail (`image`) -- each only when valid; `data` is never mutated."""
    enriched = with_creator_route(data, creator_id, creators_by_id)
    image = youtube_thumbnail_url(video_id, known_thumbnail_url)
    if image:
        enriched["image"] = image
    return enriched
