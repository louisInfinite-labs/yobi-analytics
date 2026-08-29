"""Retrieve public YouTube video statistics via the YouTube Data API."""

from __future__ import annotations

from typing import Callable, TypeVar

import httplib2
from googleapiclient.discovery import Resource, build
from googleapiclient.errors import HttpError

MAX_IDS_PER_REQUEST = 50

T = TypeVar("T")


class YouTubeAPIError(RuntimeError):
    """Raised when the YouTube API request fails or returns unusable data."""


def build_youtube_client(api_key: str) -> Resource:
    try:
        return build("youtube", "v3", developerKey=api_key, cache_discovery=False)
    except Exception as exc:  # invalid key format, client build failure, etc.
        raise YouTubeAPIError(f"Failed to create YouTube API client: {exc}") from exc


def call_youtube_api(request_executor: Callable[[], T]) -> T:
    """Run a googleapiclient request, translating transport/API errors into YouTubeAPIError.

    Usage: call_youtube_api(lambda: youtube.videos().list(...).execute())
    """
    try:
        return request_executor()
    except HttpError as exc:
        raise YouTubeAPIError(
            f"YouTube API request failed (status {exc.status_code}): {exc.reason}"
        ) from exc
    except (ConnectionError, TimeoutError, httplib2.HttpLib2Error) as exc:
        raise YouTubeAPIError(f"Network error while calling YouTube API: {exc}") from exc


def get_video_statistics(youtube: Resource, video_ids: list[str]) -> list[dict]:
    """Fetch videoId/title/publishedAt/viewCount for the given video IDs.

    Requests are batched (up to MAX_IDS_PER_REQUEST ids per call) to keep
    quota usage low. A batch that fails outright is skipped with a warning
    so one bad batch doesn't abort statistics collection for the rest.
    """
    if not video_ids:
        return []

    results: list[dict] = []
    for start in range(0, len(video_ids), MAX_IDS_PER_REQUEST):
        batch = video_ids[start : start + MAX_IDS_PER_REQUEST]
        try:
            results.extend(_fetch_batch(youtube, batch))
        except YouTubeAPIError as exc:
            print(f"Warning: skipping a batch of {len(batch)} video ID(s) due to an API error: {exc}")
    return results


def _fetch_batch(youtube: Resource, batch: list[str]) -> list[dict]:
    response = call_youtube_api(
        lambda: youtube.videos().list(part="snippet,statistics", id=",".join(batch)).execute()
    )

    items = response.get("items")
    if items is None:
        raise YouTubeAPIError("Malformed response from YouTube API: missing 'items'")
    if not all(isinstance(item, dict) for item in items):
        raise YouTubeAPIError("Malformed response from YouTube API: 'items' contains a non-object entry")

    found_ids = {item.get("id") for item in items}
    missing_ids = [video_id for video_id in batch if video_id not in found_ids]
    if missing_ids:
        print(f"Warning: no data returned for video ID(s): {', '.join(missing_ids)}")

    parsed_items: list[dict] = []
    for item in items:
        try:
            parsed_items.append(_parse_video_item(item))
        except YouTubeAPIError as exc:
            print(f"Warning: skipping video {item.get('id', '<unknown>')}, could not read statistics: {exc}")
    return parsed_items


def _parse_video_item(item: dict) -> dict:
    try:
        snippet = item["snippet"]
        statistics = item["statistics"]
        return {
            "videoId": item["id"],
            "title": snippet["title"],
            "publishedAt": snippet["publishedAt"],
            "viewCount": int(statistics["viewCount"]),
        }
    except (KeyError, TypeError, ValueError) as exc:
        raise YouTubeAPIError(f"Malformed video item, missing field: {exc}") from exc
