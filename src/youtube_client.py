"""Retrieve public YouTube video statistics via the YouTube Data API."""

from __future__ import annotations

import random
import time
from typing import Callable, TypeVar

import httplib2
from googleapiclient.discovery import Resource, build
from googleapiclient.errors import HttpError
from quota_ledger import IMMEDIATE_MAX_ATTEMPTS, RETRYABLE, STOP_ALL, classify_http_error

MAX_IDS_PER_REQUEST = 50
# The original request is attempt 1; MAX_RETRIES total attempts means two
# actual retries after it (Roadmap 2.5's "three total immediate attempts").
MAX_RETRIES = IMMEDIATE_MAX_ATTEMPTS
RETRY_BACKOFF_BASE_SECONDS = 1.0
RETRY_BACKOFF_CAP_SECONDS = 8.0

T = TypeVar("T")


class YouTubeAPIError(RuntimeError):
    """Raised when the YouTube API request fails or returns unusable data."""


class QuotaExhaustedError(YouTubeAPIError):
    """Raised when YouTube reports quotaExceeded/dailyLimitExceeded (Roadmap 2.5).

    Every further request today would fail the same way, so callers should
    stop issuing new requests entirely rather than continue processing
    remaining work — retrying against exhausted quota only wastes more of it.

    get_video_statistics enriches this with what was already collected
    before the wall was hit, so a caller can still persist that real,
    already-paid-for data instead of discarding it along with the exception:
    - partial_results: statistics successfully fetched before the failure.
    - partial_skip_reasons: skip reasons already recorded before the failure
      (e.g. a malformed item in an earlier batch).
    - remaining_video_ids: every video ID whose batch was never attempted —
      known upfront since the full due-today list is computed before any
      batch runs, not discovered as a side effect of the failure.
    """

    def __init__(
        self,
        message: str,
        *,
        partial_results: list[dict] | None = None,
        partial_skip_reasons: dict[str, str] | None = None,
        remaining_video_ids: list[str] | None = None,
    ) -> None:
        """Build the error, defaulting every partial-progress field to empty."""
        super().__init__(message)
        self.partial_results = partial_results if partial_results is not None else []
        self.partial_skip_reasons = partial_skip_reasons if partial_skip_reasons is not None else {}
        self.remaining_video_ids = remaining_video_ids if remaining_video_ids is not None else []


def build_youtube_client(api_key: str) -> Resource:
    """Build a YouTube Data API v3 client resource for the given API key."""
    try:
        return build("youtube", "v3", developerKey=api_key, cache_discovery=False)
    except Exception as exc:  # invalid key format, client build failure, etc.
        raise YouTubeAPIError(f"Failed to create YouTube API client: {exc}") from exc


def call_youtube_api(request_executor: Callable[[], T]) -> T:
    """Run a googleapiclient request, translating transport/API errors into YouTubeAPIError.

    Failures are classified (Roadmap 2.5) before deciding what to do:
    - Network/transport failures and retryable HTTP errors (429/5xx, or a
      YouTube reason like "rateLimitExceeded") get up to MAX_RETRIES total
      attempts with capped exponential backoff and jitter.
    - quotaExceeded/dailyLimitExceeded raise QuotaExhaustedError immediately,
      without retrying — every further request today would fail the same
      way, so retrying just wastes more quota.
    - Any other HTTP error (invalid request, bad credentials, a genuinely
      missing resource) is non-retryable and raises immediately — the
      request itself was invalid or rejected, not transient.

    Usage: call_youtube_api(lambda: youtube.videos().list(...).execute())
    """
    last_exc: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            return request_executor()
        except HttpError as exc:
            reason = _extract_error_reason(exc)
            category = classify_http_error(exc.status_code, reason)

            if category == STOP_ALL:
                raise QuotaExhaustedError(
                    f"YouTube quota exhausted (status {exc.status_code}, reason {reason!r}): {exc.reason}"
                ) from exc
            if category != RETRYABLE:
                raise YouTubeAPIError(
                    f"YouTube API request failed (status {exc.status_code}): {exc.reason}"
                ) from exc

            last_exc = exc
            if attempt < MAX_RETRIES:
                print(
                    f"Warning: retryable API error on attempt {attempt}/{MAX_RETRIES} "
                    f"(status {exc.status_code}, reason {reason!r}), retrying: {exc.reason}"
                )
                time.sleep(_backoff_seconds(attempt))
        except (OSError, httplib2.HttpLib2Error) as exc:
            last_exc = exc
            if attempt < MAX_RETRIES:
                print(f"Warning: network error on attempt {attempt}/{MAX_RETRIES}, retrying: {exc}")
                time.sleep(_backoff_seconds(attempt))

    raise YouTubeAPIError(f"YouTube API call failed after {MAX_RETRIES} attempts: {last_exc}") from last_exc


def _extract_error_reason(exc: HttpError) -> str | None:
    """Return YouTube's machine-readable error reason code (e.g. "quotaExceeded"),
    distinct from HttpError.reason, which is the human-readable message.
    """
    details = getattr(exc, "error_details", None)
    if isinstance(details, list) and details and isinstance(details[0], dict):
        reason = details[0].get("reason")
        if isinstance(reason, str):
            return reason
    return None


def _backoff_seconds(attempt: int) -> float:
    """Capped exponential backoff with jitter (Roadmap 2.5), keyed by attempt number."""
    exponential = min(RETRY_BACKOFF_CAP_SECONDS, RETRY_BACKOFF_BASE_SECONDS * (2 ** (attempt - 1)))
    return exponential + random.uniform(0, exponential * 0.1)


def get_video_statistics(youtube: Resource, video_ids: list[str]) -> tuple[list[dict], dict[str, str]]:
    """Fetch videoId/title/publishedAt/viewCount for the given video IDs.

    Requests are batched (up to MAX_IDS_PER_REQUEST ids per call) to keep
    quota usage low. A batch that fails outright is skipped with a warning
    so one bad batch doesn't abort statistics collection for the rest —
    except QuotaExhaustedError (Roadmap 2.5), which propagates immediately:
    with potentially thousands of remaining batches, treating each one as
    an independent "skip and continue" would keep re-issuing requests that
    are guaranteed to fail the same way, for no benefit. The raised
    QuotaExhaustedError is enriched with whatever was already collected
    (partial_results/partial_skip_reasons) and which video IDs were never
    attempted (remaining_video_ids), so a caller can still persist the
    real, already-paid-for data instead of losing it along with the error.

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
        except QuotaExhaustedError as exc:
            raise QuotaExhaustedError(
                str(exc),
                partial_results=results,
                partial_skip_reasons=skip_reasons,
                remaining_video_ids=video_ids[start:],
            ) from exc
        except YouTubeAPIError as exc:
            print(f"Warning: skipping a batch of {len(batch)} video ID(s) due to an API error: {exc}")
            for video_id in batch:
                skip_reasons[video_id] = f"YouTube API error: {exc}"
    return results, skip_reasons


def _fetch_batch(youtube: Resource, batch: list[str]) -> tuple[list[dict], dict[str, str]]:
    """Fetch and parse one videos.list batch, skipping missing/malformed items with a reason."""
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
    """Extract videoId/title/publishedAt/viewCount from one videos.list response item."""
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
