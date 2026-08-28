from unittest.mock import MagicMock

import pytest

from youtube_client import YouTubeAPIError, get_video_statistics


def _make_youtube_client(response):
    youtube = MagicMock()
    youtube.videos.return_value.list.return_value.execute.return_value = response
    return youtube


def test_returns_structured_data_for_valid_video():
    response = {
        "items": [
            {
                "id": "abc123",
                "snippet": {
                    "title": "藍沢エマ Test Video",
                    "publishedAt": "2026-08-25T12:00:00Z",
                },
                "statistics": {"viewCount": "125000"},
            }
        ]
    }
    youtube = _make_youtube_client(response)

    result = get_video_statistics(youtube, ["abc123"])

    assert result == [
        {
            "videoId": "abc123",
            "title": "藍沢エマ Test Video",
            "publishedAt": "2026-08-25T12:00:00Z",
            "viewCount": 125000,
        }
    ]


def test_empty_video_ids_returns_empty_list_without_calling_api():
    youtube = MagicMock()

    result = get_video_statistics(youtube, [])

    assert result == []
    youtube.videos.assert_not_called()


def test_invalid_video_id_is_skipped_with_a_warning(capsys):
    youtube = _make_youtube_client({"items": []})

    result = get_video_statistics(youtube, ["does_not_exist"])

    assert result == []
    assert "does_not_exist" in capsys.readouterr().out


def test_malformed_response_missing_items_raises():
    youtube = _make_youtube_client({})

    with pytest.raises(YouTubeAPIError):
        get_video_statistics(youtube, ["abc123"])


def test_malformed_video_item_missing_field_raises():
    youtube = _make_youtube_client(
        {"items": [{"id": "abc123", "snippet": {"title": "No stats"}}]}
    )

    with pytest.raises(YouTubeAPIError):
        get_video_statistics(youtube, ["abc123"])


def test_requests_are_batched_at_fifty_ids():
    response_batch = {
        "items": [
            {
                "id": f"id{i}",
                "snippet": {"title": f"Video {i}", "publishedAt": "2026-08-25T12:00:00Z"},
                "statistics": {"viewCount": "1"},
            }
            for i in range(50)
        ]
    }
    youtube = _make_youtube_client(response_batch)
    video_ids = [f"id{i}" for i in range(60)]

    get_video_statistics(youtube, video_ids)

    assert youtube.videos.return_value.list.call_count == 2
