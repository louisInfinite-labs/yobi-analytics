"""B18: the channel's Shorts shelf (its "UUSH" playlist) is the authoritative source for "is this video a Short"."""

from unittest.mock import MagicMock

import pytest

from collection.youtube_client import YouTubeAPIError
from tracking import video_discovery
from tracking.video_discovery import discover_short_video_ids, get_shorts_playlist_id


def _item(video_id):
    return {"snippet": {"resourceId": {"videoId": video_id}, "title": f"t {video_id}", "publishedAt": "2026-09-01T00:00:00Z"}}


def _youtube(*pages):
    youtube = MagicMock()
    youtube.playlistItems.return_value.list.return_value.execute.side_effect = list(pages)
    return youtube


def test_the_shorts_playlist_id_is_derived_from_the_channel_id():
    assert get_shorts_playlist_id("UCabc-123_xyz") == "UUSHabc-123_xyz"


@pytest.mark.parametrize("channel_id", ["", "UC", "XYZabc", "uc_lowercase"])
def test_a_channel_id_without_a_uc_prefix_has_no_shorts_playlist(channel_id):
    assert get_shorts_playlist_id(channel_id) is None


def test_it_collects_every_id_on_the_shelf_across_pages_for_initial_discovery():
    youtube = _youtube(
        {"items": [_item("s1"), _item("s2")], "nextPageToken": "p2"},
        {"items": [_item("s3")]},
    )

    assert discover_short_video_ids(youtube, "UUSHabc") == {"s1", "s2", "s3"}
    assert youtube.playlistItems.return_value.list.call_args_list[0].kwargs["playlistId"] == "UUSHabc"


def test_incremental_discovery_stops_at_the_first_already_known_video():
    youtube = _youtube({"items": [_item("new1"), _item("known"), _item("older")], "nextPageToken": "p2"}, {"items": [_item("never-read")]})

    assert discover_short_video_ids(youtube, "UUSHabc", {"known"}) == {"new1"}
    assert youtube.playlistItems.return_value.list.return_value.execute.call_count == 1


def test_a_channel_with_no_shorts_shelf_is_a_real_empty_result(monkeypatch):
    def not_found(executor):
        raise YouTubeAPIError("YouTube API request failed (status 404): The playlist identified with the request's playlistId parameter cannot be found.")

    monkeypatch.setattr(video_discovery, "call_youtube_api", not_found)

    assert discover_short_video_ids(MagicMock(), "UUSHabc") == set()


@pytest.mark.parametrize("message", ["YouTube API request failed (status 403): forbidden", "YouTube API request failed (status 500): backend error"])
def test_any_other_failure_propagates_instead_of_meaning_not_a_short(monkeypatch, message):
    def failing(executor):
        raise YouTubeAPIError(message)

    monkeypatch.setattr(video_discovery, "call_youtube_api", failing)

    with pytest.raises(YouTubeAPIError):
        discover_short_video_ids(MagicMock(), "UUSHabc")
