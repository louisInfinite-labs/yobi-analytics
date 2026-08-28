"""Local prototype: retrieve public YouTube statistics for a fixed test set."""

from __future__ import annotations

import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

from config import MissingAPIKeyError, get_api_key
from youtube_client import YouTubeAPIError, build_youtube_client, get_video_statistics

TEST_VIDEO_IDS: list[str] = [
    "hP32yhLNgrQ",
]


def main() -> int:
    try:
        api_key = get_api_key()
    except MissingAPIKeyError as exc:
        print(f"Error: {exc}")
        return 1

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
