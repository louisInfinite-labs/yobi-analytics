"""Video Master: the Tracking Universe of videos known for each creator."""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

from json_store import DATA_DIR, JsonStoreError, load_json_list, write_json_list

# DATA_DIR defaults to this package's own directory locally, but is overridden
# to /tmp on Lambda, where the deployment package itself is read-only (see
# Roadmap 2.2 "Known Constraint").
DEFAULT_VIDEO_MASTER_PATH = DATA_DIR / "video_master.json"


class VideoMasterError(JsonStoreError):
    """Raised when the Video Master JSON store is malformed or unwritable."""


VALID_ACTIVITY_STATES = {"Unknown", "Hot", "Warm", "Cold"}


@dataclass(frozen=True)
class Video:
    """A single tracked video's discovery metadata plus its Adaptive Tracking
    Frequency scheduler state (Roadmap 1.5/2.3)."""

    video_id: str
    creator_id: str
    title: str
    published_at: str
    # Every newly discovered video bootstraps as "Unknown" regardless of
    # age/views; see tracking_schedule.classify_after_observation for how it
    # evolves after each statistics snapshot.
    activity_state: str = "Unknown"
    last_checked_at: str | None = None
    last_view_count: int | None = None
    snapshot_count: int = 0
    quiet_streak: int = 0
    last_classification_reason: str | None = None
    # The percent-of-views-per-day and absolute-views-per-day growth measured
    # for the observation that produced last_classification_reason — the
    # velocity the Hot/Warm/Cold decision was actually made on (Roadmap 1.5),
    # so it can be audited or used to retune thresholds without recomputing
    # it from raw snapshot history. None only when last_classification_reason
    # is "bootstrap_first_snapshot" (no prior observation to measure against).
    last_percent_growth_per_day: float | None = None
    last_avg_views_per_day: float | None = None
    # When this project's own collector first discovered/started tracking
    # this video — distinct from `published_at` (when it went up on
    # YouTube), which can predate onboarding by years for a channel's back
    # catalog picked up by Initial Discovery. None for a record written
    # before this field existed; read_api.py falls back to the global
    # COLLECTION_START_DATE in that case (Roadmap 3.4's documented
    # simplification for pre-existing records).
    discovered_at: str | None = None


def load_videos(path: Path = DEFAULT_VIDEO_MASTER_PATH) -> list[Video]:
    """Load every video currently in the Tracking Universe."""
    raw_videos = load_json_list(path, store_name="Video Master", error_class=VideoMasterError)
    return [_parse_video(raw) for raw in raw_videos]


def load_video_ids_for_creator(
    creator_id: str, path: Path = DEFAULT_VIDEO_MASTER_PATH, *, videos: list[Video] | None = None
) -> set[str]:
    """Return the set of video IDs already known for one creator.

    Pass an already-loaded `videos` list to avoid re-reading the store from
    disk when the caller is processing many creators in one run.
    """
    if videos is None:
        videos = load_videos(path)
    return {video.video_id for video in videos if video.creator_id == creator_id}


def get_video(video_id: str, path: Path = DEFAULT_VIDEO_MASTER_PATH, *, videos: list[Video] | None = None) -> Video | None:
    """Return one video by ID, or None if it isn't in the Tracking Universe.

    Pass an already-loaded `videos` list to avoid re-reading the store from
    disk when the caller already has it (mirrors load_video_ids_for_creator).
    """
    if videos is None:
        videos = load_videos(path)
    for video in videos:
        if video.video_id == video_id:
            return video
    return None


def upsert_videos(new_videos: list[Video], path: Path = DEFAULT_VIDEO_MASTER_PATH) -> None:
    """Insert or update videos into the Video Master file without creating duplicates."""
    existing = {video.video_id: video for video in load_videos(path)}
    for video in new_videos:
        existing[video.video_id] = video

    payload = [_to_raw(video) for video in existing.values()]
    write_json_list(path, payload, store_name="Video Master", error_class=VideoMasterError)


def _parse_video(raw: dict) -> Video:
    """Convert a raw Video Master JSON record into a Video instance.

    activityState/lastCheckedAt/lastViewCount/snapshotCount/quietStreak/
    lastClassificationReason/lastPercentGrowthPerDay/lastAvgViewsPerDay/
    discoveredAt are all optional with bootstrap-equivalent defaults, so
    records written before Roadmap 1.5's scheduler-state fields (or before
    discoveredAt) existed still parse — as if never yet classified.
    """
    try:
        video_id = _require_str(raw, "videoId")

        activity_state = raw.get("activityState", "Unknown")
        if activity_state not in VALID_ACTIVITY_STATES:
            raise VideoMasterError(f"Video {video_id!r} has invalid 'activityState': {activity_state!r}")

        return Video(
            video_id=video_id,
            creator_id=_require_str(raw, "creatorId"),
            title=_require_str(raw, "title"),
            published_at=_require_str(raw, "publishedAt"),
            activity_state=activity_state,
            last_checked_at=_optional_str(raw, "lastCheckedAt", video_id),
            last_view_count=_optional_int(raw, "lastViewCount", video_id),
            snapshot_count=_int_with_default(raw, "snapshotCount", 0, video_id),
            quiet_streak=_int_with_default(raw, "quietStreak", 0, video_id),
            last_classification_reason=_optional_str(raw, "lastClassificationReason", video_id),
            last_percent_growth_per_day=_optional_float(raw, "lastPercentGrowthPerDay", video_id),
            last_avg_views_per_day=_optional_float(raw, "lastAvgViewsPerDay", video_id),
            discovered_at=_optional_str(raw, "discoveredAt", video_id),
        )
    except (KeyError, TypeError) as exc:
        raise VideoMasterError(f"Malformed Video Master record, missing/invalid field: {exc}") from exc


def _require_str(raw: dict, field: str) -> str:
    """Return raw[field] as a non-empty string, or raise VideoMasterError."""
    value = raw.get(field)
    if not isinstance(value, str) or not value:
        raise VideoMasterError(f"Video Master record has invalid {field!r}: {value!r}")
    return value


def _optional_str(raw: dict, field: str, video_id: str) -> str | None:
    """Return raw[field] as a string if present and non-null, else None."""
    value = raw.get(field)
    if value is None:
        return None
    if not isinstance(value, str):
        raise VideoMasterError(f"Video {video_id!r} has non-string {field!r}: {value!r}")
    return value


def _optional_int(raw: dict, field: str, video_id: str) -> int | None:
    """Return raw[field] as an int if present and non-null, else None."""
    value = raw.get(field)
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool):
        raise VideoMasterError(f"Video {video_id!r} has non-integer {field!r}: {value!r}")
    return value


def _int_with_default(raw: dict, field: str, default: int, video_id: str) -> int:
    """Return raw[field] as an int, or `default` if the key is absent."""
    value = raw.get(field, default)
    if not isinstance(value, int) or isinstance(value, bool):
        raise VideoMasterError(f"Video {video_id!r} has non-integer {field!r}: {value!r}")
    return value


def _optional_float(raw: dict, field: str, video_id: str) -> float | None:
    """Return raw[field] as a float if present and non-null, else None.

    A whole-number measurement round-trips through JSON without a decimal
    point (e.g. 1000 rather than 1000.0), so a bare int is accepted too —
    just not a bool, which is technically an int subclass in Python. NaN/
    +-Infinity are rejected too: standard JSON has no token for them, so
    json.dump would silently emit non-conformant output (`NaN`/`Infinity`)
    when this value is later written back out via _to_raw.
    """
    value = raw.get(field)
    if value is None:
        return None
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise VideoMasterError(f"Video {video_id!r} has non-numeric {field!r}: {value!r}")
    if not math.isfinite(value):
        raise VideoMasterError(f"Video {video_id!r} has non-finite {field!r}: {value!r}")
    return float(value)


def _to_raw(video: Video) -> dict:
    """Convert a Video instance into its JSON-serializable form."""
    return {
        "videoId": video.video_id,
        "creatorId": video.creator_id,
        "title": video.title,
        "publishedAt": video.published_at,
        "activityState": video.activity_state,
        "lastCheckedAt": video.last_checked_at,
        "lastViewCount": video.last_view_count,
        "snapshotCount": video.snapshot_count,
        "quietStreak": video.quiet_streak,
        "lastClassificationReason": video.last_classification_reason,
        "lastPercentGrowthPerDay": video.last_percent_growth_per_day,
        "lastAvgViewsPerDay": video.last_avg_views_per_day,
        "discoveredAt": video.discovered_at,
    }
