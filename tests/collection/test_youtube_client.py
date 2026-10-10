import json
from unittest.mock import MagicMock

import pytest

from collection.youtube_client import (
    MAX_IDS_PER_REQUEST,
    MAX_RETRIES,
    QuotaExhaustedError,
    YouTubeAPIError,
    _fetch_batch,
    call_youtube_api,
    get_channel_avatar_thumbnails,
    get_video_statistics,
    select_channel_avatar_url,
)


def _http_error(status: int, reason: str | None = None, *, uri: str | None = None):
    """Build an HttpError with the given HTTP status, optional YouTube error reason
    code, and optional request URI (as googleapiclient itself attaches -- includes
    the live API key as `?key=...` for a real request)."""
    from googleapiclient.errors import HttpError

    response = MagicMock(status=status, reason="error")
    if reason is None:
        return HttpError(response, b"not json", uri=uri)
    content = json.dumps({"error": {"errors": [{"reason": reason, "message": "boom"}], "message": "boom"}})
    return HttpError(response, content.encode("utf-8"), uri=uri)


def _make_youtube_client(response):
    """Build a mock YouTube client whose videos().list().execute() returns the given response."""
    youtube = MagicMock()
    youtube.videos.return_value.list.return_value.execute.return_value = response
    return youtube


def test_call_youtube_api_retries_transient_errors_then_succeeds(monkeypatch):
    """A connection error on the first attempt is retried and succeeds on the second."""
    monkeypatch.setattr("collection.youtube_client.time.sleep", lambda _seconds: None)
    executor = MagicMock(side_effect=[ConnectionError("blip"), "ok"])

    result = call_youtube_api(executor)

    assert result == "ok"
    assert executor.call_count == 2


def test_call_youtube_api_gives_up_after_max_retries(monkeypatch):
    """After MAX_RETRIES consecutive transient failures, it raises instead of retrying forever."""
    monkeypatch.setattr("collection.youtube_client.time.sleep", lambda _seconds: None)
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

    monkeypatch.setattr("collection.youtube_client.time.sleep", lambda _seconds: None)

    for local_network_error in (socket.gaierror("DNS lookup failed"), ssl.SSLError("handshake failed")):
        executor = MagicMock(side_effect=[local_network_error, "ok"])
        result = call_youtube_api(executor)
        assert result == "ok"


def test_call_youtube_api_does_not_retry_non_retryable_http_errors(monkeypatch):
    """A non-retryable HTTP-level error (e.g. a plain 404) fails immediately without retrying."""
    monkeypatch.setattr("collection.youtube_client.time.sleep", lambda _seconds: None)
    executor = MagicMock(side_effect=_http_error(404))

    with pytest.raises(YouTubeAPIError):
        call_youtube_api(executor)

    assert executor.call_count == 1


def test_call_youtube_api_retries_http_429_then_succeeds(monkeypatch):
    """A bare 429 (no parseable reason) is retried like a transient failure."""
    monkeypatch.setattr("collection.youtube_client.time.sleep", lambda _seconds: None)
    executor = MagicMock(side_effect=[_http_error(429), "ok"])

    result = call_youtube_api(executor)

    assert result == "ok"
    assert executor.call_count == 2


def test_call_youtube_api_retries_rate_limit_exceeded_reason(monkeypatch):
    """YouTube's rateLimitExceeded reason is retried even though the HTTP status (403)
    alone would not be — the reason code takes priority."""
    monkeypatch.setattr("collection.youtube_client.time.sleep", lambda _seconds: None)
    executor = MagicMock(side_effect=[_http_error(403, "rateLimitExceeded"), "ok"])

    result = call_youtube_api(executor)

    assert result == "ok"
    assert executor.call_count == 2


def test_call_youtube_api_gives_up_after_max_retries_on_retryable_http_error(monkeypatch):
    """A persistently retryable HTTP error still gives up after MAX_RETRIES, not forever."""
    monkeypatch.setattr("collection.youtube_client.time.sleep", lambda _seconds: None)
    executor = MagicMock(side_effect=_http_error(503))

    with pytest.raises(YouTubeAPIError, match="after 3 attempts"):
        call_youtube_api(executor)

    assert executor.call_count == MAX_RETRIES


def test_call_youtube_api_raises_quota_exhausted_immediately_without_retrying(monkeypatch):
    """quotaExceeded stops immediately — retrying would just waste more quota."""
    monkeypatch.setattr("collection.youtube_client.time.sleep", lambda _seconds: None)
    executor = MagicMock(side_effect=_http_error(403, "quotaExceeded"))

    with pytest.raises(QuotaExhaustedError):
        call_youtube_api(executor)

    assert executor.call_count == 1


def test_call_youtube_api_raises_quota_exhausted_for_daily_limit_exceeded(monkeypatch):
    """dailyLimitExceeded, like quotaExceeded, stops immediately without retrying."""
    monkeypatch.setattr("collection.youtube_client.time.sleep", lambda _seconds: None)
    executor = MagicMock(side_effect=_http_error(403, "dailyLimitExceeded"))

    with pytest.raises(QuotaExhaustedError):
        call_youtube_api(executor)

    assert executor.call_count == 1


def test_call_youtube_api_retry_exhaustion_never_exposes_the_credential_bearing_uri(monkeypatch):
    """The final retry-exhaustion message must never echo the raw HttpError's own
    str()/repr() -- googleapiclient embeds the full request URI there, and the
    discovery client puts the API key into that URI as a `?key=...` query param
    (see youtube_client._safe_error_context's docstring). Safe context (HTTP status,
    reason code, human-readable message) must still come through."""
    monkeypatch.setattr("collection.youtube_client.time.sleep", lambda _seconds: None)
    secret_uri = "https://www.googleapis.com/youtube/v3/channels?part=snippet&key=TEST_SECRET_KEY"
    error = _http_error(503, "backendError", uri=secret_uri)
    assert "TEST_SECRET_KEY" in repr(error)  # sanity check: the raw exception really would leak it
    executor = MagicMock(side_effect=error)

    with pytest.raises(YouTubeAPIError) as exc_info:
        call_youtube_api(executor)

    message = str(exc_info.value)
    assert "TEST_SECRET_KEY" not in message
    assert "?key=" not in message
    assert secret_uri not in message
    assert "503" in message
    assert "backendError" in message


def test_call_youtube_api_retry_exhaustion_never_exposes_a_url_from_a_non_http_error(monkeypatch):
    """A non-HttpError transport failure (e.g. a connection-pool/proxy error) whose
    own message happens to embed the failed request's full URL -- key included --
    must not have that text echoed into the final YouTubeAPIError either. Only
    HttpError's structured .status_code/.reason are trusted; every other exception
    type is reduced to just its class name."""
    monkeypatch.setattr("collection.youtube_client.time.sleep", lambda _seconds: None)
    secret_url = "https://www.googleapis.com/youtube/v3/channels?part=snippet&key=TEST_SECRET_KEY"
    executor = MagicMock(side_effect=ConnectionError(f"connection failed for {secret_url}"))

    with pytest.raises(YouTubeAPIError) as exc_info:
        call_youtube_api(executor)

    message = str(exc_info.value)
    assert "TEST_SECRET_KEY" not in message
    assert "?key=" not in message
    assert secret_url not in message
    assert "ConnectionError" in message


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
            "contentType": "upload",
            "liveStatus": None,
        }
    ]
    assert skip_reasons == {}


def test_completed_livestream_is_classified_as_live_and_completed():
    """actualEndTime present -> contentType="live", liveStatus="completed" --
    the presence of liveStreamingDetails alone is the contentType signal, but
    actualEndTime specifically is what identifies a genuinely ended archive."""
    response = {
        "items": [
            {
                "id": "stream1",
                # A livestream archive is published AFTER the stream (never at its start, which is a Premiere).
                "snippet": {"title": "Archived Stream", "publishedAt": "2026-08-25T14:13:00Z"},
                "statistics": {"viewCount": "5000"},
                "liveStreamingDetails": {
                    "actualStartTime": "2026-08-25T12:00:00Z",
                    "actualEndTime": "2026-08-25T14:00:00Z",
                },
            }
        ]
    }
    youtube = _make_youtube_client(response)

    result, skip_reasons = get_video_statistics(youtube, ["stream1"])

    assert result == [
        {
            "videoId": "stream1",
            "title": "Archived Stream",
            "publishedAt": "2026-08-25T14:13:00Z",
            "viewCount": 5000,
            "contentType": "live",
            "liveStatus": "completed",
        }
    ]
    assert skip_reasons == {}


def test_currently_live_stream_has_actual_start_but_no_actual_end():
    """actualStartTime present, actualEndTime absent -> liveStatus="live" --
    the broadcast has started but YouTube hasn't recorded an end yet."""
    response = {
        "items": [
            {
                "id": "stream2",
                "snippet": {"title": "Live Now", "publishedAt": "2026-08-25T12:00:00Z"},
                "statistics": {"viewCount": "1000"},
                "liveStreamingDetails": {"actualStartTime": "2026-08-25T12:00:00Z"},
            }
        ]
    }
    youtube = _make_youtube_client(response)

    [result] = get_video_statistics(youtube, ["stream2"])[0]

    assert result["contentType"] == "live"
    assert result["liveStatus"] == "live"


def test_upcoming_stream_has_neither_actual_start_nor_actual_end():
    """Neither actualStartTime nor actualEndTime present -> liveStatus=
    "upcoming" -- scheduled but not yet started."""
    response = {
        "items": [
            {
                "id": "stream3",
                "snippet": {"title": "Upcoming Premiere", "publishedAt": "2026-08-25T12:00:00Z"},
                "statistics": {"viewCount": "0"},
                "liveStreamingDetails": {"scheduledStartTime": "2026-08-26T12:00:00Z"},
            }
        ]
    }
    youtube = _make_youtube_client(response)

    [result] = get_video_statistics(youtube, ["stream3"])[0]

    assert result["contentType"] == "live"
    assert result["liveStatus"] == "upcoming"


def test_plain_upload_has_no_live_status():
    response = {
        "items": [
            {
                "id": "upload1",
                "snippet": {"title": "Normal Upload", "publishedAt": "2026-08-25T12:00:00Z"},
                "statistics": {"viewCount": "10"},
            }
        ]
    }
    youtube = _make_youtube_client(response)

    [result] = get_video_statistics(youtube, ["upload1"])[0]

    assert result["contentType"] == "upload"
    assert result["liveStatus"] is None


def _live_item(video_id, published_at, details):
    return {
        "items": [
            {
                "id": video_id,
                "snippet": {"title": video_id, "publishedAt": published_at},
                "statistics": {"viewCount": "100"},
                "liveStreamingDetails": details,
            }
        ]
    }


def _with_content_details(response, content_details):
    response["items"][0]["contentDetails"] = content_details
    return response


def _classified(response):
    [result] = get_video_statistics(_make_youtube_client(response), [response["items"][0]["id"]])[0]
    return result["contentType"], result["liveStatus"]


def test_completed_premiere_is_an_upload_not_a_livestream():
    """A Premiere is published at its start (publishedAt == actualStartTime) and carries liveStreamingDetails like a
    stream archive does; it is an ordinary video, so contentType="upload" and no liveStatus."""
    details = {
        "scheduledStartTime": "2024-10-27T09:00:00Z",
        "actualStartTime": "2024-10-27T09:00:06Z",
        "actualEndTime": "2024-10-27T09:06:02Z",
    }

    assert _classified(_live_item("premiere1", "2024-10-27T09:00:06Z", details)) == ("upload", None)


@pytest.mark.parametrize("published_at", ["2018-12-26T09:58:13Z", "2018-12-26T10:00:19Z", "2018-12-26T10:01:19Z"])
def test_premiere_window_covers_older_premieres_published_a_little_before_the_start_and_small_delays(published_at):
    """Older Premieres were published 1-2 minutes BEFORE they started (-126 s audited); the audited window
    (-300 s .. +60 s around actualStartTime) stays upload, including its upper edge."""
    details = {"actualStartTime": "2018-12-26T10:00:19Z", "actualEndTime": "2018-12-26T10:06:06Z"}

    assert _classified(_live_item("premiere2", published_at, details)) == ("upload", None)


@pytest.mark.parametrize(
    "published_at",
    [
        "2024-11-08T08:12:53Z",  # +150 s after the start: the closest real stream audited
        "2024-11-08T12:27:19Z",  # published after the stream ended (the normal archive shape)
        "2024-10-31T08:10:23Z",  # a stream scheduled/published a week early (-8 days): not a Premiere
        "2024-11-08T08:05:22Z",  # just outside the -300 s lower edge
        "2024-11-08T08:11:24Z",  # just outside the +60 s upper edge
    ],
)
def test_genuine_completed_livestream_stays_live_and_completed(published_at):
    details = {
        "scheduledStartTime": "2024-11-08T08:00:00Z",
        "actualStartTime": "2024-11-08T08:10:23Z",
        "actualEndTime": "2024-11-08T12:14:00Z",
    }

    assert _classified(_live_item("stream9", published_at, details)) == ("live", "completed")


def test_upcoming_and_in_progress_broadcasts_stay_live_even_when_published_at_the_start():
    """Only a COMPLETED broadcast can be told to be a Premiere; an upcoming or in-progress one keeps today's behaviour."""
    started = {"scheduledStartTime": "2026-08-25T12:00:00Z", "actualStartTime": "2026-08-25T12:00:06Z"}
    upcoming = {"scheduledStartTime": "2026-08-26T12:00:00Z"}

    assert _classified(_live_item("now1", "2026-08-25T12:00:06Z", started)) == ("live", "live")
    assert _classified(_live_item("soon1", "2026-08-25T12:00:00Z", upcoming)) == ("live", "upcoming")


# --- UPCOMING Premiere vs real stream: contentDetails.duration (real Data API responses, 2026-10-10) ---
#   upcoming Premiere (cover / official MV / video announcement): liveBroadcastContent "upcoming", scheduledStartTime, NO duration
#   upcoming real stream: "P0D";  live real stream: "P0D";  ENDED real stream: its real length ("PT4H17M29S")
# The ended stream proves "a positive duration means Premiere" would be wrong; the rule is only for the upcoming state.
_NO_DURATION = {"dimension": "2d", "definition": "hd"}  # the other keys are illustrative; the point is that `duration` is absent
_UPCOMING = {"scheduledStartTime": "2026-10-10T10:00:00Z"}


def _broadcast(response, broadcast_state, content_details):
    """Mirror the real response shape: snippet.liveBroadcastContent and contentDetails next to liveStreamingDetails."""
    response["items"][0]["snippet"]["liveBroadcastContent"] = broadcast_state
    if content_details is not None:
        response["items"][0]["contentDetails"] = content_details
    return response


@pytest.mark.parametrize("video_id", ["BK2mvHvdf4c", "LjuKylF4udw", "wYpu_zz1P3c"])
def test_1_an_upcoming_premiere_has_no_duration_and_is_a_video(video_id):
    response = _broadcast(_live_item(video_id, "2026-10-08T04:03:21Z", _UPCOMING), "upcoming", dict(_NO_DURATION))

    assert _classified(response) == ("upload", None)


@pytest.mark.parametrize("video_id", ["zpm1LqzOqgk", "anq1F3UhITM", "WXaEsVLtZAM"])
def test_2_an_upcoming_real_stream_reports_p0d_and_stays_an_upcoming_livestream(video_id):
    response = _broadcast(_live_item(video_id, "2026-10-02T05:49:09Z", _UPCOMING), "upcoming", {**_NO_DURATION, "duration": "P0D"})

    assert _classified(response) == ("live", "upcoming")


def test_3_a_live_real_stream_reports_p0d_and_stays_live():
    details = {"scheduledStartTime": "2026-10-10T09:00:00Z", "actualStartTime": "2026-10-10T09:00:30Z"}
    response = _broadcast(_live_item("G3mWNIhHaLw", "2026-10-09T09:00:00Z", details), "live", {**_NO_DURATION, "duration": "P0D"})

    assert _classified(response) == ("live", "live")


def test_4_a_completed_real_stream_with_a_positive_duration_MUST_remain_a_livestream():
    """Guards the rule against being simplified to "positive duration => upload"."""
    details = {"scheduledStartTime": "2026-10-10T01:00:00Z", "actualStartTime": "2026-10-10T01:05:00Z", "actualEndTime": "2026-10-10T05:22:29Z"}
    response = _broadcast(_live_item("YxE4iLtkD0A", "2026-10-10T05:30:00Z", details), "none", {**_NO_DURATION, "duration": "PT4H17M29S"})

    assert _classified(response) == ("live", "completed")


def test_the_missing_duration_rule_is_never_applied_to_a_live_or_ended_broadcast():
    started = {"scheduledStartTime": "2026-10-10T09:00:00Z", "actualStartTime": "2026-10-10T09:00:30Z"}
    ended = {**started, "actualEndTime": "2026-10-10T13:00:00Z"}

    assert _classified(_broadcast(_live_item("run1", "2026-10-09T09:00:00Z", started), "live", dict(_NO_DURATION))) == ("live", "live")
    assert _classified(_broadcast(_live_item("end1", "2026-10-10T13:30:00Z", ended), "none", dict(_NO_DURATION))) == ("live", "completed")


@pytest.mark.parametrize("broadcast_state", ["live", "none", None])
def test_only_an_upcoming_liveBroadcastContent_can_make_a_premiere(broadcast_state):
    response = _live_item("odd2", "2026-10-02T05:49:09Z", _UPCOMING)
    if broadcast_state is None:
        response["items"][0]["contentDetails"] = dict(_NO_DURATION)
    else:
        _broadcast(response, broadcast_state, dict(_NO_DURATION))

    assert _classified(response) == ("live", "upcoming")


def test_a_missing_or_empty_contentDetails_is_unknown_not_a_premiere_so_a_stream_is_never_hidden_by_a_missing_field():
    assert _classified(_broadcast(_live_item("soon2", "2026-10-02T05:49:09Z", _UPCOMING), "upcoming", None)) == ("live", "upcoming")
    assert _classified(_broadcast(_live_item("soon3", "2026-10-02T05:49:09Z", _UPCOMING), "upcoming", {})) == ("live", "upcoming")


def test_a_Premiere_stays_a_video_when_it_later_completes():
    upcoming = _broadcast(_live_item("p1", "2026-10-10T10:00:03Z", _UPCOMING), "upcoming", dict(_NO_DURATION))
    done = _broadcast(
        _live_item("p1", "2026-10-10T10:00:03Z", {**_UPCOMING, "actualStartTime": "2026-10-10T10:00:03Z", "actualEndTime": "2026-10-10T10:04:10Z"}),
        "none",
        {**_NO_DURATION, "duration": "PT4M7S"},
    )

    assert _classified(upcoming) == ("upload", None)
    assert _classified(done) == ("upload", None)


def test_a_broadcast_with_unparseable_timestamps_is_never_guessed_to_be_a_premiere():
    details = {"actualStartTime": "not-a-time", "actualEndTime": "2026-08-25T14:00:00Z"}

    assert _classified(_live_item("odd1", "2026-08-25T12:00:00Z", details)) == ("live", "completed")


def test_videos_list_requests_live_streaming_details_part():
    """The batched videos.list call always requests liveStreamingDetails
    alongside snippet/statistics -- no separate per-video request."""
    response = {"items": []}
    youtube = _make_youtube_client(response)

    get_video_statistics(youtube, ["abc123"])

    youtube.videos.return_value.list.assert_called_once_with(
        part="snippet,statistics,liveStreamingDetails,contentDetails", id="abc123"
    )


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
    monkeypatch.setattr("collection.youtube_client.time.sleep", lambda _seconds: None)
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
    monkeypatch.setattr("collection.youtube_client.time.sleep", lambda _seconds: None)
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


# --- select_channel_avatar_url / get_channel_avatar_thumbnails (C7A) -------


def _make_channels_client(response):
    """Build a mock YouTube client whose channels().list().execute() returns the given response."""
    youtube = MagicMock()
    youtube.channels.return_value.list.return_value.execute.return_value = response
    return youtube


def test_select_channel_avatar_url_prefers_high():
    thumbnails = {
        "default": {"url": "https://example.com/default.jpg"},
        "medium": {"url": "https://example.com/medium.jpg"},
        "high": {"url": "https://example.com/high.jpg"},
    }
    assert select_channel_avatar_url(thumbnails) == "https://example.com/high.jpg"


def test_select_channel_avatar_url_falls_back_to_medium_when_high_missing():
    thumbnails = {
        "default": {"url": "https://example.com/default.jpg"},
        "medium": {"url": "https://example.com/medium.jpg"},
    }
    assert select_channel_avatar_url(thumbnails) == "https://example.com/medium.jpg"


def test_select_channel_avatar_url_falls_back_to_default_when_high_and_medium_missing():
    thumbnails = {"default": {"url": "https://example.com/default.jpg"}}
    assert select_channel_avatar_url(thumbnails) == "https://example.com/default.jpg"


@pytest.mark.parametrize("thumbnails", [{}, None, "not-a-dict", {"high": {}}, {"high": {"url": ""}}])
def test_select_channel_avatar_url_returns_none_when_no_usable_thumbnail(thumbnails):
    assert select_channel_avatar_url(thumbnails) is None


def test_get_channel_avatar_thumbnails_returns_selected_url_for_valid_channel():
    response = {
        "items": [
            {
                "id": "UC_valid",
                "snippet": {"thumbnails": {"high": {"url": "https://example.com/high.jpg"}}},
            }
        ]
    }
    youtube = _make_channels_client(response)

    avatars, skip_reasons = get_channel_avatar_thumbnails(youtube, ["UC_valid"])

    assert avatars == {"UC_valid": "https://example.com/high.jpg"}
    assert skip_reasons == {}


def test_get_channel_avatar_thumbnails_no_thumbnail_produces_no_update():
    """A channel that returns a snippet with no usable thumbnail is recorded
    as a skip, never with an empty/None avatar url."""
    response = {"items": [{"id": "UC_no_thumb", "snippet": {"thumbnails": {}}}]}
    youtube = _make_channels_client(response)

    avatars, skip_reasons = get_channel_avatar_thumbnails(youtube, ["UC_no_thumb"])

    assert avatars == {}
    assert "UC_no_thumb" in skip_reasons


def test_get_channel_avatar_thumbnails_missing_channel_in_response(capsys):
    """A requested channel id absent from the response's 'items' is reported
    as a skip with a reason, not silently dropped."""
    youtube = _make_channels_client({"items": []})

    avatars, skip_reasons = get_channel_avatar_thumbnails(youtube, ["UC_missing"])

    assert avatars == {}
    assert "UC_missing" in skip_reasons
    assert "UC_missing" in capsys.readouterr().out


def test_get_channel_avatar_thumbnails_one_bad_item_does_not_discard_siblings(capsys):
    """A malformed item (missing snippet) in the same response as a valid
    item does not prevent the valid item's avatar from being returned."""
    response = {
        "items": [
            {"id": "UC_bad"},  # no snippet at all
            {"id": "UC_good", "snippet": {"thumbnails": {"high": {"url": "https://example.com/good.jpg"}}}},
        ]
    }
    youtube = _make_channels_client(response)

    avatars, skip_reasons = get_channel_avatar_thumbnails(youtube, ["UC_bad", "UC_good"])

    assert avatars == {"UC_good": "https://example.com/good.jpg"}
    assert "UC_bad" in skip_reasons


def test_get_channel_avatar_thumbnails_duplicate_id_in_response_keeps_first(capsys):
    """A duplicate channel id within one response is handled safely (first
    occurrence kept) instead of raising or silently overwriting unpredictably."""
    response = {
        "items": [
            {"id": "UC_dup", "snippet": {"thumbnails": {"high": {"url": "https://example.com/first.jpg"}}}},
            {"id": "UC_dup", "snippet": {"thumbnails": {"high": {"url": "https://example.com/second.jpg"}}}},
        ]
    }
    youtube = _make_channels_client(response)

    avatars, _ = get_channel_avatar_thumbnails(youtube, ["UC_dup"])

    assert avatars == {"UC_dup": "https://example.com/first.jpg"}
    assert "duplicate" in capsys.readouterr().out.lower()


def test_get_channel_avatar_thumbnails_unexpected_id_in_response_is_ignored():
    """A channel id in the response that was never requested in this batch
    is safely ignored rather than attributed to any creator."""
    response = {
        "items": [
            {"id": "UC_unrequested", "snippet": {"thumbnails": {"high": {"url": "https://example.com/x.jpg"}}}},
        ]
    }
    youtube = _make_channels_client(response)

    avatars, skip_reasons = get_channel_avatar_thumbnails(youtube, ["UC_requested"])

    assert avatars == {}
    assert "UC_requested" in skip_reasons


def test_get_channel_avatar_thumbnails_deduplicates_input_ids():
    """The same channel id requested twice (e.g. shared by two creators) is
    only fetched once."""
    response = {
        "items": [{"id": "UC_shared", "snippet": {"thumbnails": {"high": {"url": "https://example.com/x.jpg"}}}}]
    }
    youtube = _make_channels_client(response)

    get_channel_avatar_thumbnails(youtube, ["UC_shared", "UC_shared"])

    assert youtube.channels.return_value.list.call_args.kwargs["id"] == "UC_shared"


def test_get_channel_avatar_thumbnails_batches_multiple_channels_in_one_request():
    """Multiple creators' channel IDs (within MAX_IDS_PER_REQUEST) are fetched
    in a single batched request, never one request per creator."""
    response = {
        "items": [
            {"id": f"UC_{i}", "snippet": {"thumbnails": {"high": {"url": f"https://example.com/{i}.jpg"}}}}
            for i in range(5)
        ]
    }
    youtube = _make_channels_client(response)
    channel_ids = [f"UC_{i}" for i in range(5)]

    avatars, _ = get_channel_avatar_thumbnails(youtube, channel_ids)

    assert len(avatars) == 5
    assert youtube.channels.return_value.list.call_count == 1


def test_get_channel_avatar_thumbnails_splits_into_batches_of_max_ids_per_request():
    """More than MAX_IDS_PER_REQUEST channel IDs are split across multiple
    batched calls, matching get_video_statistics's own batching."""
    response_batch = {
        "items": [
            {"id": f"UC_{i}", "snippet": {"thumbnails": {"high": {"url": f"https://example.com/{i}.jpg"}}}}
            for i in range(MAX_IDS_PER_REQUEST)
        ]
    }
    youtube = _make_channels_client(response_batch)
    channel_ids = [f"UC_{i}" for i in range(MAX_IDS_PER_REQUEST + 10)]

    get_channel_avatar_thumbnails(youtube, channel_ids)

    calls = youtube.channels.return_value.list.call_args_list
    assert len(calls) == 2


def test_get_channel_avatar_thumbnails_empty_input_makes_no_api_call():
    youtube = MagicMock()

    avatars, skip_reasons = get_channel_avatar_thumbnails(youtube, [])

    assert avatars == {}
    assert skip_reasons == {}
    youtube.channels.assert_not_called()


def test_get_channel_avatar_thumbnails_one_failing_batch_does_not_abort_others(monkeypatch, capsys):
    monkeypatch.setattr("collection.youtube_client.time.sleep", lambda _seconds: None)
    youtube = MagicMock()
    good_response = {
        "items": [
            {"id": f"UC_{50 + i}", "snippet": {"thumbnails": {"high": {"url": f"https://example.com/{i}.jpg"}}}}
            for i in range(10)
        ]
    }
    youtube.channels.return_value.list.return_value.execute.side_effect = [
        ConnectionError("network blip"),
        ConnectionError("network blip"),
        ConnectionError("network blip"),
        good_response,
    ]
    channel_ids = [f"UC_{i}" for i in range(60)]

    avatars, skip_reasons = get_channel_avatar_thumbnails(youtube, channel_ids)

    assert len(avatars) == 10
    assert "network blip" in capsys.readouterr().out
    assert len(skip_reasons) == 50


def test_get_channel_avatar_thumbnails_stops_immediately_on_quota_exhaustion(monkeypatch):
    monkeypatch.setattr("collection.youtube_client.time.sleep", lambda _seconds: None)
    youtube = MagicMock()
    youtube.channels.return_value.list.return_value.execute.side_effect = _http_error(403, "quotaExceeded")
    channel_ids = [f"UC_{i}" for i in range(150)]

    with pytest.raises(QuotaExhaustedError):
        get_channel_avatar_thumbnails(youtube, channel_ids)

    assert youtube.channels.return_value.list.return_value.execute.call_count == 1
