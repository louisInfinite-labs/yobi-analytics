"""Local prototype: retrieve public YouTube statistics for a fixed test set."""

from __future__ import annotations

import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

from config import MissingAPIKeyError, get_api_key
from creator_master import get_active_creators
from youtube_client import YouTubeAPIError, build_youtube_client, get_video_statistics

TEST_VIDEO_IDS: list[str] = [
    "hP32yhLNgrQ",
]


def main() -> int:
    """Fetch statistics for TEST_VIDEO_IDS and print them, returning the exit code."""
    try:
        api_key = get_api_key()
    except MissingAPIKeyError as exc:
        print(f"Error: {exc}")
        return 1

    active_creators = get_active_creators()
    if active_creators:
        creator = active_creators[0]
        print(f"Test creator: {creator.display_name} ({creator.organization})\n")

    try:
        youtube = build_youtube_client(api_key)
        videos = get_video_statistics(youtube, TEST_VIDEO_IDS)
    except YouTubeAPIError as exc:
        print(f"Error: {exc}")
        return 1

    if not videos:
        print("No video data returned.")
        return 0

    for video in videos:
        print(
            f"{video['videoId']} | {video['publishedAt']} | "
            f"{video['viewCount']:>10} views | {video['title']}"
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
