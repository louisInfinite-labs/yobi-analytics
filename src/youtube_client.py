"""Retrieve public YouTube video statistics via the YouTube Data API."""

from __future__ import annotations

import httplib2
from googleapiclient.discovery import Resource, build
from googleapiclient.errors import HttpError

MAX_IDS_PER_REQUEST = 50


class YouTubeAPIError(RuntimeError):
    """Raised when the YouTube API request fails or returns unusable data."""


def build_youtube_client(api_key: str) -> Resource:
    try:
        return build("youtube", "v3", developerKey=api_key, cache_discovery=False)
    except Exception as exc:  # invalid key format, client build failure, etc.
        raise YouTubeAPIError(f"Failed to create YouTube API client: {exc}") from exc


def get_video_statistics(youtube: Resource, video_ids: list[str]) -> list[dict]:
    """Fetch videoId/title/publishedAt/viewCount for the given video IDs.

    Requests are batched (up to MAX_IDS_PER_REQUEST ids per call) to keep
    quota usage low.
    """
    if not video_ids:
        return []

    results: list[dict] = []
    for start in range(0, len(video_ids), MAX_IDS_PER_REQUEST):
        batch = video_ids[start : start + MAX_IDS_PER_REQUEST]
        results.extend(_fetch_batch(youtube, batch))
    return results


def _fetch_batch(youtube: Resource, batch: list[str]) -> list[dict]:
    try:
        response = youtube.videos().list(
            part="snippet,statistics",
            id=",".join(batch),
        ).execute()
    except HttpError as exc:
        raise YouTubeAPIError(
            f"YouTube API request failed (status {exc.status_code}): {exc.reason}"
        ) from exc
    except (ConnectionError, TimeoutError, httplib2.HttpLib2Error) as exc:
        raise YouTubeAPIError(f"Network error while calling YouTube API: {exc}") from exc

    items = response.get("items")
    if items is None:
        raise YouTubeAPIError("Malformed response from YouTube API: missing 'items'")

    found_ids = {item.get("id") for item in items}
    missing_ids = [video_id for video_id in batch if video_id not in found_ids]
    if missing_ids:
        print(f"Warning: no data returned for video ID(s): {', '.join(missing_ids)}")

    return [_parse_video_item(item) for item in items]


def _parse_video_item(item: dict) -> dict:
    try:
        snippet = item["snippet"]
        statistics = item["statistics"]
        return {
            "videoId": item["id"],
            "title": snippet["title"],
            "publishedAt": snippet["publishedAt"],
            "viewCount": int(statistics.get("viewCount", 0)),
        }
    except KeyError as exc:
        raise YouTubeAPIError(f"Malformed video item, missing field: {exc}") from exc
