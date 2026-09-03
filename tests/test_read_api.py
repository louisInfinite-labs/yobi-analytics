from datetime import date

import pytest

import read_api
from creator_master import Creator
from read_api import (
    ClientError,
    VideoNotFoundError,
    get_creator_trending,
    get_organization_trending,
    get_video_growth,
    parse_creator_id,
    parse_limit,
    parse_organization,
    parse_period,
    parse_ranking_type,
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


def _snapshot(snapshot_date: str, view_count: int, **overrides) -> Snapshot:
    """Build a minimal Snapshot for a test, overriding only the given fields."""
    fields = {
        "snapshot_date": snapshot_date,
        "observed_at": f"{snapshot_date}T18:00:05+09:00",
        "creator_id": "aizawa_ema",
        "video_id": "v1",
        "title": "Test Video",
        "published_at": "2026-08-20T00:00:00Z",
        "view_count": view_count,
        "organization": "vspo",
    }
    fields.update(overrides)
    return Snapshot(**fields)


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


# --- parse_creator_id / parse_organization --------------------------------


@pytest.mark.parametrize("bad_value", [None, 123, ""])
def test_parse_creator_id_rejects_missing_or_non_string_values(bad_value):
    with pytest.raises(ClientError):
        parse_creator_id(bad_value)


@pytest.mark.parametrize("bad_value", [None, 123, ""])
def test_parse_organization_rejects_missing_or_non_string_values(bad_value):
    with pytest.raises(ClientError):
        parse_organization(bad_value)


# --- parse_ranking_type ----------------------------------------------------


@pytest.mark.parametrize(
    ("period", "expected"),
    [("1d", "daily_trending"), ("7d", "7d_trending"), ("30d", "30d_trending")],
)
def test_parse_ranking_type_defaults_to_the_period_trending_type(period, expected):
    assert parse_ranking_type(None, period=period) == expected
    assert parse_ranking_type("", period=period) == expected


@pytest.mark.parametrize("ranking_type", ["most_viewed", "fastest_growing"])
def test_parse_ranking_type_accepts_period_independent_types_for_any_period(ranking_type):
    assert parse_ranking_type(ranking_type, period="30d") == ranking_type


def test_parse_ranking_type_rejects_a_period_trending_type_that_does_not_match_period():
    """daily_trending computed from 30d GrowthResults can never rank anything
    (rank_videos filters by result.period == "1d"), so this is a client error
    rather than a silently empty result."""
    with pytest.raises(ClientError):
        parse_ranking_type("daily_trending", period="30d")


@pytest.mark.parametrize("bad_value", [123, "not_a_real_type", "weekly_trending"])
def test_parse_ranking_type_rejects_unsupported_values(bad_value):
    with pytest.raises(ClientError):
        parse_ranking_type(bad_value, period="1d")


# --- parse_limit -------------------------------------------------------


@pytest.mark.parametrize("value", [None, ""])
def test_parse_limit_defaults_to_none_when_absent(value):
    assert parse_limit(value) is None


@pytest.mark.parametrize("value", ["5", 5])
def test_parse_limit_accepts_a_positive_integer(value):
    assert parse_limit(value) == 5


@pytest.mark.parametrize("bad_value", [0, -1, "0", "-3", "not-a-number", True, False])
def test_parse_limit_rejects_non_positive_or_non_integer_values(bad_value):
    """True/False are rejected even though bool is an int subclass — a
    boolean limit is never a meaningful request."""
    with pytest.raises(ClientError):
        parse_limit(bad_value)


# --- get_creator_trending --------------------------------------------------


def _trending_fixture(monkeypatch, *, creators, videos, snapshots):
    """Wire load_creators/load_videos/get_video/get_snapshot for a trending test.

    `snapshots` maps (video_id, snapshot_date_iso) -> Snapshot.
    """
    videos_by_id = {video.video_id: video for video in videos}
    monkeypatch.setattr(read_api, "load_creators", lambda: creators)
    monkeypatch.setattr(read_api, "load_videos", lambda: videos)
    monkeypatch.setattr(read_api, "get_video", lambda video_id: videos_by_id.get(video_id))
    monkeypatch.setattr(
        read_api,
        "get_snapshot",
        lambda video_id, snapshot_date: snapshots.get((video_id, snapshot_date.isoformat())),
    )


def test_get_creator_trending_returns_ranked_response(monkeypatch):
    """Two videos for one creator are ranked by growth, most-grown first, and
    each result row carries classification fields joined from Creator Master."""
    _trending_fixture(
        monkeypatch,
        creators=[_creator()],
        videos=[
            _video(video_id="v1", creator_id="aizawa_ema"),
            _video(video_id="v2", creator_id="aizawa_ema", title="Video Two"),
        ],
        snapshots={
            ("v1", "2026-09-01"): _snapshot("2026-09-01", 1240, video_id="v1"),
            ("v1", "2026-08-25"): _snapshot("2026-08-25", 1000, video_id="v1"),
            ("v2", "2026-09-01"): _snapshot("2026-09-01", 500, video_id="v2"),
            ("v2", "2026-08-25"): _snapshot("2026-08-25", 100, video_id="v2"),
        },
    )

    response = get_creator_trending(
        {"creatorId": "aizawa_ema", "reportDate": "2026-09-01", "timeZone": "UTC", "period": "7d"}
    )

    assert response["creatorId"] == "aizawa_ema"
    assert response["comparisonDate"] == "2026-08-25"
    assert response["rankingType"] == "7d_trending"
    assert [entry["videoId"] for entry in response["results"]] == ["v2", "v1"]
    assert response["results"][0] == {
        "rank": 1,
        "videoId": "v2",
        "value": 400,
        "title": "Video Two",
        "organization": "vspo",
        "branch": "vspo_jp",
        "groupKey": ["1期生"],
        "channelType": "member",
        "lifecycleStage": "active",
        "latestViewCount": 500,
        "growth": 400,
        "growthPercent": pytest.approx(400.0),
        "status": "ok",
    }
    assert response["results"][1]["rank"] == 2


def test_get_creator_trending_respects_limit(monkeypatch):
    _trending_fixture(
        monkeypatch,
        creators=[_creator()],
        videos=[
            _video(video_id="v1", creator_id="aizawa_ema"),
            _video(video_id="v2", creator_id="aizawa_ema"),
        ],
        snapshots={
            ("v1", "2026-09-01"): _snapshot("2026-09-01", 1240, video_id="v1"),
            ("v1", "2026-08-31"): _snapshot("2026-08-31", 1000, video_id="v1"),
            ("v2", "2026-09-01"): _snapshot("2026-09-01", 500, video_id="v2"),
            ("v2", "2026-08-31"): _snapshot("2026-08-31", 100, video_id="v2"),
        },
    )

    response = get_creator_trending(
        {"creatorId": "aizawa_ema", "reportDate": "2026-09-01", "timeZone": "UTC", "period": "1d", "limit": "1"}
    )

    assert len(response["results"]) == 1
    assert response["results"][0]["videoId"] == "v2"


def test_get_creator_trending_raises_for_unknown_creator_id(monkeypatch):
    monkeypatch.setattr(read_api, "load_creators", lambda: [])

    with pytest.raises(ClientError):
        get_creator_trending(
            {"creatorId": "no_such_creator", "reportDate": "2026-09-01", "timeZone": "UTC", "period": "1d"}
        )


def test_get_creator_trending_rejects_malformed_report_date_before_touching_storage(monkeypatch):
    def _boom(*args, **kwargs):
        raise AssertionError("storage should not be touched for an invalid request")

    monkeypatch.setattr(read_api, "load_creators", _boom)
    monkeypatch.setattr(read_api, "load_videos", _boom)

    with pytest.raises(ClientError):
        get_creator_trending(
            {"creatorId": "aizawa_ema", "reportDate": "not-a-date", "timeZone": "UTC", "period": "1d"}
        )


# --- get_organization_trending ----------------------------------------------


def test_get_organization_trending_scopes_to_organization_creators(monkeypatch):
    """A video belonging to a creator in a different organization must never
    leak into another organization's trending list."""
    _trending_fixture(
        monkeypatch,
        creators=[
            _creator(creator_id="aizawa_ema", organization="vspo"),
            _creator(creator_id="other_org_creator", organization="hololive", youtube_channel_id="UC_other"),
        ],
        videos=[
            _video(video_id="v1", creator_id="aizawa_ema"),
            _video(video_id="v_other", creator_id="other_org_creator"),
        ],
        snapshots={
            ("v1", "2026-09-01"): _snapshot("2026-09-01", 1240, video_id="v1"),
            ("v1", "2026-08-31"): _snapshot("2026-08-31", 1000, video_id="v1"),
            ("v_other", "2026-09-01"): _snapshot("2026-09-01", 9999, video_id="v_other", creator_id="other_org_creator"),
            ("v_other", "2026-08-31"): _snapshot("2026-08-31", 1, video_id="v_other", creator_id="other_org_creator"),
        },
    )

    response = get_organization_trending(
        {"organization": "vspo", "reportDate": "2026-09-01", "timeZone": "UTC", "period": "1d"}
    )

    assert response["organization"] == "vspo"
    assert [entry["videoId"] for entry in response["results"]] == ["v1"]


def test_get_organization_trending_raises_for_an_organization_with_no_creators(monkeypatch):
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator(organization="vspo")])

    with pytest.raises(ClientError):
        get_organization_trending(
            {"organization": "no_such_org", "reportDate": "2026-09-01", "timeZone": "UTC", "period": "1d"}
        )


def test_get_organization_trending_rejects_a_ranking_type_period_mismatch_before_touching_storage(monkeypatch):
    def _boom(*args, **kwargs):
        raise AssertionError("storage should not be touched for an invalid request")

    monkeypatch.setattr(read_api, "load_creators", _boom)
    monkeypatch.setattr(read_api, "load_videos", _boom)

    with pytest.raises(ClientError):
        get_organization_trending(
            {
                "organization": "vspo",
                "reportDate": "2026-09-01",
                "timeZone": "UTC",
                "period": "30d",
                "rankingType": "daily_trending",
            }
        )
