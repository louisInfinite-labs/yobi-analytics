from datetime import date, datetime, timedelta, timezone

import pytest

from api import read_api
from api.holodex_client import HolodexAPIError
from api.holodex_normalization import HolodexNormalizationError
from ops.config import MissingHolodexApiKeyError
from tracking.creator_master import Creator
from api.read_api import (
    ClientError,
    ScopeNotFoundError,
    VideoNotFoundError,
    get_live_streams,
    get_recent_streams,
    get_video_growth,
    parse_creator_id,
    parse_limit,
    parse_offset,
    parse_period,
    parse_recent_streams_limit,
    parse_report_date,
    parse_time_zone,
    parse_video_id,
)
from stores.snapshot_store import Snapshot
from tracking.video_master import Video


def _video(**overrides) -> Video:
    """Build a minimal Video for a test, overriding only the given fields."""
    fields = {
        "video_id": "vid00000001",
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
        "display_order": 0,
    }
    fields.update(overrides)
    return Creator(**fields)


def _snapshot(snapshot_date: str, view_count: int, **overrides) -> Snapshot:
    """Build a minimal Snapshot for a test, overriding only the given fields."""
    fields = {
        "snapshot_date": snapshot_date,
        "observed_at": f"{snapshot_date}T18:00:05+09:00",
        "creator_id": "aizawa_ema",
        "video_id": "vid00000001",
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

    response = get_video_growth({"videoId": "vid00000001", "reportDate": "2026-09-01", "timeZone": "Europe/London", "period": "7d"})

    assert response == {
        "timeZone": "Europe/London",
        "reportDate": "2026-09-01",
        "comparisonDate": "2026-08-25",
        "period": "7d",
        "status": "ok",
        "lastUpdatedAt": "2026-09-01T18:00:05+09:00",
        "videoId": "vid00000001",
        "title": "Test Video",
        "creatorId": "aizawa_ema",
        "channelName": "藍沢エマ",
        "organization": "vspo",
        "branch": "vspo_jp",
        "groupKey": ["1期生"],
        "channelType": "member",
        "lifecycleStage": "active",
        "themeColor": None,
        "latestViewCount": 1240,
        "comparisonViewCount": 1000,
        "growth": 240,
        "growthPercent": pytest.approx(24.0),
    }


def test_get_video_growth_carries_creator_theme_color_when_verified(monkeypatch):
    """A creator with a verified backend themeColor has it carried through
    the growth response unchanged, alongside the other classification fields."""
    monkeypatch.setattr(read_api, "get_video", lambda video_id: _video(video_id=video_id))
    monkeypatch.setattr(
        read_api,
        "get_snapshot",
        lambda video_id, snapshot_date: {
            "2026-09-01": _snapshot("2026-09-01", 1240),
            "2026-08-25": _snapshot("2026-08-25", 1000),
        }.get(snapshot_date.isoformat()),
    )
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator(theme_color="#B4F1F9")])

    response = get_video_growth({"videoId": "vid00000001", "reportDate": "2026-09-01", "timeZone": "Europe/London", "period": "7d"})

    assert response["themeColor"] == "#B4F1F9"


def test_get_video_growth_raises_for_unknown_video_id(monkeypatch):
    """A syntactically valid but nonexistent videoId is a clean client error,
    not a KeyError/crash further down the pipeline."""
    monkeypatch.setattr(read_api, "get_video", lambda video_id: None)

    with pytest.raises(VideoNotFoundError):
        get_video_growth({"videoId": "no_such_vid", "reportDate": "2026-09-01", "timeZone": "UTC", "period": "1d"})


def test_get_video_growth_tolerates_a_video_with_no_creator_master_record(monkeypatch):
    """A video whose creator_id has no matching Creator Master record still
    returns a response (classification fields None) instead of crashing."""
    monkeypatch.setattr(read_api, "get_video", lambda video_id: _video(video_id=video_id, creator_id="ghost_creator"))
    monkeypatch.setattr(read_api, "get_snapshot", lambda video_id, snapshot_date: None)
    monkeypatch.setattr(read_api, "load_creators", lambda: [])

    response = get_video_growth({"videoId": "vid00000001", "reportDate": "2026-09-01", "timeZone": "UTC", "period": "1d"})

    assert response["organization"] is None
    assert response["branch"] is None
    assert response["status"] == "pending"


def test_get_video_growth_reports_not_available_for_dates_before_the_videos_own_onboarding(monkeypatch):
    """A video discovered after COLLECTION_START_DATE must not be reported
    `pending` for dates before its own onboarding — those snapshots can
    never arrive, since the collector didn't know about the video yet."""
    monkeypatch.setattr(
        read_api, "get_video", lambda video_id: _video(video_id=video_id, discovered_at="2026-09-01T00:00:00Z")
    )
    monkeypatch.setattr(read_api, "get_snapshot", lambda video_id, snapshot_date: None)
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])

    response = get_video_growth({"videoId": "vid00000001", "reportDate": "2026-08-30", "timeZone": "UTC", "period": "1d"})

    assert response["status"] == "not_available"


def test_get_video_growth_rejects_malformed_report_date_before_touching_storage(monkeypatch):
    """Validation happens before any lookup — a malformed reportDate never
    reaches get_video/get_snapshot at all."""

    def _boom(*args, **kwargs):
        raise AssertionError("storage should not be touched for an invalid request")

    monkeypatch.setattr(read_api, "get_video", _boom)

    with pytest.raises(ClientError):
        get_video_growth({"videoId": "vid00000001", "reportDate": "not-a-date", "timeZone": "UTC", "period": "1d"})


# --- parse_creator_id --------------------------------


@pytest.mark.parametrize("bad_value", [None, 123, ""])
def test_parse_creator_id_rejects_missing_or_non_string_values(bad_value):
    with pytest.raises(ClientError):
        parse_creator_id(bad_value)


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


def test_parse_limit_accepts_the_max_limit_exactly():
    assert parse_limit(read_api.MAX_LIMIT) == read_api.MAX_LIMIT


def test_parse_limit_rejects_a_value_above_max_limit():
    with pytest.raises(ClientError):
        parse_limit(read_api.MAX_LIMIT + 1)
# ============ get_live_streams (Holodex read-path integration) ============
# Only holodex_get (the actual HTTP boundary, api/holodex_client.py) is ever
# mocked below -- normalize_holodex_live_response/normalize_holodex_stream
# (api/holodex_normalization.py) run for real, so these tests exercise the
# same normalization this endpoint runs in production, not a stand-in for it.


def _holodex_item(*, video_id="v1", status="live", channel_id="UC_test", channel_name="藍沢エマ", **overrides):
    """Build one raw Holodex /users/live item, shaped like the real documented response."""
    item = {
        "id": video_id,
        "status": status,
        "channel": {"id": channel_id, "name": channel_name},
        "title": "Test Stream",
        "start_scheduled": None,
        "start_actual": "2026-09-01T10:00:00Z" if status == "live" else None,
    }
    item.update(overrides)
    return item


def test_get_live_streams_returns_a_live_stream_for_a_supported_creator(monkeypatch):
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator(youtube_channel_id="UC_test")])
    captured = {}

    def fake_holodex_get(path, params=None):
        captured["path"], captured["params"] = path, params
        return [_holodex_item(status="live")]

    monkeypatch.setattr(read_api, "holodex_get", fake_holodex_get)

    result = get_live_streams()

    assert captured["path"] == "/users/live"
    assert result == {
        "streams": [
            {
                "videoId": "v1",
                "creatorId": "aizawa_ema",
                "channelName": "藍沢エマ",
                "title": "Test Stream",
                "status": "live",
                "scheduledStart": None,
                "actualStart": "2026-09-01T10:00:00+00:00",
                "thumbnailUrl": "https://img.youtube.com/vi/v1/hqdefault.jpg",
            }
        ]
    }


def test_get_live_streams_returns_an_upcoming_stream_for_a_supported_creator(monkeypatch):
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator(youtube_channel_id="UC_test")])
    monkeypatch.setattr(
        read_api,
        "holodex_get",
        lambda path, params=None: [_holodex_item(status="upcoming", start_scheduled="2026-09-02T09:00:00Z")],
    )

    result = get_live_streams()

    assert len(result["streams"]) == 1
    assert result["streams"][0]["status"] == "upcoming"
    assert result["streams"][0]["scheduledStart"] == "2026-09-02T09:00:00+00:00"


def test_get_live_streams_retains_an_upcoming_stream_within_the_168_hour_lookahead(monkeypatch):
    """/users/live has no lookahead limit of its own (a live probe found upcoming
    entries scheduled over 700 days out) -- Yobi's 7-day window is enforced
    locally, so an upcoming stream just inside it must still be retained."""
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator(youtube_channel_id="UC_test")])
    scheduled_at = datetime.now(timezone.utc) + timedelta(hours=167)
    monkeypatch.setattr(
        read_api,
        "holodex_get",
        lambda path, params=None: [
            _holodex_item(status="upcoming", start_scheduled=scheduled_at.isoformat().replace("+00:00", "Z"))
        ],
    )

    result = get_live_streams()

    assert len(result["streams"]) == 1
    assert result["streams"][0]["status"] == "upcoming"


def test_get_live_streams_excludes_an_upcoming_stream_beyond_the_168_hour_lookahead(monkeypatch):
    """The same local window must actually exclude what it's supposed to --
    /users/live returning a stream scheduled well beyond 7 days out (which it
    does, unlike /live, since it applies no lookahead cutoff of its own) must
    not leak into the response just because Holodex included it."""
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator(youtube_channel_id="UC_test")])
    scheduled_at = datetime.now(timezone.utc) + timedelta(hours=169)
    monkeypatch.setattr(
        read_api,
        "holodex_get",
        lambda path, params=None: [
            _holodex_item(status="upcoming", start_scheduled=scheduled_at.isoformat().replace("+00:00", "Z"))
        ],
    )

    assert get_live_streams() == {"streams": []}


def test_get_live_streams_always_retains_live_regardless_of_scheduled_start(monkeypatch):
    """The 168-hour lookahead only governs "upcoming" -- a "live" stream is
    already happening and must never be excluded by it, even if its (now
    historical) scheduled_start happens to be missing or far in the past."""
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator(youtube_channel_id="UC_test")])
    monkeypatch.setattr(
        read_api, "holodex_get", lambda path, params=None: [_holodex_item(status="live", start_scheduled=None)]
    )

    result = get_live_streams()

    assert len(result["streams"]) == 1
    assert result["streams"][0]["status"] == "live"


def test_get_live_streams_excludes_an_upcoming_stream_with_an_unparsable_scheduled_start(monkeypatch):
    """An upcoming item this project cannot confirm is due within the window
    must not be shown as if it were -- excluded defensively, same posture as
    normalize_holodex_stream's own per-field degradation, never a crash."""
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator(youtube_channel_id="UC_test")])
    monkeypatch.setattr(
        read_api,
        "holodex_get",
        lambda path, params=None: [_holodex_item(status="upcoming", start_scheduled="not-a-timestamp")],
    )

    assert get_live_streams() == {"streams": []}


def test_get_live_streams_filters_out_a_channel_holodex_returns_that_is_not_supported(monkeypatch):
    """Defense-in-depth: even though the request itself only asks Holodex for
    eligible channels, a normalized item for an unrequested/unsupported
    channel (e.g. an unmapped collab guest) must never leak into the result."""
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator(youtube_channel_id="UC_test")])
    monkeypatch.setattr(
        read_api,
        "holodex_get",
        lambda path, params=None: [_holodex_item(channel_id="UC_unsupported_guest")],
    )

    result = get_live_streams()

    assert result == {"streams": []}


def test_get_live_streams_does_not_request_a_graduated_creator(monkeypatch):
    """A graduated creator is a real, displayed Creator Master identity but is not
    polling-eligible -- must not appear in the Holodex `channels` param (visibility
    in Live Status costs no API quota; their row falls back to OFFLINE client-side)."""
    monkeypatch.setattr(
        read_api,
        "load_creators",
        lambda: [
            _creator(creator_id="active_one", youtube_channel_id="UC_active"),
            _creator(creator_id="graduated_one", youtube_channel_id="UC_graduated", lifecycle_stage="graduated"),
        ],
    )
    captured = {}

    def fake_holodex_get(path, params=None):
        captured["params"] = params
        return []

    monkeypatch.setattr(read_api, "holodex_get", fake_holodex_get)

    get_live_streams()

    assert captured["params"]["channels"] == "UC_active"


def test_get_live_streams_requests_active_group_and_staff_channels_alongside_members(monkeypatch):
    """Group and staff channels (e.g. vspo_official) get the same Live Status
    behaviour as members, so they are asked about too."""
    monkeypatch.setattr(
        read_api,
        "load_creators",
        lambda: [
            _creator(creator_id="a_member", youtube_channel_id="UC_member"),
            _creator(creator_id="pre_debut_member", youtube_channel_id="UC_predebut", lifecycle_stage="pre_debut"),
            _creator(creator_id="a_group", youtube_channel_id="UC_group", channel_type="group"),
            _creator(creator_id="pre_debut_group", youtube_channel_id="UC_pregroup", channel_type="group", lifecycle_stage="pre_debut"),
            _creator(creator_id="a_staff", youtube_channel_id="UC_staff", channel_type="staff"),
            _creator(creator_id="graduated_one", youtube_channel_id="UC_graduated", lifecycle_stage="graduated"),
        ],
    )
    captured = {}

    def fake_holodex_get(path, params=None):
        captured["params"] = params
        return []

    monkeypatch.setattr(read_api, "holodex_get", fake_holodex_get)

    get_live_streams()

    assert captured["params"]["channels"].split(",") == ["UC_member", "UC_predebut", "UC_group", "UC_pregroup", "UC_staff"]


def test_get_live_streams_does_not_request_a_channel_with_a_malformed_youtube_id(monkeypatch):
    monkeypatch.setattr(
        read_api,
        "load_creators",
        lambda: [
            _creator(creator_id="good", youtube_channel_id="UC_good"),
            _creator(creator_id="blank", youtube_channel_id=""),
            _creator(creator_id="junk", youtube_channel_id="not-a-channel-id"),
        ],
    )
    captured = {}

    def fake_holodex_get(path, params=None):
        captured["params"] = params
        return []

    monkeypatch.setattr(read_api, "holodex_get", fake_holodex_get)

    get_live_streams()

    assert captured["params"]["channels"] == "UC_good"


def test_get_live_streams_maps_a_group_channel_stream_to_its_creator_id(monkeypatch):
    """A live stream on an official/group channel is returned like any other, keyed by
    that channel's own creatorId -- the frontend overlays it on the canonical roster."""
    monkeypatch.setattr(
        read_api,
        "load_creators",
        lambda: [_creator(creator_id="vspo_official", youtube_channel_id="UC_vspo", channel_type="group")],
    )
    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [_holodex_item(channel_id="UC_vspo")])

    result = get_live_streams()

    assert [stream["creatorId"] for stream in result["streams"]] == ["vspo_official"]


def test_get_live_streams_skips_the_holodex_call_entirely_when_no_creator_is_eligible(monkeypatch):
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator(lifecycle_stage="graduated")])

    def _boom(*args, **kwargs):
        raise AssertionError("Holodex must not be called when there is nothing to ask it about")

    monkeypatch.setattr(read_api, "holodex_get", _boom)

    assert get_live_streams() == {"streams": []}


def test_get_live_streams_returns_empty_for_a_genuinely_empty_holodex_result(monkeypatch):
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator(youtube_channel_id="UC_test")])
    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [])

    assert get_live_streams() == {"streams": []}


def test_get_live_streams_propagates_holodex_client_failure_without_fabricating_a_result(monkeypatch):
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator(youtube_channel_id="UC_test")])

    def _boom(path, params=None):
        raise HolodexAPIError("Holodex API request to '/live' timed out")

    monkeypatch.setattr(read_api, "holodex_get", _boom)

    with pytest.raises(HolodexAPIError):
        get_live_streams()


def test_get_live_streams_propagates_an_unexpected_top_level_shape_as_normalization_error(monkeypatch):
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator(youtube_channel_id="UC_test")])
    # Not a list -- the documented Holodex /users/live shape -- so real
    # normalize_holodex_live_response (not mocked) must raise, not coerce it.
    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: {"error": "rate limited"})

    with pytest.raises(HolodexNormalizationError):
        get_live_streams()


def test_get_live_streams_tolerates_one_malformed_item_alongside_valid_ones(monkeypatch):
    monkeypatch.setattr(
        read_api,
        "load_creators",
        lambda: [_creator(creator_id="aizawa_ema", youtube_channel_id="UC_test")],
    )
    monkeypatch.setattr(
        read_api,
        "holodex_get",
        lambda path, params=None: [
            {"status": "live", "channel": {"id": "UC_test"}},  # missing "id" -- dropped, not a crash
            _holodex_item(video_id="v2", status="live"),
        ],
    )

    result = get_live_streams()

    assert [stream["videoId"] for stream in result["streams"]] == ["v2"]


def test_get_live_streams_makes_exactly_one_aggregate_holodex_request_for_every_eligible_creator(monkeypatch):
    """Never one Holodex request per creator -- a single /users/live call
    carrying every eligible creator's channel id in one `channels` param."""
    creators = [_creator(creator_id=f"creator_{i}", youtube_channel_id=f"UC_{i}") for i in range(5)]
    monkeypatch.setattr(read_api, "load_creators", lambda: creators)
    calls = []

    def fake_holodex_get(path, params=None):
        calls.append((path, params))
        return []

    monkeypatch.setattr(read_api, "holodex_get", fake_holodex_get)

    get_live_streams()

    assert len(calls) == 1
    path, params = calls[0]
    assert path == "/users/live"
    assert set(params["channels"].split(",")) == {f"UC_{i}" for i in range(5)}


def test_get_live_streams_uses_the_documented_users_live_endpoint_with_channels_param(monkeypatch):
    """/live only documents `channel_id` (singular); Holodex documents the
    `channels` (comma-separated) filter for /users/live -- verified against
    the real API (2026-09-29): the same `channels=` request against /live
    silently ignored the filter and returned platform-wide results (806
    distinct channels for a 97-channel request), while /users/live correctly
    scoped its response to only the requested channels. No max_upcoming_hours
    is sent -- a live probe confirmed /users/live doesn't honor it anyway."""
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator(youtube_channel_id="UC_test")])
    captured = {}

    def fake_holodex_get(path, params=None):
        captured["path"], captured["params"] = path, params
        return []

    monkeypatch.setattr(read_api, "holodex_get", fake_holodex_get)

    get_live_streams()

    assert captured["path"] == "/users/live"
    assert captured["params"] == {"channels": "UC_test"}
    assert "max_upcoming_hours" not in captured["params"]


# ============ get_recent_streams (GET /recent-streams -- ended archives only) ============
# Only holodex_get is ever mocked below -- real normalize_holodex_archived_streams_response
# runs, same convention as the get_live_streams tests above.


def _archived_item(*, video_id="v1", title="Archive stream", available_at="2026-09-20T10:00:00Z", channel_id="UC_test", channel_name="Test Creator", **overrides):
    item = {"id": video_id, "title": title, "available_at": available_at, "channel": {"id": channel_id, "name": channel_name}}
    item.update(overrides)
    return item


def test_get_recent_streams_returns_archived_streams_for_a_valid_creator(monkeypatch):
    monkeypatch.setattr(read_api, "_find_creator", lambda creator_id: _creator(youtube_channel_id="UC_test"))
    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [_archived_item()])

    result = get_recent_streams({"creatorId": "aizawa_ema"})

    assert result == {
        "creatorId": "aizawa_ema",
        "streams": [
            {
                "videoId": "v1",
                "creatorId": "aizawa_ema",
                "channelName": "Test Creator",
                "title": "Archive stream",
                "thumbnailUrl": "https://img.youtube.com/vi/v1/hqdefault.jpg",
                "publishedAt": "2026-09-20T10:00:00+00:00",
            }
        ],
        "hasMore": False,
    }


def test_get_recent_streams_holodex_query_uses_past_stream_type_and_available_at_desc(monkeypatch):
    monkeypatch.setattr(read_api, "_find_creator", lambda creator_id: _creator(youtube_channel_id="UC_test"))
    captured = {}

    def fake_holodex_get(path, params=None):
        captured["path"], captured["params"] = path, params
        return []

    monkeypatch.setattr(read_api, "holodex_get", fake_holodex_get)

    get_recent_streams({"creatorId": "aizawa_ema"})

    assert captured["path"] == "/videos"
    assert captured["params"]["channel_id"] == "UC_test"
    assert captured["params"]["type"] == "stream"
    assert captured["params"]["status"] == "past"
    assert captured["params"]["sort"] == "available_at"
    assert captured["params"]["order"] == "desc"


def test_get_recent_streams_defaults_limit_to_four(monkeypatch):
    monkeypatch.setattr(read_api, "_find_creator", lambda creator_id: _creator(youtube_channel_id="UC_test"))
    captured = {}
    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: (captured.update(params), [])[1])

    get_recent_streams({"creatorId": "aizawa_ema"})

    assert captured["limit"] == "4"
    assert captured["offset"] == "0"


def test_get_recent_streams_forwards_limit_and_offset(monkeypatch):
    monkeypatch.setattr(read_api, "_find_creator", lambda creator_id: _creator(youtube_channel_id="UC_test"))
    captured = {}
    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: (captured.update(params), [])[1])

    get_recent_streams({"creatorId": "aizawa_ema", "limit": "2", "offset": "6"})

    assert captured["limit"] == "2"
    assert captured["offset"] == "6"


def test_get_recent_streams_has_more_true_when_archive_count_reaches_limit(monkeypatch):
    monkeypatch.setattr(read_api, "_find_creator", lambda creator_id: _creator(youtube_channel_id="UC_test"))
    monkeypatch.setattr(
        read_api, "holodex_get", lambda path, params=None: [_archived_item(video_id=f"v{i}") for i in range(2)]
    )

    result = get_recent_streams({"creatorId": "aizawa_ema", "limit": "2"})

    assert result["hasMore"] is True


@pytest.mark.parametrize("discarded_item", [None, {}, _archived_item(video_id=""), _archived_item(channel=None)])
def test_get_recent_streams_has_more_uses_raw_count_when_normalization_discards_items(monkeypatch, discarded_item):
    monkeypatch.setattr(read_api, "_find_creator", lambda creator_id: _creator())
    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [_archived_item(), discarded_item])

    result = get_recent_streams({"creatorId": "aizawa_ema", "limit": "2"})

    assert [stream["videoId"] for stream in result["streams"]] == ["v1"]
    assert result["hasMore"] is True


def test_get_recent_streams_has_more_false_when_archive_count_is_below_limit(monkeypatch):
    monkeypatch.setattr(read_api, "_find_creator", lambda creator_id: _creator(youtube_channel_id="UC_test"))
    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [_archived_item()])

    result = get_recent_streams({"creatorId": "aizawa_ema", "limit": "4"})

    assert result["hasMore"] is False


def test_get_recent_streams_rejects_an_unknown_creator(monkeypatch):
    monkeypatch.setattr(read_api, "_find_creator", lambda creator_id: None)

    def _boom(*args, **kwargs):
        raise AssertionError("Holodex must not be called for an unknown creator")

    monkeypatch.setattr(read_api, "holodex_get", _boom)

    with pytest.raises(ScopeNotFoundError):
        get_recent_streams({"creatorId": "does_not_exist"})


def test_get_recent_streams_rejects_an_ineligible_creator(monkeypatch):
    """A real Creator Master record that fails is_current_member_eligible
    (e.g. graduated, or a group/staff channel) is rejected the same clean way
    as an unknown creatorId -- /recent-streams' existing member-only behaviour,
    unchanged by the Live Status roster work."""
    for overrides in ({"lifecycle_stage": "graduated"}, {"channel_type": "group"}, {"channel_type": "staff"}):
        monkeypatch.setattr(read_api, "_find_creator", lambda creator_id, o=overrides: _creator(**o))

        def _boom(*args, **kwargs):
            raise AssertionError("Holodex must not be called for an ineligible creator")

        monkeypatch.setattr(read_api, "holodex_get", _boom)

        with pytest.raises(ScopeNotFoundError):
            get_recent_streams({"creatorId": "aizawa_ema"})


def test_get_recent_streams_returns_empty_for_a_genuinely_empty_archive(monkeypatch):
    monkeypatch.setattr(read_api, "_find_creator", lambda creator_id: _creator(youtube_channel_id="UC_test"))
    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [])

    result = get_recent_streams({"creatorId": "aizawa_ema"})

    assert result == {"creatorId": "aizawa_ema", "streams": [], "hasMore": False}


def test_get_recent_streams_propagates_holodex_client_failure_without_fabricating_a_result(monkeypatch):
    """Not caught here -- api_handler.py's existing dispatch already maps
    HolodexAPIError/MissingHolodexApiKeyError to a safe public 503, the
    identical handling get_live_streams' own callers go through."""
    monkeypatch.setattr(read_api, "_find_creator", lambda creator_id: _creator(youtube_channel_id="UC_test"))

    def _boom(path, params=None):
        raise HolodexAPIError("Holodex API request to '/videos' timed out")

    monkeypatch.setattr(read_api, "holodex_get", _boom)

    with pytest.raises(HolodexAPIError):
        get_recent_streams({"creatorId": "aizawa_ema"})


def test_get_recent_streams_propagates_missing_api_key_without_fabricating_a_result(monkeypatch):
    monkeypatch.setattr(read_api, "_find_creator", lambda creator_id: _creator(youtube_channel_id="UC_test"))

    def _boom(path, params=None):
        raise MissingHolodexApiKeyError("Neither HOLODEX_SECRET_NAME nor HOLODEX_API_KEY is set.")

    monkeypatch.setattr(read_api, "holodex_get", _boom)

    with pytest.raises(MissingHolodexApiKeyError):
        get_recent_streams({"creatorId": "aizawa_ema"})


def test_get_recent_streams_response_contains_only_the_requested_creator(monkeypatch):
    """Every stream in the response echoes the RESOLVED creator's own
    canonical creatorId -- never Holodex's own channel identity, and never
    a second creator's data, even if a malformed Holodex response somehow
    mixed in a different channel's item."""
    monkeypatch.setattr(read_api, "_find_creator", lambda creator_id: _creator(creator_id="aizawa_ema", youtube_channel_id="UC_test"))
    monkeypatch.setattr(
        read_api,
        "holodex_get",
        lambda path, params=None: [
            _archived_item(video_id="v1"),
            _archived_item(video_id="v2", channel_id="UC_other_channel", channel_name="Someone Else"),
        ],
    )

    result = get_recent_streams({"creatorId": "aizawa_ema", "limit": "2"})

    assert [stream["videoId"] for stream in result["streams"]] == ["v1"]
    assert {stream["creatorId"] for stream in result["streams"]} == {"aizawa_ema"}
    assert result["creatorId"] == "aizawa_ema"
    assert result["hasMore"] is True


def test_get_recent_streams_never_introduces_live_or_upcoming_fields(monkeypatch):
    """The response shape is archive-only -- no status/scheduledStart/
    actualStart fields, which belong exclusively to /live-streams."""
    monkeypatch.setattr(read_api, "_find_creator", lambda creator_id: _creator(youtube_channel_id="UC_test"))
    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [_archived_item()])

    result = get_recent_streams({"creatorId": "aizawa_ema"})

    [stream] = result["streams"]
    assert set(stream.keys()) == {"videoId", "creatorId", "channelName", "title", "thumbnailUrl", "publishedAt"}


def test_get_recent_streams_requires_creator_id():
    with pytest.raises(ClientError):
        get_recent_streams({})


class TestParseRecentStreamsLimit:
    def test_absent_defaults_to_four(self):
        assert parse_recent_streams_limit(None) == 4
        assert parse_recent_streams_limit("") == 4

    def test_valid_value_is_parsed(self):
        assert parse_recent_streams_limit("10") == 10

    def test_rejects_zero_or_negative(self):
        with pytest.raises(ClientError):
            parse_recent_streams_limit("0")
        with pytest.raises(ClientError):
            parse_recent_streams_limit("-1")

    def test_rejects_above_the_small_safe_upper_bound(self):
        with pytest.raises(ClientError):
            parse_recent_streams_limit("21")
        assert parse_recent_streams_limit("20") == 20

    def test_rejects_non_integer(self):
        with pytest.raises(ClientError):
            parse_recent_streams_limit("not-a-number")


class TestParseOffset:
    def test_absent_defaults_to_zero(self):
        assert parse_offset(None) == 0
        assert parse_offset("") == 0

    def test_valid_value_is_parsed(self):
        assert parse_offset("8") == 8

    def test_rejects_negative(self):
        with pytest.raises(ClientError):
            parse_offset("-1")

    def test_rejects_non_integer(self):
        with pytest.raises(ClientError):
            parse_offset("not-a-number")
