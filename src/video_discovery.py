"""Video Discovery: build and maintain the Tracking Universe for a creator.

Discovery decides which videos should be tracked. It is deliberately
separate from Statistics Collection (youtube_client.get_video_statistics),
which finds out the current public state of those videos.
"""

from __future__ import annotations

from typing import Iterator

from googleapiclient.discovery import Resource

from youtube_client import YouTubeAPIError, call_youtube_api

PLAYLIST_PAGE_SIZE = 50


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
    """Extract videoId/title/publishedAt from a single playlistItems.list entry."""
    try:
        snippet = item["snippet"]
        return {
            "videoId": snippet["resourceId"]["videoId"],
            "title": snippet["title"],
            "publishedAt": snippet["publishedAt"],
        }
    except (KeyError, TypeError) as exc:
        raise YouTubeAPIError(f"Malformed playlist item, missing field: {exc}") from exc
