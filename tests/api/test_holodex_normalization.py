from datetime import datetime, timezone

import pytest

from api.holodex_normalization import (
    HolodexArchivedStream,
    HolodexLiveStream,
    HolodexNormalizationError,
    normalize_holodex_archived_stream,
    normalize_holodex_archived_streams_response,
    normalize_holodex_live_response,
    normalize_holodex_stream,
)


def _raw_item(**overrides):
    """A well-formed raw Holodex /live item, overridable per test."""
    item = {
        "id": "abc123XYZ90",
        "title": "VALORANT ranked grind",
        "status": "live",
        "start_scheduled": "2026-09-27T12:00:00Z",
        "start_actual": "2026-09-27T12:03:00Z",
        "channel": {"id": "UCabc123", "name": "Test Creator"},
    }
    item.update(overrides)
    return item


def test_normalizes_a_valid_live_item():
    stream = normalize_holodex_stream(_raw_item(status="live"))

    assert stream == HolodexLiveStream(
        video_id="abc123XYZ90",
        youtube_channel_id="UCabc123",
        channel_name="Test Creator",
        title="VALORANT ranked grind",
        status="live",
        scheduled_start="2026-09-27T12:00:00+00:00",
        actual_start="2026-09-27T12:03:00+00:00",
        thumbnail_url="https://img.youtube.com/vi/abc123XYZ90/hqdefault.jpg",
    )


def test_normalizes_a_valid_upcoming_item_without_an_actual_start():
    stream = normalize_holodex_stream(_raw_item(status="upcoming", start_actual=None))

    assert stream is not None
    assert stream.status == "upcoming"
    assert stream.scheduled_start == "2026-09-27T12:00:00+00:00"
    assert stream.actual_start is None


def test_actual_start_time_is_parsed_when_present():
    stream = normalize_holodex_stream(_raw_item(start_actual="2026-09-27T12:05:30Z"))

    assert stream.actual_start == "2026-09-27T12:05:30+00:00"


def test_scheduled_start_time_is_parsed_when_present():
    stream = normalize_holodex_stream(_raw_item(start_scheduled="2026-09-27T09:00:00Z"))

    assert stream.scheduled_start == "2026-09-27T09:00:00+00:00"


def test_missing_optional_fields_degrade_to_none_without_discarding_the_item():
    raw = _raw_item()
    del raw["start_scheduled"]
    del raw["start_actual"]
    raw["channel"] = {"id": "UCabc123"}  # no "name"

    stream = normalize_holodex_stream(raw)

    assert stream is not None
    assert stream.scheduled_start is None
    assert stream.actual_start is None
    assert stream.channel_name is None


def test_missing_title_degrades_to_none_without_discarding_the_item():
    raw = _raw_item()
    del raw["title"]

    stream = normalize_holodex_stream(raw)

    assert stream is not None
    assert stream.title is None


def test_blank_title_degrades_to_none():
    stream = normalize_holodex_stream(_raw_item(title="   "))

    assert stream.title is None


def test_thumbnail_is_derived_from_video_id_since_holodex_has_no_raw_thumbnail_field():
    raw = _raw_item()
    assert "thumbnail" not in raw  # Holodex's raw /live payload never carries one

    stream = normalize_holodex_stream(raw)

    assert stream.thumbnail_url == "https://img.youtube.com/vi/abc123XYZ90/hqdefault.jpg"


def test_malformed_timestamp_degrades_to_none_without_discarding_the_item():
    stream = normalize_holodex_stream(_raw_item(start_scheduled="not-a-real-timestamp"))

    assert stream is not None
    assert stream.scheduled_start is None


def test_unknown_status_is_skipped_not_guessed_into_live_or_upcoming():
    for status in ("new", "past", "missing", "some-future-holodex-status"):
        assert normalize_holodex_stream(_raw_item(status=status)) is None


def test_missing_stream_id_is_skipped():
    raw = _raw_item()
    del raw["id"]

    assert normalize_holodex_stream(raw) is None


def test_blank_stream_id_is_skipped():
    assert normalize_holodex_stream(_raw_item(id="   ")) is None


def test_missing_channel_identity_is_skipped():
    raw = _raw_item()
    del raw["channel"]

    assert normalize_holodex_stream(raw) is None


def test_blank_channel_id_is_skipped():
    assert normalize_holodex_stream(_raw_item(channel={"id": "  ", "name": "Test Creator"})) is None


def test_normalize_holodex_stream_rejects_a_non_dict_item():
    assert normalize_holodex_stream("not-a-dict") is None
    assert normalize_holodex_stream(None) is None


def test_batch_normalization_drops_only_the_invalid_items_and_keeps_valid_siblings():
    raw_payload = [
        _raw_item(id="live-1", status="live"),
        _raw_item(id="missing-channel", status="live", channel=None),
        _raw_item(id="unknown-status", status="past"),
        {"id": "not-a-video", "status": "live"},  # missing channel entirely
        _raw_item(id="upcoming-1", status="upcoming"),
    ]

    result = normalize_holodex_live_response(raw_payload)

    assert [stream.video_id for stream in result] == ["live-1", "upcoming-1"]


def test_empty_list_payload_remains_a_valid_empty_result():
    """A genuine "nobody live/upcoming" result must stay indistinguishable
    from nothing -- it must NOT raise, unlike a malformed top-level payload."""
    assert normalize_holodex_live_response([]) == []


def test_non_list_dict_payload_raises_normalization_error():
    with pytest.raises(HolodexNormalizationError):
        normalize_holodex_live_response({"error": "not found"})


def test_none_payload_raises_normalization_error():
    with pytest.raises(HolodexNormalizationError):
        normalize_holodex_live_response(None)


def test_scalar_string_payload_raises_normalization_error():
    with pytest.raises(HolodexNormalizationError):
        normalize_holodex_live_response("unexpected string body")


def test_scalar_number_payload_raises_normalization_error():
    with pytest.raises(HolodexNormalizationError):
        normalize_holodex_live_response(42)


def test_normalized_timestamps_are_utc_offset_aware_not_converted_to_local_time():
    """Holodex sends UTC ("Z"); the normalized value must stay UTC/offset-aware,
    never shifted to JST or any other local zone -- that stays the frontend's job."""
    stream = normalize_holodex_stream(_raw_item(start_scheduled="2026-09-27T12:00:00Z"))

    parsed = datetime.fromisoformat(stream.scheduled_start)
    assert parsed.tzinfo is not None
    assert parsed.utcoffset().total_seconds() == 0
    assert parsed.astimezone(timezone.utc).hour == 12


def test_normalized_timestamp_preserves_a_non_utc_offset_by_converting_to_utc():
    """A hypothetical non-UTC offset from Holodex must be converted to UTC, not dropped
    or passed through with its original offset -- the normalized value is always UTC."""
    stream = normalize_holodex_stream(_raw_item(start_scheduled="2026-09-27T21:00:00+09:00"))

    assert stream.scheduled_start == "2026-09-27T12:00:00+00:00"


# ============ normalize_holodex_archived_stream (GET /recent-streams' own source) ============


def _raw_archived_item(**overrides):
    """A well-formed raw Holodex /videos (status=past, type=stream) item, overridable per test."""
    item = {
        "id": "past123XYZ90",
        "title": "Karaoke archive",
        "available_at": "2026-09-20T10:00:00Z",
        "channel": {"id": "UCabc123", "name": "Test Creator"},
    }
    item.update(overrides)
    return item


def test_normalizes_a_valid_archived_item():
    stream = normalize_holodex_archived_stream(_raw_archived_item())

    assert stream == HolodexArchivedStream(
        video_id="past123XYZ90",
        youtube_channel_id="UCabc123",
        channel_name="Test Creator",
        title="Karaoke archive",
        published_at="2026-09-20T10:00:00+00:00",
        thumbnail_url="https://img.youtube.com/vi/past123XYZ90/hqdefault.jpg",
    )


def test_archived_stream_does_not_check_status_itself():
    """Unlike normalize_holodex_stream, this function never rejects on `status` --
    the caller already constrained the Holodex request to status=past, so an
    item missing `status` entirely (or carrying an unexpected value) must
    still normalize, not be silently dropped a second time."""
    raw = _raw_archived_item()
    raw.pop("status", None)
    assert normalize_holodex_archived_stream(raw) is not None

    stream = normalize_holodex_archived_stream(_raw_archived_item(status="past"))
    assert stream is not None


def test_archived_missing_available_at_degrades_to_none_without_discarding_the_item():
    raw = _raw_archived_item()
    del raw["available_at"]

    stream = normalize_holodex_archived_stream(raw)

    assert stream is not None
    assert stream.published_at is None


def test_archived_missing_title_degrades_to_none():
    raw = _raw_archived_item()
    del raw["title"]

    stream = normalize_holodex_archived_stream(raw)

    assert stream is not None
    assert stream.title is None


def test_archived_missing_channel_name_degrades_to_none():
    stream = normalize_holodex_archived_stream(_raw_archived_item(channel={"id": "UCabc123"}))

    assert stream is not None
    assert stream.channel_name is None


def test_archived_missing_video_id_is_skipped():
    raw = _raw_archived_item()
    del raw["id"]

    assert normalize_holodex_archived_stream(raw) is None


def test_archived_missing_channel_identity_is_skipped():
    raw = _raw_archived_item()
    del raw["channel"]

    assert normalize_holodex_archived_stream(raw) is None


def test_archived_non_dict_item_is_rejected():
    assert normalize_holodex_archived_stream("not-a-dict") is None
    assert normalize_holodex_archived_stream(None) is None


def test_archived_batch_normalization_drops_only_invalid_items():
    raw_payload = [
        _raw_archived_item(id="archive-1"),
        _raw_archived_item(id="missing-channel", channel=None),
        {"id": "not-a-video"},  # missing channel entirely
        _raw_archived_item(id="archive-2"),
    ]

    result = normalize_holodex_archived_streams_response(raw_payload)

    assert [stream.video_id for stream in result] == ["archive-1", "archive-2"]


def test_archived_empty_list_payload_remains_a_valid_empty_result():
    assert normalize_holodex_archived_streams_response([]) == []


def test_archived_non_list_payload_raises_normalization_error():
    with pytest.raises(HolodexNormalizationError):
        normalize_holodex_archived_streams_response({"error": "not found"})
