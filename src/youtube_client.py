"""Retrieve public YouTube video statistics via the YouTube Data API."""

from __future__ import annotations

import time
from typing import Callable, TypeVar

import httplib2
from googleapiclient.discovery import Resource, build
from googleapiclient.errors import HttpError

MAX_IDS_PER_REQUEST = 50
MAX_RETRIES = 3
RETRY_BACKOFF_SECONDS = 1.0

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

    Any transient network failure — connection reset, timeout, DNS resolution
    failure, TLS/SSL error, or an httplib2 transport error, whether caused by
    the API side or the local machine's own network — is retried up to
    MAX_RETRIES times with a short backoff. HTTP-level errors (4xx/5xx) are
    not retried — the request itself was invalid or rejected, so retrying
    just wastes quota.

    Usage: call_youtube_api(lambda: youtube.videos().list(...).execute())
    """
    last_exc: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            return request_executor()
        except HttpError as exc:
            raise YouTubeAPIError(
                f"YouTube API request failed (status {exc.status_code}): {exc.reason}"
            ) from exc
        except (OSError, httplib2.HttpLib2Error) as exc:
            last_exc = exc
            if attempt < MAX_RETRIES:
                print(f"Warning: network error on attempt {attempt}/{MAX_RETRIES}, retrying: {exc}")
                time.sleep(RETRY_BACKOFF_SECONDS * attempt)

    raise YouTubeAPIError(
        f"Network error while calling YouTube API after {MAX_RETRIES} attempts: {last_exc}"
    ) from last_exc


def get_video_statistics(youtube: Resource, video_ids: list[str]) -> tuple[list[dict], dict[str, str]]:
    """Fetch videoId/title/publishedAt/viewCount for the given video IDs.

    Requests are batched (up to MAX_IDS_PER_REQUEST ids per call) to keep
    quota usage low. A batch that fails outright is skipped with a warning
    so one bad batch doesn't abort statistics collection for the rest.

    Returns (results, skip_reasons) — skip_reasons maps every video ID that
    could not be recorded to why (a YouTube API/network failure, a missing
    video, or a malformed item), so a persisted run summary can show more
    than a bare count of what went missing.
    """
    if not video_ids:
        return [], {}

    results: list[dict] = []
    skip_reasons: dict[str, str] = {}
    for start in range(0, len(video_ids), MAX_IDS_PER_REQUEST):
        batch = video_ids[start : start + MAX_IDS_PER_REQUEST]
        try:
            batch_results, batch_skip_reasons = _fetch_batch(youtube, batch)
            results.extend(batch_results)
            skip_reasons.update(batch_skip_reasons)
        except YouTubeAPIError as exc:
            print(f"Warning: skipping a batch of {len(batch)} video ID(s) due to an API error: {exc}")
            for video_id in batch:
                skip_reasons[video_id] = f"YouTube API error: {exc}"
    return results, skip_reasons


def _fetch_batch(youtube: Resource, batch: list[str]) -> tuple[list[dict], dict[str, str]]:
    response = call_youtube_api(
        lambda: youtube.videos().list(part="snippet,statistics", id=",".join(batch)).execute()
    )

    items = response.get("items")
    if items is None:
        raise YouTubeAPIError("Malformed response from YouTube API: missing 'items'")
    if not all(isinstance(item, dict) for item in items):
        raise YouTubeAPIError("Malformed response from YouTube API: 'items' contains a non-object entry")

    skip_reasons: dict[str, str] = {}
    found_ids = {item.get("id") for item in items}
    missing_ids = [video_id for video_id in batch if video_id not in found_ids]
    if missing_ids:
        print(f"Warning: no data returned for video ID(s): {', '.join(missing_ids)}")
        for video_id in missing_ids:
            skip_reasons[video_id] = "No data returned by YouTube API (video may be deleted or private)"

    parsed_items: list[dict] = []
    for item in items:
        try:
            parsed_items.append(_parse_video_item(item))
        except YouTubeAPIError as exc:
            video_id = item.get("id", "<unknown>")
            print(f"Warning: skipping video {video_id}, could not read statistics: {exc}")
            skip_reasons[video_id] = str(exc)
    return parsed_items, skip_reasons


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
