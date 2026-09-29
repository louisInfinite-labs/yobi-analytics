"""Retrieve public YouTube video statistics via the YouTube Data API."""

from __future__ import annotations

import random
import time
from typing import Callable, TypeVar

import httplib2
from googleapiclient.discovery import Resource, build
from googleapiclient.errors import HttpError
from collection.quota_ledger import IMMEDIATE_MAX_ATTEMPTS, RETRYABLE, STOP_ALL, classify_http_error

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

    get_video_statistics (and, since 2026-09-29, get_channel_statistics)
    enriches this with what was already collected before the wall was hit,
    so a caller can still persist that real, already-paid-for data instead
    of discarding it along with the exception:
    - partial_results: statistics successfully fetched before the failure --
      a list for get_video_statistics, a dict keyed by channel ID for
      get_channel_statistics; this field is intentionally shape-agnostic
      rather than split into two differently-named fields, since both
      callers already know their own result shape and just want it back.
    - partial_skip_reasons: skip reasons already recorded before the failure
      (e.g. a malformed item in an earlier batch).
    - remaining_video_ids: every ID (video or channel) whose batch was never
      attempted — known upfront since the full due-today/roster list is
      computed before any batch runs, not discovered as a side effect of the
      failure. Kept under this video-specific name rather than a generic
      `remaining_ids` purely to avoid touching collection.main.py's existing
      `exc.remaining_video_ids` read for get_video_statistics.
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

    raise YouTubeAPIError(
        f"YouTube API call failed after {MAX_RETRIES} attempts ({_safe_error_context(last_exc)})"
    ) from last_exc


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


def _safe_error_context(exc: Exception | None) -> str:
    """Describe the last retry failure using only status/reason, never the raw
    exception's own str()/repr().

    HttpError's str()/repr() embeds the full request URI (see
    googleapiclient.errors.HttpError.__repr__), and the discovery client puts
    the API key into that URI as a `?key=...` query parameter -- so passing an
    HttpError itself into an f-string, as opposed to its already-parsed
    .status_code/.reason attributes, would leak the live key into any log or
    console that prints the resulting error.

    Non-HttpError exceptions (transport/network failures) are reduced to just
    their class name rather than their own message text: nothing guarantees a
    future transport exception's __str__ couldn't itself embed the same
    credential-bearing request URL (e.g. a proxy or connection-pool error that
    echoes the failed URL), so their text is never trusted either.
    """
    if isinstance(exc, HttpError):
        return f"status {exc.status_code}, reason {_extract_error_reason(exc)!r}: {exc.reason}"
    if exc is None:
        return "unknown error"
    return type(exc).__name__


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


# channels.list snippet.thumbnails only ever carries these three standard
# variants (unlike a video's thumbnails, which also has "standard"/"maxres")
# -- preferred order per Creator Master's avatarUrl field (C7A): the
# highest-quality one actually present, never more than one stored.
_AVATAR_THUMBNAIL_PREFERENCE = ("high", "medium", "default")


def select_channel_avatar_url(thumbnails: object) -> str | None:
    """Pick one canonical avatar URL from a channels.list snippet.thumbnails
    value, preferring high -> medium -> default. Returns None (never raises)
    if `thumbnails` isn't a dict, or none of the three variants carry a
    usable url -- a channel with no matching thumbnail simply has no fresh
    avatar to offer, which callers must treat as "no update", never as "set
    avatarUrl to null" (see tracking.creator_avatar_sync)."""
    if not isinstance(thumbnails, dict):
        return None
    for size in _AVATAR_THUMBNAIL_PREFERENCE:
        variant = thumbnails.get(size)
        if isinstance(variant, dict):
            url = variant.get("url")
            if isinstance(url, str) and url:
                return url
    return None


def get_channel_avatar_thumbnails(youtube: Resource, channel_ids: list[str]) -> tuple[dict[str, str], dict[str, str]]:
    """Fetch each channel's canonical avatar thumbnail URL via
    channels.list(part="snippet"), batched up to MAX_IDS_PER_REQUEST ids per
    call (Creator Master's C7A avatar sync -- never used by an ordinary
    frontend/API request, only maintenance tooling).

    Mirrors get_video_statistics's own batching/error-handling shape: a
    batch that fails outright is skipped (with a warning) rather than
    aborting the whole sync, except QuotaExhaustedError, which still
    propagates immediately since every remaining batch would fail the same
    way. Unlike get_video_statistics, this does not enrich QuotaExhaustedError
    with partial progress -- this is a one-shot manual maintenance sync
    (re-run later), not a production pipeline with per-run persistence to
    protect.

    Returns (avatar_url_by_channel_id, skip_reasons) -- skip_reasons maps
    every channel id that could not be resolved to why (missing from the
    response, no snippet, no usable thumbnail, or a batch-level API/network
    error), so a caller can report more than a bare count of what went
    unmatched. Duplicate input channel ids are deduplicated (first-seen
    order) before batching, so a channel shared by two creators is never
    fetched twice.
    """
    deduped_ids = list(dict.fromkeys(channel_ids))
    if not deduped_ids:
        return {}, {}

    avatars: dict[str, str] = {}
    skip_reasons: dict[str, str] = {}
    for start in range(0, len(deduped_ids), MAX_IDS_PER_REQUEST):
        batch = deduped_ids[start : start + MAX_IDS_PER_REQUEST]
        try:
            batch_avatars, batch_skip_reasons = _fetch_channel_avatar_batch(youtube, batch)
            avatars.update(batch_avatars)
            skip_reasons.update(batch_skip_reasons)
        except QuotaExhaustedError:
            raise
        except YouTubeAPIError as exc:
            print(f"Warning: skipping a batch of {len(batch)} channel ID(s) due to an API error: {exc}")
            for channel_id in batch:
                skip_reasons[channel_id] = f"YouTube API error: {exc}"
    return avatars, skip_reasons


def get_channel_statistics(youtube: Resource, channel_ids: list[str]) -> tuple[dict[str, dict], dict[str, str]]:
    """Fetch each channel's current subscriberCount via channels().list(part="statistics"),
    batched up to MAX_IDS_PER_REQUEST ids per call (subscriber-history foundation).

    Returns (result_by_channel_id, skip_reasons). Each successful result is
    {"subscriberCount": int | None, "hiddenSubscriberCount": bool} --
    subscriberCount is None exactly when hiddenSubscriberCount is True: YouTube
    returns a fabricated "0" for a channel whose owner has hidden their
    subscriber count, and that "0" must never be persisted or treated as a
    real value (a hidden count is not a zero count -- see
    _parse_channel_statistics_item's own docstring).

    Mirrors get_channel_avatar_thumbnails's own batching/dedup/error-handling
    shape (channel-keyed, not video-keyed): duplicate input channel ids are
    deduplicated up front (a channel shared by two creators is never fetched
    twice), and only QuotaExhaustedError propagates immediately (every
    remaining batch would fail the same way) -- any other batch-level failure
    is skipped with a reason so one bad batch doesn't sink the rest.

    Mirrors get_video_statistics's own quota-enrichment exactly (2026-09-29
    fix -- a bare `except QuotaExhaustedError: raise` here previously
    discarded every already-succeeded batch's results the moment a LATER
    batch in the same call hit quota, e.g. 100 successful channels lost
    because the 3rd of 3 batches for a 118-channel roster ran out of quota):
    the raised QuotaExhaustedError carries partial_results (a dict here,
    unlike get_video_statistics's own list -- this field is reused as-is
    rather than adding a channel-specific one, so no other caller of this
    shared exception class needs to change) and partial_skip_reasons
    (already-recorded reasons before the failure), plus remaining_video_ids
    (despite the video-specific name -- reused rather than renamed, since
    collection.main.py already reads this exact field name off the same
    exception class for get_video_statistics and must not be disturbed):
    every channel ID from the failing batch onward, never attempted.
    """
    deduped_ids = list(dict.fromkeys(channel_ids))
    if not deduped_ids:
        return {}, {}

    results: dict[str, dict] = {}
    skip_reasons: dict[str, str] = {}
    for start in range(0, len(deduped_ids), MAX_IDS_PER_REQUEST):
        batch = deduped_ids[start : start + MAX_IDS_PER_REQUEST]
        try:
            batch_results, batch_skip_reasons = _fetch_channel_statistics_batch(youtube, batch)
            results.update(batch_results)
            skip_reasons.update(batch_skip_reasons)
        except QuotaExhaustedError as exc:
            raise QuotaExhaustedError(
                str(exc),
                partial_results=results,
                partial_skip_reasons=skip_reasons,
                remaining_video_ids=deduped_ids[start:],
            ) from exc
        except YouTubeAPIError as exc:
            print(f"Warning: skipping a batch of {len(batch)} channel ID(s) due to an API error: {exc}")
            for channel_id in batch:
                skip_reasons[channel_id] = f"YouTube API error: {exc}"
    return results, skip_reasons


def _fetch_channel_statistics_batch(youtube: Resource, batch: list[str]) -> tuple[dict[str, dict], dict[str, str]]:
    """Fetch and parse one channels.list(part="statistics") batch, skipping
    missing/malformed/unexpected items with a reason instead of letting one
    bad item discard the whole batch's valid siblings (mirrors
    _fetch_channel_avatar_batch's exact shape)."""
    response = call_youtube_api(lambda: youtube.channels().list(part="statistics", id=",".join(batch)).execute())

    items = response.get("items")
    if items is None:
        raise YouTubeAPIError("Malformed response from YouTube API: missing 'items'")
    if not all(isinstance(item, dict) for item in items):
        raise YouTubeAPIError("Malformed response from YouTube API: 'items' contains a non-object entry")

    results: dict[str, dict] = {}
    skip_reasons: dict[str, str] = {}
    seen_ids: set[str] = set()

    for item in items:
        channel_id = item.get("id")
        if not isinstance(channel_id, str) or not channel_id:
            print("Warning: skipping a channels.list item with no usable 'id'")
            continue
        if channel_id not in batch:
            print(f"Warning: ignoring unrequested channel id in response: {channel_id}")
            continue
        if channel_id in seen_ids:
            print(f"Warning: duplicate channel id in response, keeping the first occurrence: {channel_id}")
            continue
        seen_ids.add(channel_id)

        try:
            results[channel_id] = _parse_channel_statistics_item(item)
        except YouTubeAPIError as exc:
            skip_reasons[channel_id] = str(exc)

    missing_ids = [channel_id for channel_id in batch if channel_id not in seen_ids]
    if missing_ids:
        print(f"Warning: no data returned for channel ID(s): {', '.join(missing_ids)}")
        for channel_id in missing_ids:
            skip_reasons[channel_id] = "No data returned by YouTube API (channel may be deleted/private/invalid id)"

    return results, skip_reasons


def _parse_channel_statistics_item(item: dict) -> dict:
    """Extract subscriberCount/hiddenSubscriberCount from one channels.list(part="statistics") item.

    subscriberCount is None exactly when hiddenSubscriberCount is true --
    YouTube's own documented behavior is to return a fabricated "0" for a
    hidden count, which this never surfaces as a real value (see
    get_channel_statistics's own docstring). A non-hidden item missing
    'subscriberCount' entirely is malformed, not silently zero.
    """
    try:
        statistics = item["statistics"]
        hidden = bool(statistics.get("hiddenSubscriberCount", False))
        if hidden:
            subscriber_count = None
        else:
            raw_count = statistics.get("subscriberCount")
            if raw_count is None:
                raise YouTubeAPIError("Malformed channel item: missing 'subscriberCount' and not marked hidden")
            subscriber_count = int(raw_count)
        return {"subscriberCount": subscriber_count, "hiddenSubscriberCount": hidden}
    except (KeyError, TypeError, ValueError) as exc:
        raise YouTubeAPIError(f"Malformed channel item, missing field: {exc}") from exc


def _fetch_channel_avatar_batch(youtube: Resource, batch: list[str]) -> tuple[dict[str, str], dict[str, str]]:
    """Fetch and parse one channels.list batch, skipping missing/malformed/
    unexpected items with a reason instead of letting one bad item discard
    the whole batch's valid siblings."""
    response = call_youtube_api(lambda: youtube.channels().list(part="snippet", id=",".join(batch)).execute())

    items = response.get("items")
    if items is None:
        raise YouTubeAPIError("Malformed response from YouTube API: missing 'items'")
    if not all(isinstance(item, dict) for item in items):
        raise YouTubeAPIError("Malformed response from YouTube API: 'items' contains a non-object entry")

    avatars: dict[str, str] = {}
    skip_reasons: dict[str, str] = {}
    seen_ids: set[str] = set()

    for item in items:
        channel_id = item.get("id")
        if not isinstance(channel_id, str) or not channel_id:
            print("Warning: skipping a channels.list item with no usable 'id'")
            continue
        if channel_id not in batch:
            print(f"Warning: ignoring unrequested channel id in response: {channel_id}")
            continue
        if channel_id in seen_ids:
            print(f"Warning: duplicate channel id in response, keeping the first occurrence: {channel_id}")
            continue
        seen_ids.add(channel_id)

        snippet = item.get("snippet")
        if not isinstance(snippet, dict):
            skip_reasons[channel_id] = "Malformed response: missing 'snippet'"
            continue
        avatar_url = select_channel_avatar_url(snippet.get("thumbnails"))
        if avatar_url is None:
            skip_reasons[channel_id] = "No usable thumbnail (high/medium/default) in channel snippet"
            continue
        avatars[channel_id] = avatar_url

    missing_ids = [channel_id for channel_id in batch if channel_id not in seen_ids]
    if missing_ids:
        print(f"Warning: no data returned for channel ID(s): {', '.join(missing_ids)}")
        for channel_id in missing_ids:
            skip_reasons[channel_id] = "No data returned by YouTube API (channel may be deleted/private/invalid id)"

    return avatars, skip_reasons


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
