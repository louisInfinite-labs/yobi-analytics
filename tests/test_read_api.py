from datetime import date

import pytest

import read_api
from creator_master import Creator
from read_api import (
    ClientError,
    VideoNotFoundError,
    get_video_growth,
    parse_period,
    parse_report_date,
    parse_time_zone,
    parse_video_id,
)
from snapshot_store import Snapshot
from video_master import Video


def _video(**overrides) -> Video:
    """Build a minimal Video for a test, overriding only the given fields."""
    fields = {
        "video_id": "v1",
        "creator_id": "aizawa_ema",
        "title": "Test Video",
        "published_at": "2026-08-20T00:00:00Z",
    }
    fields.update(overrides)
    return Video(**fields)


def _creator(**overrides) -> Creator:
    """Build a minimal Creator for a test, overriding only the given fields."""
    fields = {
        "creator_id": "aizawa_ema",
        "display_name": "藍沢エマ",
        "organization": "vspo",
        "youtube_channel_id": "UC_test",
        "active": True,
        "branch": "vspo_jp",
        "group_key": ["1期生"],
        "channel_type": "member",
        "lifecycle_stage": "active",
    }
    fields.update(overrides)
    return Creator(**fields)


def _snapshot(snapshot_date: str, view_count: int) -> Snapshot:
    """Build a minimal Snapshot for a test."""
    return Snapshot(
        snapshot_date=snapshot_date,
        observed_at=f"{snapshot_date}T18:00:05+09:00",
        creator_id="aizawa_ema",
        video_id="v1",
        title="Test Video",
        published_at="2026-08-20T00:00:00Z",
        view_count=view_count,
        organization="vspo",
    )


# --- parse_report_date -----------------------------------------------------


def test_parse_report_date_accepts_a_valid_date():
    assert parse_report_date("2026-09-01") == date(2026, 9, 1)


@pytest.mark.parametrize("non_canonical", ["20260901", "2026-W01-1", "2026-9-1"])
def test_parse_report_date_rejects_non_canonical_iso_forms_python_would_otherwise_accept(non_canonical):
    """date.fromisoformat() (3.11+) also accepts basic-format and week-date ISO
    8601 strings; the API contract is exactly YYYY-MM-DD, not "anything
    fromisoformat happens to parse", since this is untrusted public input."""
    with pytest.raises(ClientError):
        parse_report_date(non_canonical)


@pytest.mark.parametrize("bad_value", [None, 123, "", "not-a-date", "2026-13-40", "2026/09/01", "'; DROP TABLE videos;--"])
def test_parse_report_date_rejects_malformed_or_adversarial_values(bad_value):
    """Garbage, wrong-format, and injection-style values are all rejected the
    same clean way — never reaching date-parsing code that could raise
    something other than ClientError."""
    with pytest.raises(ClientError):
        parse_report_date(bad_value)


# --- parse_time_zone ---------------------------------------------------


@pytest.mark.parametrize("zone", ["Asia/Tokyo", "Asia/Hong_Kong", "Europe/London", "UTC"])
def test_parse_time_zone_accepts_representative_iana_zones(zone):
    assert parse_time_zone(zone) == zone


@pytest.mark.parametrize("bad_value", [None, 123, "", "+09:00", "Not/A_Real_Zone", "../../etc/passwd"])
def test_parse_time_zone_rejects_malformed_or_adversarial_values(bad_value):
    with pytest.raises(ClientError):
        parse_time_zone(bad_value)


# --- parse_period ------------------------------------------------------


@pytest.mark.parametrize("period", ["1d", "7d", "30d"])
def test_parse_period_accepts_supported_values(period):
    assert parse_period(period) == period


@pytest.mark.parametrize("bad_value", [None, 123, "", "14d", "7D", "week"])
def test_parse_period_rejects_unsupported_values(bad_value):
    with pytest.raises(ClientError):
        parse_period(bad_value)


# --- parse_video_id ------------------------------------------------------


@pytest.mark.parametrize("bad_value", [None, 123, ""])
def test_parse_video_id_rejects_missing_or_non_string_values(bad_value):
    with pytest.raises(ClientError):
        parse_video_id(bad_value)


# --- get_video_growth ----------------------------------------------------


def test_get_video_growth_returns_normalized_response(monkeypatch):
    """A well-formed request returns the full Roadmap 3.4 response shape,
    with creator classification fields carried directly (not inferred)."""
    monkeypatch.setattr(read_api, "get_video", lambda video_id: _video(video_id=video_id))
    monkeypatch.setattr(
        read_api,
        "get_snapshot",
        lambda video_id, snapshot_date: {
            "2026-09-01": _snapshot("2026-09-01", 1240),
            "2026-08-25": _snapshot("2026-08-25", 1000),
        }.get(snapshot_date.isoformat()),
    )
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])

    response = get_video_growth({"videoId": "v1", "reportDate": "2026-09-01", "timeZone": "Europe/London", "period": "7d"})

    assert response == {
        "timeZone": "Europe/London",
        "reportDate": "2026-09-01",
        "comparisonDate": "2026-08-25",
        "period": "7d",
        "status": "ok",
        "lastUpdatedAt": "2026-09-01T18:00:05+09:00",
        "videoId": "v1",
        "title": "Test Video",
        "organization": "vspo",
        "branch": "vspo_jp",
        "groupKey": ["1期生"],
        "channelType": "member",
        "lifecycleStage": "active",
        "latestViewCount": 1240,
        "comparisonViewCount": 1000,
        "growth": 240,
        "growthPercent": pytest.approx(24.0),
    }


def test_get_video_growth_raises_for_unknown_video_id(monkeypatch):
    """A syntactically valid but nonexistent videoId is a clean client error,
    not a KeyError/crash further down the pipeline."""
    monkeypatch.setattr(read_api, "get_video", lambda video_id: None)

    with pytest.raises(VideoNotFoundError):
        get_video_growth({"videoId": "no_such_video", "reportDate": "2026-09-01", "timeZone": "UTC", "period": "1d"})


def test_get_video_growth_tolerates_a_video_with_no_creator_master_record(monkeypatch):
    """A video whose creator_id has no matching Creator Master record still
    returns a response (classification fields None) instead of crashing."""
    monkeypatch.setattr(read_api, "get_video", lambda video_id: _video(video_id=video_id, creator_id="ghost_creator"))
    monkeypatch.setattr(read_api, "get_snapshot", lambda video_id, snapshot_date: None)
    monkeypatch.setattr(read_api, "load_creators", lambda: [])

    response = get_video_growth({"videoId": "v1", "reportDate": "2026-09-01", "timeZone": "UTC", "period": "1d"})

    assert response["organization"] is None
    assert response["branch"] is None
    assert response["status"] == "pending"


def test_get_video_growth_rejects_malformed_report_date_before_touching_storage(monkeypatch):
    """Validation happens before any lookup — a malformed reportDate never
    reaches get_video/get_snapshot at all."""

    def _boom(*args, **kwargs):
        raise AssertionError("storage should not be touched for an invalid request")

    monkeypatch.setattr(read_api, "get_video", _boom)

    with pytest.raises(ClientError):
        get_video_growth({"videoId": "v1", "reportDate": "not-a-date", "timeZone": "UTC", "period": "1d"})
