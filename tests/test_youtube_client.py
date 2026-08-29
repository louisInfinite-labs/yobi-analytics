from unittest.mock import MagicMock

import pytest

from youtube_client import YouTubeAPIError, _fetch_batch, get_video_statistics


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


def test_fetch_batch_raises_on_missing_items():
    """_fetch_batch itself still raises on a malformed response missing 'items'."""
    youtube = _make_youtube_client({})

    with pytest.raises(YouTubeAPIError):
        _fetch_batch(youtube, ["abc123"])


def test_fetch_batch_raises_on_non_object_item():
    """An 'items' entry that isn't a dict (e.g. a string) raises YouTubeAPIError, not AttributeError."""
    youtube = _make_youtube_client({"items": ["not-a-dict"]})

    with pytest.raises(YouTubeAPIError):
        _fetch_batch(youtube, ["abc123"])


def test_get_video_statistics_skips_a_batch_that_fails_outright(capsys):
    """A whole batch failing (e.g. malformed response) is skipped with a warning,
    not raised, so it doesn't abort statistics collection for other batches."""
    youtube = _make_youtube_client({})

    result = get_video_statistics(youtube, ["abc123"])

    assert result == []
    assert "abc123" not in capsys.readouterr().out  # no per-video warning, just a batch-level one


def test_hidden_view_count_is_skipped_with_a_warning(capsys):
    """A video whose 'statistics' object is present but lacks 'viewCount'
    (a hidden/restricted view count) is skipped, not recorded as 0 views."""
    youtube = _make_youtube_client(
        {
            "items": [
                {
                    "id": "hidden1",
                    "snippet": {"title": "Hidden Stats", "publishedAt": "2026-08-25T12:00:00Z"},
                    "statistics": {"likeCount": "10"},
                }
            ]
        }
    )

    result = get_video_statistics(youtube, ["hidden1"])

    assert result == []
    assert "hidden1" in capsys.readouterr().out


def test_malformed_video_item_is_skipped_with_a_warning(capsys):
    """A single unparsable item (e.g. a members-only video with no visible statistics)
    is skipped with a warning instead of aborting the whole batch."""
    youtube = _make_youtube_client(
        {
            "items": [
                {"id": "abc123", "snippet": {"title": "No stats"}},
                {
                    "id": "def456",
                    "snippet": {"title": "Fine Video", "publishedAt": "2026-08-25T12:00:00Z"},
                    "statistics": {"viewCount": "42"},
                },
            ]
        }
    )

    result = get_video_statistics(youtube, ["abc123", "def456"])

    assert [video["videoId"] for video in result] == ["def456"]
    assert "abc123" in capsys.readouterr().out


def test_one_failing_batch_does_not_abort_the_others(capsys):
    """If one batch's API call fails, other batches still get processed and returned."""
    youtube = MagicMock()
    good_response = {
        "items": [
            {
                "id": f"id{i}",
                "snippet": {"title": f"Video {i}", "publishedAt": "2026-08-25T12:00:00Z"},
                "statistics": {"viewCount": "1"},
            }
            for i in range(50)
        ]
    }
    youtube.videos.return_value.list.return_value.execute.side_effect = [
        ConnectionError("network blip"),  # first batch call fails
        good_response,  # second batch succeeds
    ]
    video_ids = [f"id{i}" for i in range(60)]

    result = get_video_statistics(youtube, video_ids)

    assert len(result) == 50
    assert "network blip" in capsys.readouterr().out


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

    calls = youtube.videos.return_value.list.call_args_list
    assert len(calls) == 2
    assert calls[0].kwargs["id"] == ",".join(f"id{i}" for i in range(0, 50))
    assert calls[1].kwargs["id"] == ",".join(f"id{i}" for i in range(50, 60))
