"""Video Master: the Tracking Universe of videos known for each creator."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from json_store import JsonStoreError, load_json_list, write_json_list

DEFAULT_VIDEO_MASTER_PATH = Path(__file__).parent / "video_master.json"


class VideoMasterError(JsonStoreError):
    """Raised when the Video Master JSON store is malformed or unwritable."""


@dataclass(frozen=True)
class Video:
    """A single tracked video's discovery metadata."""

    video_id: str
    creator_id: str
    title: str
    published_at: str


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


def upsert_videos(new_videos: list[Video], path: Path = DEFAULT_VIDEO_MASTER_PATH) -> None:
    """Insert or update videos into the Video Master file without creating duplicates."""
    existing = {video.video_id: video for video in load_videos(path)}
    for video in new_videos:
        existing[video.video_id] = video

    payload = [_to_raw(video) for video in existing.values()]
    write_json_list(path, payload, store_name="Video Master", error_class=VideoMasterError)


def _parse_video(raw: dict) -> Video:
    """Convert a raw Video Master JSON record into a Video instance."""
    try:
        return Video(
            video_id=raw["videoId"],
            creator_id=raw["creatorId"],
            title=raw["title"],
            published_at=raw["publishedAt"],
        )
    except (KeyError, TypeError) as exc:
        raise VideoMasterError(f"Malformed Video Master record, missing/invalid field: {exc}") from exc


def _to_raw(video: Video) -> dict:
    """Convert a Video instance into its JSON-serializable form."""
    return {
        "videoId": video.video_id,
        "creatorId": video.creator_id,
        "title": video.title,
        "publishedAt": video.published_at,
    }
