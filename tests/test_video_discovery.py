from unittest.mock import MagicMock

import pytest

from video_discovery import discover_all_videos, discover_new_videos, get_uploads_playlist_id
from youtube_client import YouTubeAPIError


def _make_channels_response(uploads_playlist_id):
    return {"items": [{"contentDetails": {"relatedPlaylists": {"uploads": uploads_playlist_id}}}]}


def _make_playlist_item(video_id, title, published_at):
    return {
        "snippet": {
            "resourceId": {"videoId": video_id},
            "title": title,
            "publishedAt": published_at,
        }
    }


def test_get_uploads_playlist_id_parses_response():
    """The uploads playlist ID is extracted from channels.list's contentDetails."""
    youtube = MagicMock()
    youtube.channels.return_value.list.return_value.execute.return_value = _make_channels_response(
        "UU_TEST_UPLOADS"
    )

    assert get_uploads_playlist_id(youtube, "UC_TEST_CHANNEL") == "UU_TEST_UPLOADS"


def test_get_uploads_playlist_id_raises_on_unknown_channel():
    """An empty channels.list response raises YouTubeAPIError instead of crashing."""
    youtube = MagicMock()
    youtube.channels.return_value.list.return_value.execute.return_value = {"items": []}

    with pytest.raises(YouTubeAPIError):
        get_uploads_playlist_id(youtube, "UC_UNKNOWN")


def test_discover_all_videos_pages_through_next_page_token():
    """Initial Discovery follows nextPageToken until every page has been scanned."""
    youtube = MagicMock()
    page_1 = {
        "items": [_make_playlist_item("vid1", "Video 1", "2026-08-20T00:00:00Z")],
        "nextPageToken": "page2",
    }
    page_2 = {"items": [_make_playlist_item("vid2", "Video 2", "2026-08-10T00:00:00Z")]}
    youtube.playlistItems.return_value.list.return_value.execute.side_effect = [page_1, page_2]

    videos = discover_all_videos(youtube, "UU_TEST_UPLOADS")

    assert [v["videoId"] for v in videos] == ["vid1", "vid2"]
    assert youtube.playlistItems.return_value.list.return_value.execute.call_count == 2


def test_discover_new_videos_stops_at_known_video():
    """Incremental Discovery stops paging once it reaches an already-known video."""
    youtube = MagicMock()
    page_1 = {
        "items": [
            _make_playlist_item("new1", "New Video 1", "2026-08-29T00:00:00Z"),
            _make_playlist_item("known1", "Known Video", "2026-08-20T00:00:00Z"),
        ],
        "nextPageToken": "page2",
    }
    youtube.playlistItems.return_value.list.return_value.execute.side_effect = [page_1]

    new_videos = discover_new_videos(youtube, "UU_TEST_UPLOADS", {"known1"})

    assert [v["videoId"] for v in new_videos] == ["new1"]
    assert youtube.playlistItems.return_value.list.return_value.execute.call_count == 1


def test_one_malformed_item_does_not_discard_the_rest_of_the_page(capsys):
    """A single malformed entry is skipped with a warning; other videos on the same
    and later pages are still returned instead of the whole call aborting."""
    youtube = MagicMock()
    page_1 = {
        "items": [
            _make_playlist_item("vid1", "Video 1", "2026-08-20T00:00:00Z"),
            {"snippet": {"title": "Missing resourceId"}},  # malformed: no resourceId
        ],
        "nextPageToken": "page2",
    }
    page_2 = {"items": [_make_playlist_item("vid2", "Video 2", "2026-08-10T00:00:00Z")]}
    youtube.playlistItems.return_value.list.return_value.execute.side_effect = [page_1, page_2]

    videos = discover_all_videos(youtube, "UU_TEST_UPLOADS")

    assert [v["videoId"] for v in videos] == ["vid1", "vid2"]
    assert "could not parse" in capsys.readouterr().out


def test_non_string_field_is_skipped_not_crashed(capsys):
    """A playlist item whose title/videoId/publishedAt is a non-string (e.g. None)
    is skipped with a warning instead of raising TypeError downstream."""
    youtube = MagicMock()
    page_1 = {
        "items": [
            {
                "snippet": {
                    "resourceId": {"videoId": "vid1"},
                    "title": None,  # non-string
                    "publishedAt": "2026-08-20T00:00:00Z",
                }
            },
            _make_playlist_item("vid2", "Video 2", "2026-08-10T00:00:00Z"),
        ]
    }
    youtube.playlistItems.return_value.list.return_value.execute.side_effect = [page_1]

    videos = discover_all_videos(youtube, "UU_TEST_UPLOADS")

    assert [v["videoId"] for v in videos] == ["vid2"]
    assert "non-string" in capsys.readouterr().out
