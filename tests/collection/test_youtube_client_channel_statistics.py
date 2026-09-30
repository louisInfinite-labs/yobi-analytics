"""Tests for collection.youtube_client.get_channel_statistics (ranking-
simplification, subscriber-history foundation, R1) -- mirrors the existing
get_channel_avatar_thumbnails test suite's own batching/dedup/error-handling
conventions in this same package.
"""

from unittest.mock import MagicMock

import pytest

from collection.youtube_client import (
    MAX_IDS_PER_REQUEST,
    QuotaExhaustedError,
    YouTubeAPIError,
    _fetch_channel_statistics_batch,
    get_channel_statistics,
)


def _http_error(status: int, reason: str | None = None):
    import json

    from googleapiclient.errors import HttpError

    response = MagicMock(status=status, reason="error")
    if reason is None:
        return HttpError(response, b"not json")
    content = json.dumps({"error": {"errors": [{"reason": reason, "message": "boom"}], "message": "boom"}})
    return HttpError(response, content.encode("utf-8"))


def _make_channels_client(response):
    youtube = MagicMock()
    youtube.channels.return_value.list.return_value.execute.return_value = response
    return youtube


def test_returns_subscriber_count_for_a_visible_channel():
    response = {"items": [{"id": "UC_visible", "statistics": {"subscriberCount": "500000", "hiddenSubscriberCount": False}}]}
    youtube = _make_channels_client(response)

    results, skip_reasons = get_channel_statistics(youtube, ["UC_visible"])

    assert results == {"UC_visible": {"subscriberCount": 500000, "hiddenSubscriberCount": False}}
    assert skip_reasons == {}


def test_hidden_subscriber_count_is_reported_as_none_not_zero():
    """YouTube returns a fabricated '0' subscriberCount alongside
    hiddenSubscriberCount=true -- this must never surface as a real 0."""
    response = {"items": [{"id": "UC_hidden", "statistics": {"subscriberCount": "0", "hiddenSubscriberCount": True}}]}
    youtube = _make_channels_client(response)

    results, skip_reasons = get_channel_statistics(youtube, ["UC_hidden"])

    assert results == {"UC_hidden": {"subscriberCount": None, "hiddenSubscriberCount": True}}
    assert skip_reasons == {}


def test_hidden_subscriber_count_missing_the_fabricated_zero_still_reports_none():
    """Even if a caller's fake response omits the fabricated '0' entirely,
    hiddenSubscriberCount=true alone is enough to report None -- the real
    numeric value (present or not) is never trusted once hidden is true."""
    response = {"items": [{"id": "UC_hidden", "statistics": {"hiddenSubscriberCount": True}}]}
    youtube = _make_channels_client(response)

    results, _ = get_channel_statistics(youtube, ["UC_hidden"])

    assert results == {"UC_hidden": {"subscriberCount": None, "hiddenSubscriberCount": True}}


def test_missing_hidden_subscriber_count_field_defaults_to_visible():
    """A channels.list item that predates/omits hiddenSubscriberCount entirely
    is treated as visible (not hidden), matching YouTube's own documented
    default."""
    response = {"items": [{"id": "UC_no_flag", "statistics": {"subscriberCount": "42"}}]}
    youtube = _make_channels_client(response)

    results, _ = get_channel_statistics(youtube, ["UC_no_flag"])

    assert results == {"UC_no_flag": {"subscriberCount": 42, "hiddenSubscriberCount": False}}


def test_non_hidden_item_missing_subscriber_count_is_skipped_not_zero():
    """A malformed non-hidden item (no subscriberCount at all) must never be
    silently treated as 0 subscribers."""
    response = {"items": [{"id": "UC_malformed", "statistics": {"hiddenSubscriberCount": False}}]}
    youtube = _make_channels_client(response)

    results, skip_reasons = get_channel_statistics(youtube, ["UC_malformed"])

    assert results == {}
    assert "UC_malformed" in skip_reasons


def test_empty_channel_ids_returns_empty_without_calling_api():
    youtube = MagicMock()

    results, skip_reasons = get_channel_statistics(youtube, [])

    assert results == {}
    assert skip_reasons == {}
    youtube.channels.assert_not_called()


def test_missing_channel_in_response_is_a_skip_reason(capsys):
    youtube = _make_channels_client({"items": []})

    results, skip_reasons = get_channel_statistics(youtube, ["UC_missing"])

    assert results == {}
    assert "UC_missing" in skip_reasons
    assert "UC_missing" in capsys.readouterr().out


def test_deduplicates_input_channel_ids():
    response = {"items": [{"id": "UC_shared", "statistics": {"subscriberCount": "1", "hiddenSubscriberCount": False}}]}
    youtube = _make_channels_client(response)

    get_channel_statistics(youtube, ["UC_shared", "UC_shared"])

    assert youtube.channels.return_value.list.call_args.kwargs["id"] == "UC_shared"


def test_batches_multiple_channels_in_one_request():
    response = {
        "items": [
            {"id": f"UC_{i}", "statistics": {"subscriberCount": str(i), "hiddenSubscriberCount": False}}
            for i in range(5)
        ]
    }
    youtube = _make_channels_client(response)

    results, _ = get_channel_statistics(youtube, [f"UC_{i}" for i in range(5)])

    assert len(results) == 5
    assert youtube.channels.return_value.list.call_count == 1


def test_splits_into_batches_of_max_ids_per_request():
    response_batch = {
        "items": [
            {"id": f"UC_{i}", "statistics": {"subscriberCount": "1", "hiddenSubscriberCount": False}}
            for i in range(MAX_IDS_PER_REQUEST)
        ]
    }
    youtube = _make_channels_client(response_batch)

    get_channel_statistics(youtube, [f"UC_{i}" for i in range(MAX_IDS_PER_REQUEST + 10)])

    assert youtube.channels.return_value.list.call_count == 2


def test_one_bad_item_does_not_discard_siblings():
    response = {
        "items": [
            {"id": "UC_bad", "statistics": {"hiddenSubscriberCount": False}},  # no subscriberCount
            {"id": "UC_good", "statistics": {"subscriberCount": "10", "hiddenSubscriberCount": False}},
        ]
    }
    youtube = _make_channels_client(response)

    results, skip_reasons = get_channel_statistics(youtube, ["UC_bad", "UC_good"])

    assert results == {"UC_good": {"subscriberCount": 10, "hiddenSubscriberCount": False}}
    assert "UC_bad" in skip_reasons


def test_duplicate_id_in_response_keeps_first_occurrence(capsys):
    response = {
        "items": [
            {"id": "UC_dup", "statistics": {"subscriberCount": "1", "hiddenSubscriberCount": False}},
            {"id": "UC_dup", "statistics": {"subscriberCount": "2", "hiddenSubscriberCount": False}},
        ]
    }
    youtube = _make_channels_client(response)

    results, _ = get_channel_statistics(youtube, ["UC_dup"])

    assert results == {"UC_dup": {"subscriberCount": 1, "hiddenSubscriberCount": False}}
    assert "duplicate" in capsys.readouterr().out.lower()


def test_unexpected_id_in_response_is_ignored():
    response = {"items": [{"id": "UC_unrequested", "statistics": {"subscriberCount": "1", "hiddenSubscriberCount": False}}]}
    youtube = _make_channels_client(response)

    results, skip_reasons = get_channel_statistics(youtube, ["UC_requested"])

    assert results == {}
    assert "UC_requested" in skip_reasons


def test_one_failing_batch_does_not_abort_others(monkeypatch, capsys):
    monkeypatch.setattr("collection.youtube_client.time.sleep", lambda _seconds: None)
    youtube = MagicMock()
    good_response = {
        "items": [
            {"id": f"UC_{50 + i}", "statistics": {"subscriberCount": "1", "hiddenSubscriberCount": False}}
            for i in range(10)
        ]
    }
    youtube.channels.return_value.list.return_value.execute.side_effect = [
        ConnectionError("network blip"),
        ConnectionError("network blip"),
        ConnectionError("network blip"),
        good_response,
    ]

    results, skip_reasons = get_channel_statistics(youtube, [f"UC_{i}" for i in range(60)])

    assert len(results) == 10
    assert "network blip" in capsys.readouterr().out
    assert len(skip_reasons) == 50


def test_stops_immediately_on_quota_exhaustion(monkeypatch):
    monkeypatch.setattr("collection.youtube_client.time.sleep", lambda _seconds: None)
    youtube = MagicMock()
    youtube.channels.return_value.list.return_value.execute.side_effect = _http_error(403, "quotaExceeded")

    with pytest.raises(QuotaExhaustedError):
        get_channel_statistics(youtube, [f"UC_{i}" for i in range(150)])

    assert youtube.channels.return_value.list.return_value.execute.call_count == 1


def test_fetch_channel_statistics_batch_raises_on_missing_items():
    youtube = _make_channels_client({})

    with pytest.raises(YouTubeAPIError):
        _fetch_channel_statistics_batch(youtube, ["UC_x"])


def test_fetch_channel_statistics_batch_raises_on_non_object_item():
    youtube = _make_channels_client({"items": ["not-a-dict"]})

    with pytest.raises(YouTubeAPIError):
        _fetch_channel_statistics_batch(youtube, ["UC_x"])
