"""Tests for collection.youtube_client.get_archive_probe: one cheap batched videos.list per 50 ids, exact ids, no dependence on viewCount."""

from __future__ import annotations

import pytest

from collection import youtube_client
from collection.youtube_client import QuotaExhaustedError, YouTubeAPIError, get_archive_probe


class _FakeYouTube:
    """A videos().list(...).execute() double that answers from a queue and records every request."""

    def __init__(self, answers):
        """Init."""
        self.calls: list[dict] = []
        self._answers = list(answers)

    def videos(self):
        """Return self so the chained call reads like the real client."""
        return self

    def list(self, **kwargs):
        """Record the request and hand back an object whose execute() yields (or raises) the next answer."""
        self.calls.append(kwargs)
        answer = self._answers.pop(0)

        class _Request:
            def execute(self_inner):
                """Execute."""
                if isinstance(answer, Exception):
                    raise answer
                return answer

        return _Request()


def _item(video_id, **overrides):
    """Item."""
    item = {
        "id": video_id,
        "snippet": {"title": f"title {video_id}", "channelId": "UC_x", "publishedAt": "2026-10-15T09:00:00Z"},
        "liveStreamingDetails": {"actualEndTime": "2026-10-15T20:00:00Z"},
        "status": {"privacyStatus": "public", "uploadStatus": "processed", "embeddable": True},
        "statistics": {"viewCount": "42"},
    }
    item.update(overrides)
    return item


def test_returns_title_channel_end_time_playability_and_views_per_exact_id():
    """Returns title channel end time playability and views per exact id."""
    youtube = _FakeYouTube([{"items": [_item("a"), _item("b", liveStreamingDetails={})]}])

    probes = get_archive_probe(youtube, ["a", "b", "missing"])

    assert set(probes) == {"a", "b"}  # an id YouTube does not return is absent, not guessed
    assert probes["a"] == {
        "title": "title a", "channelId": "UC_x", "publishedAt": "2026-10-15T09:00:00Z", "actualEndTime": "2026-10-15T20:00:00Z",
        "privacyStatus": "public", "uploadStatus": "processed", "embeddable": True, "viewCount": 42,
    }
    assert probes["b"]["actualEndTime"] is None  # still live or upcoming: no end time
    assert youtube.calls == [{"part": "snippet,liveStreamingDetails,status,statistics", "id": "a,b,missing"}]  # one request, only the parts it needs


@pytest.mark.parametrize("statistics", [{}, {"viewCount": None}, {"viewCount": "not a number"}])
def test_a_hidden_or_missing_view_count_never_makes_a_video_unreadable(statistics):
    """A hidden or missing view count never makes a video unreadable."""
    youtube = _FakeYouTube([{"items": [_item("a", statistics=statistics)]}])

    probes = get_archive_probe(youtube, ["a"])

    assert probes["a"]["viewCount"] is None and probes["a"]["actualEndTime"] == "2026-10-15T20:00:00Z"


def test_an_item_with_no_statistics_object_at_all_is_still_returned():
    """An item with no statistics object at all is still returned."""
    item = _item("a")
    del item["statistics"]

    probes = get_archive_probe(_FakeYouTube([{"items": [item]}]), ["a"])

    assert probes["a"]["viewCount"] is None


def test_batches_at_the_documented_limit():
    """Batches at the documented limit."""
    ids = [f"v{i}" for i in range(youtube_client.MAX_IDS_PER_REQUEST + 3)]
    youtube = _FakeYouTube([{"items": []}, {"items": []}])

    get_archive_probe(youtube, ids)

    assert [len(call["id"].split(",")) for call in youtube.calls] == [youtube_client.MAX_IDS_PER_REQUEST, 3]


def test_a_malformed_response_raises_so_no_attempt_is_counted_as_made():
    """A malformed response raises so no attempt is counted as made."""
    with pytest.raises(YouTubeAPIError):
        get_archive_probe(_FakeYouTube([{"nope": []}]), ["a"])


def test_a_quota_wall_reports_what_earlier_batches_answered_and_which_ids_were_never_asked(monkeypatch):
    """A quota wall reports what earlier batches answered and which ids were never asked."""
    monkeypatch.setattr(youtube_client, "call_youtube_api", lambda executor: executor())
    ids = [f"v{i}" for i in range(youtube_client.MAX_IDS_PER_REQUEST + 2)]
    first_batch = {"items": [_item(ids[0])]}
    youtube = _FakeYouTube([first_batch, QuotaExhaustedError("quota")])

    with pytest.raises(QuotaExhaustedError) as caught:
        get_archive_probe(youtube, ids)

    assert [item["videoId"] for item in caught.value.partial_results] == [ids[0]]
    assert caught.value.remaining_video_ids == ids[youtube_client.MAX_IDS_PER_REQUEST :]


def test_no_ids_means_no_request():
    """No ids means no request."""
    youtube = _FakeYouTube([])

    assert get_archive_probe(youtube, []) == {}
    assert youtube.calls == []