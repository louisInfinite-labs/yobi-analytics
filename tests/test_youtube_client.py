import json
from unittest.mock import MagicMock

import pytest

from youtube_client import (
    MAX_RETRIES,
    QuotaExhaustedError,
    YouTubeAPIError,
    _fetch_batch,
    call_youtube_api,
    get_video_statistics,
)


def _http_error(status: int, reason: str | None = None):
    """Build an HttpError with the given HTTP status and optional YouTube error reason code."""
    from googleapiclient.errors import HttpError

    response = MagicMock(status=status, reason="error")
    if reason is None:
        return HttpError(response, b"not json")
    content = json.dumps({"error": {"errors": [{"reason": reason, "message": "boom"}], "message": "boom"}})
    return HttpError(response, content.encode("utf-8"))


def _make_youtube_client(response):
    """Build a mock YouTube client whose videos().list().execute() returns the given response."""
    youtube = MagicMock()
    youtube.videos.return_value.list.return_value.execute.return_value = response
    return youtube


def test_call_youtube_api_retries_transient_errors_then_succeeds(monkeypatch):
    """A connection error on the first attempt is retried and succeeds on the second."""
    monkeypatch.setattr("youtube_client.time.sleep", lambda _seconds: None)
    executor = MagicMock(side_effect=[ConnectionError("blip"), "ok"])

    result = call_youtube_api(executor)

    assert result == "ok"
    assert executor.call_count == 2


def test_call_youtube_api_gives_up_after_max_retries(monkeypatch):
    """After MAX_RETRIES consecutive transient failures, it raises instead of retrying forever."""
    monkeypatch.setattr("youtube_client.time.sleep", lambda _seconds: None)
    executor = MagicMock(side_effect=ConnectionError("persistent blip"))

    with pytest.raises(YouTubeAPIError, match="after 3 attempts"):
        call_youtube_api(executor)

    assert executor.call_count == MAX_RETRIES


def test_call_youtube_api_retries_dns_and_ssl_failures(monkeypatch):
    """DNS resolution and SSL/TLS failures (both OSError subclasses, e.g. from a
    flaky local network, not just the API's own ConnectionError/TimeoutError)
    are retried the same way."""
    import socket
    import ssl

    monkeypatch.setattr("youtube_client.time.sleep", lambda _seconds: None)

    for local_network_error in (socket.gaierror("DNS lookup failed"), ssl.SSLError("handshake failed")):
        executor = MagicMock(side_effect=[local_network_error, "ok"])
        result = call_youtube_api(executor)
        assert result == "ok"


def test_call_youtube_api_does_not_retry_non_retryable_http_errors(monkeypatch):
    """A non-retryable HTTP-level error (e.g. a plain 404) fails immediately without retrying."""
    monkeypatch.setattr("youtube_client.time.sleep", lambda _seconds: None)
    executor = MagicMock(side_effect=_http_error(404))

    with pytest.raises(YouTubeAPIError):
        call_youtube_api(executor)

    assert executor.call_count == 1


def test_call_youtube_api_retries_http_429_then_succeeds(monkeypatch):
    """A bare 429 (no parseable reason) is retried like a transient failure."""
    monkeypatch.setattr("youtube_client.time.sleep", lambda _seconds: None)
    executor = MagicMock(side_effect=[_http_error(429), "ok"])

    result = call_youtube_api(executor)

    assert result == "ok"
    assert executor.call_count == 2


def test_call_youtube_api_retries_rate_limit_exceeded_reason(monkeypatch):
    """YouTube's rateLimitExceeded reason is retried even though the HTTP status (403)
    alone would not be — the reason code takes priority."""
    monkeypatch.setattr("youtube_client.time.sleep", lambda _seconds: None)
    executor = MagicMock(side_effect=[_http_error(403, "rateLimitExceeded"), "ok"])

    result = call_youtube_api(executor)

    assert result == "ok"
    assert executor.call_count == 2


def test_call_youtube_api_gives_up_after_max_retries_on_retryable_http_error(monkeypatch):
    """A persistently retryable HTTP error still gives up after MAX_RETRIES, not forever."""
    monkeypatch.setattr("youtube_client.time.sleep", lambda _seconds: None)
    executor = MagicMock(side_effect=_http_error(503))

    with pytest.raises(YouTubeAPIError, match="after 3 attempts"):
        call_youtube_api(executor)

    assert executor.call_count == MAX_RETRIES


def test_call_youtube_api_raises_quota_exhausted_immediately_without_retrying(monkeypatch):
    """quotaExceeded stops immediately — retrying would just waste more quota."""
    monkeypatch.setattr("youtube_client.time.sleep", lambda _seconds: None)
    executor = MagicMock(side_effect=_http_error(403, "quotaExceeded"))

    with pytest.raises(QuotaExhaustedError):
        call_youtube_api(executor)

    assert executor.call_count == 1


def test_call_youtube_api_raises_quota_exhausted_for_daily_limit_exceeded(monkeypatch):
    """dailyLimitExceeded, like quotaExceeded, stops immediately without retrying."""
    monkeypatch.setattr("youtube_client.time.sleep", lambda _seconds: None)
    executor = MagicMock(side_effect=_http_error(403, "dailyLimitExceeded"))

    with pytest.raises(QuotaExhaustedError):
        call_youtube_api(executor)

    assert executor.call_count == 1


def test_returns_structured_data_for_valid_video():
    """A well-formed videos.list item is parsed into the expected result shape."""
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

    result, skip_reasons = get_video_statistics(youtube, ["abc123"])

    assert result == [
        {
            "videoId": "abc123",
            "title": "藍沢エマ Test Video",
            "publishedAt": "2026-08-25T12:00:00Z",
            "viewCount": 125000,
        }
    ]
    assert skip_reasons == {}


def test_empty_video_ids_returns_empty_list_without_calling_api():
    """An empty video ID list short-circuits without issuing any API call."""
    youtube = MagicMock()

    result, skip_reasons = get_video_statistics(youtube, [])

    assert result == []
    assert skip_reasons == {}
    youtube.videos.assert_not_called()


def test_invalid_video_id_is_skipped_with_a_warning(capsys):
    """A video ID with no matching item in the response is skipped, not silently dropped."""
    youtube = _make_youtube_client({"items": []})

    result, skip_reasons = get_video_statistics(youtube, ["does_not_exist"])

    assert result == []
    assert "does_not_exist" in capsys.readouterr().out
    assert "does_not_exist" in skip_reasons


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

    result, skip_reasons = get_video_statistics(youtube, ["abc123"])

    assert result == []
    assert "abc123" not in capsys.readouterr().out  # no per-video warning, just a batch-level one
    assert "YouTube API error" in skip_reasons["abc123"]


def test_get_video_statistics_stops_immediately_on_quota_exhaustion(monkeypatch):
    """Unlike an ordinary batch failure, quota exhaustion on one batch must not
    be treated as "skip and continue" — with potentially thousands of
    remaining batches, that would just keep re-issuing doomed requests."""
    monkeypatch.setattr("youtube_client.time.sleep", lambda _seconds: None)
    youtube = MagicMock()
    youtube.videos.return_value.list.return_value.execute.side_effect = _http_error(403, "quotaExceeded")
    video_ids = [f"id{i}" for i in range(150)]  # three batches of 50

    with pytest.raises(QuotaExhaustedError):
        get_video_statistics(youtube, video_ids)

    # Only the first batch should have been attempted — quota exhaustion on
    # it must stop before any later batch is even requested.
    assert youtube.videos.return_value.list.return_value.execute.call_count == 1


def test_quota_exhausted_error_carries_partial_progress():
    """Statistics already fetched before quota ran out, and the video IDs
    never attempted, must both be recoverable from the exception — losing
    already-paid-for results along with the error would waste real quota."""
    youtube = MagicMock()
    good_batch_response = {
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
        good_batch_response,  # batch 1 (ids 0-49): succeeds
        _http_error(403, "quotaExceeded"),  # batch 2 (ids 50-99): quota runs out here
    ]
    video_ids = [f"id{i}" for i in range(150)]  # three batches of 50

    with pytest.raises(QuotaExhaustedError) as exc_info:
        get_video_statistics(youtube, video_ids)

    exc = exc_info.value
    assert len(exc.partial_results) == 50
    assert {video["videoId"] for video in exc.partial_results} == {f"id{i}" for i in range(50)}
    # Batch 2's IDs never got a result, and batch 3 was never even attempted —
    # both must be reported as never-attempted, not silently dropped.
    assert set(exc.remaining_video_ids) == {f"id{i}" for i in range(50, 150)}


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

    result, skip_reasons = get_video_statistics(youtube, ["hidden1"])

    assert result == []
    assert "hidden1" in capsys.readouterr().out
    assert "hidden1" in skip_reasons


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

    result, skip_reasons = get_video_statistics(youtube, ["abc123", "def456"])

    assert [video["videoId"] for video in result] == ["def456"]
    assert "abc123" in capsys.readouterr().out
    assert "abc123" in skip_reasons


def test_one_failing_batch_does_not_abort_the_others(monkeypatch, capsys):
    """If one batch exhausts its retries, other batches still get processed and returned."""
    monkeypatch.setattr("youtube_client.time.sleep", lambda _seconds: None)
    youtube = MagicMock()
    good_response = {
        "items": [
            {
                "id": f"id{50 + i}",
                "snippet": {"title": f"Video {50 + i}", "publishedAt": "2026-08-25T12:00:00Z"},
                "statistics": {"viewCount": "1"},
            }
            for i in range(10)
        ]
    }
    youtube.videos.return_value.list.return_value.execute.side_effect = [
        ConnectionError("network blip"),  # first batch (ids 0-49): fails all 3 attempts
        ConnectionError("network blip"),
        ConnectionError("network blip"),
        good_response,  # second batch (ids 50-59) succeeds
    ]
    video_ids = [f"id{i}" for i in range(60)]

    result, skip_reasons = get_video_statistics(youtube, video_ids)

    assert len(result) == 10
    assert "network blip" in capsys.readouterr().out
    assert len(skip_reasons) == 50
    assert "YouTube API error" in skip_reasons["id0"]


def test_requests_are_batched_at_fifty_ids():
    """More than MAX_IDS_PER_REQUEST video IDs are split across multiple batched calls."""
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
