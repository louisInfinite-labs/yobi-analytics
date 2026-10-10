"""Video Discovery: build and maintain the Tracking Universe for a creator.

Discovery decides which videos should be tracked. It is deliberately
separate from Statistics Collection (youtube_client.get_video_statistics),
which finds out the current public state of those videos.
"""

from __future__ import annotations

from typing import Iterator

from googleapiclient.discovery import Resource

from collection.youtube_client import YouTubeAPIError, call_youtube_api, select_video_thumbnail_url

PLAYLIST_PAGE_SIZE = 50

# call_youtube_api's message for a non-retryable HTTP error (youtube_client.call_youtube_api): a missing playlist.
_NOT_FOUND_MARKER = "(status 404)"


def get_uploads_playlist_id(youtube: Resource, channel_id: str) -> str:
    """Resolve a YouTube channel ID to its uploads playlist ID via channels.list."""
    response = call_youtube_api(
        lambda: youtube.channels().list(part="contentDetails", id=channel_id).execute()
    )

    items = response.get("items")
    if not items:
        raise YouTubeAPIError(f"No channel found for channel ID {channel_id!r}")

    try:
        return items[0]["contentDetails"]["relatedPlaylists"]["uploads"]
    except (KeyError, TypeError) as exc:
        raise YouTubeAPIError(f"Malformed channel response, missing field: {exc}") from exc


def get_shorts_playlist_id(channel_id: str) -> str | None:
    """The channel's Shorts-shelf playlist id (YouTube's own list of that channel's Shorts), or None for a non-UC id.

    A channel's playlists are derived from its id by swapping the "UC" prefix: uploads is "UU<rest>" (what
    get_uploads_playlist_id reads from channels.list) and the Shorts shelf is "UUSH<rest>". The mapping is a
    long-standing YouTube convention rather than documented API surface, which is why it is only ever used to
    classify (a failed lookup never silently marks a video as a non-Short -- see discover_short_video_ids).
    """
    if not channel_id.startswith("UC") or len(channel_id) <= 2:
        return None
    return f"UUSH{channel_id[2:]}"


def discover_short_video_ids(youtube: Resource, shorts_playlist_id: str, known_video_ids: set[str] | None = None) -> set[str]:
    """The ids on a channel's Shorts shelf, newest first -- the authoritative "is this a Short" source.

    With `known_video_ids` (incremental discovery) it stops at the first already-known video, like
    discover_new_videos; without it, it pages the whole shelf (initial discovery / the Shorts backfill).

    A channel with no Shorts has no Shorts playlist: YouTube answers 404 and that is a real, empty result. Any other
    failure (quota, transport, an invalid request) propagates -- the caller must not treat "could not look it up" as
    "not a Short", or a Short would be filed as an ordinary upload for good.
    """
    short_ids: set[str] = set()
    try:
        for page in _iter_playlist_pages(youtube, shorts_playlist_id):
            for video in page:
                if known_video_ids and video["videoId"] in known_video_ids:
                    return short_ids
                short_ids.add(video["videoId"])
    except YouTubeAPIError as exc:
        if _NOT_FOUND_MARKER in str(exc):
            return short_ids
        raise
    return short_ids


def discover_all_videos(youtube: Resource, playlist_id: str) -> list[dict]:
    """Initial Discovery: page through the entire uploads playlist history."""
    videos: list[dict] = []
    for page in _iter_playlist_pages(youtube, playlist_id):
        videos.extend(page)
    return videos


def discover_new_videos(youtube: Resource, playlist_id: str, known_video_ids: set[str]) -> list[dict]:
    """Incremental Discovery: scan newest uploads, stopping once a known video is reached."""
    new_videos: list[dict] = []
    for page in _iter_playlist_pages(youtube, playlist_id):
        for video in page:
            if video["videoId"] in known_video_ids:
                return new_videos
            new_videos.append(video)
    return new_videos


def _iter_playlist_pages(youtube: Resource, playlist_id: str) -> Iterator[list[dict]]:
    """Yield each page of parsed video entries from a playlist, newest first.

    A single malformed entry within a page is skipped with a warning rather
    than discarding videos already parsed from this and earlier pages.
    """
    page_token = None
    while True:
        response = call_youtube_api(
            lambda: youtube.playlistItems()
            .list(
                part="snippet",
                playlistId=playlist_id,
                maxResults=PLAYLIST_PAGE_SIZE,
                pageToken=page_token,
            )
            .execute()
        )

        items = response.get("items")
        if items is None:
            raise YouTubeAPIError("Malformed response from YouTube API: missing 'items'")

        page: list[dict] = []
        for item in items:
            try:
                page.append(_parse_playlist_item(item))
            except YouTubeAPIError as exc:
                print(f"Warning: skipping playlist item, could not parse: {exc}")
        yield page

        page_token = response.get("nextPageToken")
        if not page_token:
            return


def _parse_playlist_item(item: dict) -> dict:
    """Extract videoId/title/publishedAt/thumbnailUrl from a single
    playlistItems.list entry.

    thumbnailUrl (video-ranking metadata propagation) is read from this same
    entry's own snippet.thumbnails -- already present in this same paid
    part="snippet" response, no separate YouTube request. select_video_
    thumbnail_url returns None (never raises) for an item with no usable
    thumbnail variant, which is a legitimate, if rare, discovery outcome --
    never a reason to skip the whole item over what title/publishedAt
    already make trackable.
    """
    try:
        snippet = item["snippet"]
        video_id = snippet["resourceId"]["videoId"]
        title = snippet["title"]
        published_at = snippet["publishedAt"]
    except (KeyError, TypeError) as exc:
        raise YouTubeAPIError(f"Malformed playlist item, missing field: {exc}") from exc

    for field_name, value in (("videoId", video_id), ("title", title), ("publishedAt", published_at)):
        if not isinstance(value, str) or not value:
            raise YouTubeAPIError(f"Malformed playlist item, invalid {field_name!r}: {value!r}")

    thumbnail_url = select_video_thumbnail_url(snippet.get("thumbnails"))
    return {"videoId": video_id, "title": title, "publishedAt": published_at, "thumbnailUrl": thumbnail_url}
