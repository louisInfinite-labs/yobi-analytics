"""Classify an UNCLASSIFIED upcoming stream at request time, with the collector's own classifier.

Holodex lists a YouTube Premiere exactly like a stream, and a video the collector has not observed yet has no stored classification.
For such an UPCOMING candidate (and only such a one) the YouTube Data API settles it: collection.youtube_client._parse_video_item -- the
SAME function that fills Video Master -- reads `contentDetails.duration` (absent for an upcoming Premiere, "P0D" for a real upcoming
stream). There is no second heuristic here: this module only asks YouTube about the ids and hands the answer to that classifier.

Rules:
- only definitive answers are used: ("upload", None) for a Premiere, ("live", "upcoming") for a real upcoming stream;
- a failed or ambiguous lookup (no key configured, quota, network, the id not returned, any other shape) is "unknown": the caller keeps the
  stream, never guessing from the title, and the case is logged;
- answers are cached in memory per warm Lambda (an upcoming video's classification does not change until it starts), and a failure is
  remembered for a short time too, so a missing key or an outage costs one attempt per window, not one per request.
"""

from __future__ import annotations

import time

Classification = tuple[str, "str | None"]  # (contentType, liveStatus)

# An upcoming video's classification is stable until it starts; an hour is far shorter than the time between scheduling and starting.
_ANSWER_TTL_SECONDS = 3600.0
# After a failed lookup the same ids are not asked again for this long.
_FAILURE_TTL_SECONDS = 300.0

_cache: dict[str, tuple[float, Classification | None]] = {}


def clear_cache() -> None:
    """Forget every cached answer and failure (tests)."""
    _cache.clear()


def _fetch_classifications(video_ids: list[str]) -> dict[str, Classification]:
    """Ask the YouTube Data API (one batched videos.list) and classify each returned item with the collector's classifier.

    Raises whatever the key lookup / request raises; the caller treats every exception as "unknown".
    """
    from collection.youtube_client import build_youtube_client, get_video_statistics
    from ops.config import get_api_key

    results, _skipped = get_video_statistics(build_youtube_client(get_api_key()), video_ids)
    return {result["videoId"]: (result["contentType"], result["liveStatus"]) for result in results}


def _is_definitive(classification: Classification) -> bool:
    """Only a Premiere (an upload) or a real upcoming stream is a usable answer for an upcoming candidate."""
    return classification in (("upload", None), ("live", "upcoming"))


def classify_unclassified_upcoming(video_ids: list[str], *, now: float | None = None) -> dict[str, Classification]:
    """videoId -> (contentType, liveStatus) for the ids that could be classified; an id that is missing is UNKNOWN (keep the stream)."""
    if not video_ids:
        return {}
    moment = time.monotonic() if now is None else now
    answers: dict[str, Classification] = {}
    to_ask: list[str] = []
    for video_id in dict.fromkeys(video_ids):
        cached = _cache.get(video_id)
        if cached is not None and cached[0] > moment:
            if cached[1] is not None:
                answers[video_id] = cached[1]
            continue
        to_ask.append(video_id)
    if not to_ask:
        return answers
    try:
        fetched = _fetch_classifications(to_ask)
    except Exception as exc:  # noqa: BLE001 -- every failure mode means "unknown", never "hide the stream"
        print(f"Warning: could not classify {len(to_ask)} unclassified upcoming stream(s) ({type(exc).__name__}): {exc}; keeping them as livestreams")
        for video_id in to_ask:
            _cache[video_id] = (moment + _FAILURE_TTL_SECONDS, None)
        return answers
    unknown = []
    for video_id in to_ask:
        classification = fetched.get(video_id)
        if classification is not None and _is_definitive(classification):
            _cache[video_id] = (moment + _ANSWER_TTL_SECONDS, classification)
            answers[video_id] = classification
        else:
            unknown.append(video_id)
            _cache[video_id] = (moment + _FAILURE_TTL_SECONDS, None)
    if unknown:
        print(f"Warning: {len(unknown)} unclassified upcoming stream(s) had no definitive classification (kept as livestreams): {', '.join(unknown)}")
    return answers
