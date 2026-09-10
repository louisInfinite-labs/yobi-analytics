from concurrent.futures import ThreadPoolExecutor
from datetime import date

import pytest

import read_api
from creator_master import Creator
from read_api import (
    ClientError,
    VideoNotFoundError,
    _compute_growth_results,
    _load_videos_for_creators,
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
        "creatorId": "aizawa_ema",
        "channelName": "藍沢エマ",
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


def test_get_video_growth_reports_not_available_for_dates_before_the_videos_own_onboarding(monkeypatch):
    """A video discovered after COLLECTION_START_DATE must not be reported
    `pending` for dates before its own onboarding — those snapshots can
    never arrive, since the collector didn't know about the video yet."""
    monkeypatch.setattr(
        read_api, "get_video", lambda video_id: _video(video_id=video_id, discovered_at="2026-09-01T00:00:00Z")
    )
    monkeypatch.setattr(read_api, "get_snapshot", lambda video_id, snapshot_date: None)
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])

    response = get_video_growth({"videoId": "v1", "reportDate": "2026-08-30", "timeZone": "UTC", "period": "1d"})

    assert response["status"] == "not_available"


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


def test_parse_limit_accepts_the_max_limit_exactly():
    assert parse_limit(read_api.MAX_LIMIT) == read_api.MAX_LIMIT


def test_parse_limit_rejects_a_value_above_max_limit():
    with pytest.raises(ClientError):
        parse_limit(read_api.MAX_LIMIT + 1)


# --- trending cache ----------------------------------------------------


def test_trending_cache_key_is_stable_and_dimension_sensitive():
    """Two requests that differ in any one dimension must never collide on the same cache key."""
    base = dict(scope_type="creator", scope_value="c1", period="1d", ranking_type="daily_trending", report_date=date(2026, 9, 1))
    key = read_api.trending_cache_key(**base)

    assert key == read_api.trending_cache_key(**base)
    assert key != read_api.trending_cache_key(**{**base, "scope_value": "c2"})
    assert key != read_api.trending_cache_key(**{**base, "period": "7d"})
    assert key != read_api.trending_cache_key(**{**base, "ranking_type": "fastest_growing"})
    assert key != read_api.trending_cache_key(**{**base, "report_date": date(2026, 9, 2)})


def test_get_creator_trending_serves_a_cache_hit_without_touching_live_storage(monkeypatch):
    """A cache hit must short-circuit before get_videos_by_creator/get_snapshot are ever called."""

    def _boom(*args, **kwargs):
        raise AssertionError("live storage should not be touched on a cache hit")

    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(read_api, "get_videos_by_creator", _boom)
    monkeypatch.setattr(read_api, "get_snapshot", _boom)
    cached_payload = {"organization": None, "results": [{"rank": 1, "videoId": "v1"}, {"rank": 2, "videoId": "v2"}]}
    monkeypatch.setattr(read_api, "get_cached_trending", lambda cache_key: cached_payload)

    response = get_creator_trending(
        {"creatorId": "aizawa_ema", "reportDate": "2026-09-01", "timeZone": "Asia/Tokyo", "period": "1d", "limit": "1"}
    )

    assert response["results"] == [{"rank": 1, "videoId": "v1"}]


def test_get_creator_trending_recomputes_last_updated_at_after_cache_truncation(monkeypatch):
    """A cache hit's top-level lastUpdatedAt must reflect only the rows actually
    returned after truncating to `limit`, not the oldest row across the full
    cached (up to MAX_LIMIT) set — otherwise a cache hit and a live computation
    of the same request could report different freshness for the same data."""
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    cached_payload = {
        "creatorId": "aizawa_ema",
        "reportDate": "2026-09-01",
        "comparisonDate": "2026-08-31",
        "period": "1d",
        "rankingType": "daily_trending",
        "timeZone": "Asia/Tokyo",
        "lastUpdatedAt": "2026-08-01T00:00:00+00:00",  # the oldest row's timestamp, from a row NOT kept below
        "results": [
            {"rank": 1, "videoId": "v1", "lastUpdatedAt": "2026-09-01T00:00:00+00:00"},
            {"rank": 2, "videoId": "v2", "lastUpdatedAt": "2026-08-01T00:00:00+00:00"},
        ],
    }
    monkeypatch.setattr(read_api, "get_cached_trending", lambda cache_key: cached_payload)

    response = get_creator_trending(
        {"creatorId": "aizawa_ema", "reportDate": "2026-09-01", "timeZone": "Asia/Tokyo", "period": "1d", "limit": "1"}
    )

    assert [entry["videoId"] for entry in response["results"]] == ["v1"]
    assert response["lastUpdatedAt"] == "2026-09-01T00:00:00+00:00"
    # Every other top-level field from the cached payload must pass through
    # unchanged — only `results` and `lastUpdatedAt` are meant to be touched.
    assert response["creatorId"] == "aizawa_ema"
    assert response["reportDate"] == "2026-09-01"
    assert response["comparisonDate"] == "2026-08-31"
    assert response["period"] == "1d"
    assert response["rankingType"] == "daily_trending"
    assert response["timeZone"] == "Asia/Tokyo"


def test_get_creator_trending_caps_a_cache_hit_at_max_limit_even_if_the_cached_payload_holds_more(monkeypatch):
    """A cache hit must never return more than the caller's own (already-capped-at-MAX_LIMIT)
    `limit` rows, even if the stored payload itself somehow holds more than MAX_LIMIT —
    e.g. a future precompute bug, or a manually-edited cache row. `parse_limit` already
    forbids a caller from asking for more than MAX_LIMIT, so requesting exactly MAX_LIMIT
    against an oversized payload is the strictest real case to prove this against."""
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    oversized_payload = {
        "results": [{"rank": i, "videoId": f"v{i}", "lastUpdatedAt": None} for i in range(1, read_api.MAX_LIMIT + 51)]
    }
    monkeypatch.setattr(read_api, "get_cached_trending", lambda cache_key: oversized_payload)

    response = get_creator_trending(
        {
            "creatorId": "aizawa_ema",
            "reportDate": "2026-09-01",
            "timeZone": "Asia/Tokyo",
            "period": "1d",
            "limit": str(read_api.MAX_LIMIT),
        }
    )

    assert len(response["results"]) == read_api.MAX_LIMIT


def test_get_creator_trending_ignores_cache_when_limit_is_absent(monkeypatch):
    """An unbounded request (no limit) never serves a cache entry that only ever holds MAX_LIMIT rows."""
    _trending_fixture(
        monkeypatch,
        creators=[_creator()],
        videos=[_video(video_id="v1", creator_id="aizawa_ema")],
        snapshots={
            ("v1", "2026-09-01"): _snapshot("2026-09-01", 110, video_id="v1"),
            ("v1", "2026-08-31"): _snapshot("2026-08-31", 100, video_id="v1"),
        },
    )
    monkeypatch.setattr(read_api, "get_cached_trending", lambda cache_key: {"results": []})

    response = get_creator_trending(
        {"creatorId": "aizawa_ema", "reportDate": "2026-09-01", "timeZone": "Asia/Tokyo", "period": "1d"}
    )

    assert [entry["videoId"] for entry in response["results"]] == ["v1"]


def test_get_creator_trending_ignores_cache_for_a_non_canonical_time_zone(monkeypatch):
    """A request outside the precompute job's own time zone always computes live."""
    _trending_fixture(
        monkeypatch,
        creators=[_creator()],
        videos=[_video(video_id="v1", creator_id="aizawa_ema")],
        snapshots={
            ("v1", "2026-09-01"): _snapshot("2026-09-01", 110, video_id="v1"),
            ("v1", "2026-08-31"): _snapshot("2026-08-31", 100, video_id="v1"),
        },
    )
    monkeypatch.setattr(read_api, "get_cached_trending", lambda cache_key: {"results": []})

    response = get_creator_trending(
        {"creatorId": "aizawa_ema", "reportDate": "2026-09-01", "timeZone": "UTC", "period": "1d", "limit": "5"}
    )

    assert [entry["videoId"] for entry in response["results"]] == ["v1"]


def test_get_creator_trending_falls_back_to_live_computation_on_cache_miss(monkeypatch):
    """A cache miss (None) still returns a correct live-computed response."""
    _trending_fixture(
        monkeypatch,
        creators=[_creator()],
        videos=[_video(video_id="v1", creator_id="aizawa_ema")],
        snapshots={
            ("v1", "2026-09-01"): _snapshot("2026-09-01", 110, video_id="v1"),
            ("v1", "2026-08-31"): _snapshot("2026-08-31", 100, video_id="v1"),
        },
    )
    monkeypatch.setattr(read_api, "get_cached_trending", lambda cache_key: None)

    response = get_creator_trending(
        {"creatorId": "aizawa_ema", "reportDate": "2026-09-01", "timeZone": "Asia/Tokyo", "period": "1d", "limit": "5"}
    )

    assert [entry["videoId"] for entry in response["results"]] == ["v1"]


def test_get_creator_trending_refuses_an_oversized_cache_miss_instead_of_computing_it_live(monkeypatch):
    """A cache miss for a scope beyond MAX_LIVE_FALLBACK_VIDEOS must be refused (503-worthy),
    not computed live — an attacker forcing a miss (e.g. a non-canonical timeZone) against a
    huge scope must not be able to fan out into thousands of snapshot reads per request."""

    def _boom(*args, **kwargs):
        raise AssertionError("an oversized scope must be refused before touching snapshot storage")

    videos = [_video(video_id=f"v{i}", creator_id="aizawa_ema") for i in range(read_api.MAX_LIVE_FALLBACK_VIDEOS + 1)]
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(read_api, "get_videos_by_creator", lambda creator_id: videos)
    monkeypatch.setattr(read_api, "get_cached_trending", lambda cache_key: None)
    monkeypatch.setattr(read_api, "get_snapshot", _boom)

    with pytest.raises(read_api.TrendingNotReadyError):
        get_creator_trending(
            {"creatorId": "aizawa_ema", "reportDate": "2026-09-01", "timeZone": "Asia/Tokyo", "period": "1d", "limit": "5"}
        )


def test_get_creator_trending_refuses_an_oversized_cache_miss_even_with_limit_1(monkeypatch):
    """The guardrail must trip on the scope's own catalog size alone — a caller cannot dodge it
    by asking for a tiny `limit`, since the expensive part is computing growth for every
    candidate video, not the size of the final ranked response."""

    def _boom(*args, **kwargs):
        raise AssertionError("an oversized scope must be refused regardless of the requested limit")

    videos = [_video(video_id=f"v{i}", creator_id="aizawa_ema") for i in range(read_api.MAX_LIVE_FALLBACK_VIDEOS + 1)]
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(read_api, "get_videos_by_creator", lambda creator_id: videos)
    monkeypatch.setattr(read_api, "get_cached_trending", lambda cache_key: None)
    monkeypatch.setattr(read_api, "get_snapshot", _boom)

    with pytest.raises(read_api.TrendingNotReadyError):
        get_creator_trending(
            {"creatorId": "aizawa_ema", "reportDate": "2026-09-01", "timeZone": "Asia/Tokyo", "period": "1d", "limit": "1"}
        )


def test_get_creator_trending_still_computes_live_at_exactly_the_fallback_limit(monkeypatch):
    """The boundary itself must still be servable live — only strictly over the limit is refused."""
    videos = [_video(video_id=f"v{i}", creator_id="aizawa_ema") for i in range(read_api.MAX_LIVE_FALLBACK_VIDEOS)]
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(read_api, "get_videos_by_creator", lambda creator_id: videos)
    monkeypatch.setattr(read_api, "get_cached_trending", lambda cache_key: None)
    monkeypatch.setattr(read_api, "get_snapshot", lambda video_id, snapshot_date: None)

    response = get_creator_trending(
        {"creatorId": "aizawa_ema", "reportDate": "2026-09-01", "timeZone": "Asia/Tokyo", "period": "1d", "limit": "5"}
    )

    assert response["creatorId"] == "aizawa_ema"


def test_get_organization_trending_refuses_an_oversized_cache_miss_instead_of_computing_it_live(monkeypatch):
    """Same guardrail for the organization scope, where per-request amplification is worst:
    many creators' catalogs are combined before ranking (see _load_videos_for_creators)."""

    def _boom(*args, **kwargs):
        raise AssertionError("an oversized scope must be refused before touching snapshot storage")

    huge_catalog = {
        "c1": [_video(video_id=f"c1_v{i}", creator_id="c1") for i in range(read_api.MAX_LIVE_FALLBACK_VIDEOS)],
        "c2": [_video(video_id=f"c2_v{i}", creator_id="c2") for i in range(2)],
    }
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator(creator_id="c1"), _creator(creator_id="c2")])
    monkeypatch.setattr(read_api, "get_videos_by_creator", lambda creator_id: huge_catalog[creator_id])
    monkeypatch.setattr(read_api, "get_cached_trending", lambda cache_key: None)
    monkeypatch.setattr(read_api, "get_snapshot", _boom)

    with pytest.raises(read_api.TrendingNotReadyError):
        get_organization_trending(
            {"organization": "vspo", "reportDate": "2026-09-01", "timeZone": "Asia/Tokyo", "period": "1d", "limit": "5"}
        )


# --- _reject_oversized_live_fallback ----------------------------------------


def test_reject_oversized_live_fallback_error_does_not_leak_the_video_count():
    """The 503 an unauthenticated caller receives must not reveal how large the real
    catalog behind a scope is — that's server-side operational detail, not public
    response data, even when the server is refusing the request."""
    videos = [_video(video_id=f"v{i}") for i in range(read_api.MAX_LIVE_FALLBACK_VIDEOS + 1)]

    with pytest.raises(read_api.TrendingNotReadyError) as exc_info:
        read_api._reject_oversized_live_fallback(videos, scope={"creatorId": "aizawa_ema"})

    message = str(exc_info.value)
    assert str(len(videos)) not in message
    assert "aizawa_ema" in message  # echoing the caller's own requested scope back is fine


def test_reject_oversized_live_fallback_threshold_is_a_tunable_module_constant(monkeypatch):
    """MAX_LIVE_FALLBACK_VIDEOS must be read fresh at call time (not baked into a closure),
    so it can be overridden per-deployment via YOBI_MAX_TRENDING_LIVE_FALLBACK_VIDEOS
    without a code change."""
    monkeypatch.setattr(read_api, "MAX_LIVE_FALLBACK_VIDEOS", 3)

    read_api._reject_oversized_live_fallback([_video(video_id=f"v{i}") for i in range(3)], scope={})

    with pytest.raises(read_api.TrendingNotReadyError):
        read_api._reject_oversized_live_fallback([_video(video_id=f"v{i}") for i in range(4)], scope={})


# --- _bounded_live_limit -----------------------------------------------------


def test_bounded_live_limit_passes_through_a_given_limit_unchanged():
    assert read_api._bounded_live_limit(5) == 5


def test_bounded_live_limit_defaults_an_absent_limit_to_max_limit():
    assert read_api._bounded_live_limit(None) == read_api.MAX_LIMIT


def test_get_creator_trending_live_fallback_caps_an_absent_limit_at_max_limit(monkeypatch):
    """_bounded_live_limit must only change what the *live* path ranks down to — an
    omitted `limit` must still return at most MAX_LIMIT rows once it falls through to
    _compute_growth_results/rank_videos, not the unbounded "every rankable result"
    rank_videos itself would default to."""
    video_count = read_api.MAX_LIMIT + 50
    assert video_count <= read_api.MAX_LIVE_FALLBACK_VIDEOS  # must stay under the other guardrail to reach ranking at all
    videos = [_video(video_id=f"v{i}", creator_id="aizawa_ema") for i in range(video_count)]
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(read_api, "get_videos_by_creator", lambda creator_id: videos)
    monkeypatch.setattr(read_api, "get_cached_trending", lambda cache_key: None)
    monkeypatch.setattr(
        read_api,
        "get_snapshot",
        lambda video_id, snapshot_date: _snapshot(snapshot_date.isoformat(), 100, video_id=video_id),
    )

    response = get_creator_trending(
        {"creatorId": "aizawa_ema", "reportDate": "2026-09-01", "timeZone": "Asia/Tokyo", "period": "1d"}
    )

    assert len(response["results"]) == read_api.MAX_LIMIT


def test_bounded_live_limit_is_never_applied_on_the_cache_hit_path(monkeypatch):
    """_cached_trending must keep truncating to the caller's own raw `limit` — it must
    never see _bounded_live_limit's substitute value, since an omitted limit (None) is
    itself one of _cached_trending's own signals to never serve a cache hit at all
    (see its docstring). Sets a cached payload larger than a 5-row limit but smaller
    than MAX_LIMIT, so a MAX_LIMIT-substitution bug (instead of the caller's real
    limit=5) would be caught by returning too many rows."""
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    cached_payload = {"results": [{"rank": i, "videoId": f"v{i}", "lastUpdatedAt": None} for i in range(1, 21)]}
    monkeypatch.setattr(read_api, "get_cached_trending", lambda cache_key: cached_payload)

    response = get_creator_trending(
        {"creatorId": "aizawa_ema", "reportDate": "2026-09-01", "timeZone": "Asia/Tokyo", "period": "1d", "limit": "5"}
    )

    assert len(response["results"]) == 5


# --- get_creator_trending --------------------------------------------------


def _trending_fixture(monkeypatch, *, creators, videos, snapshots):
    """Wire load_creators/get_videos_by_creator/get_video/get_snapshot for a trending test.

    `snapshots` maps (video_id, snapshot_date_iso) -> Snapshot.
    """
    videos_by_id = {video.video_id: video for video in videos}
    monkeypatch.setattr(read_api, "load_creators", lambda: creators)
    monkeypatch.setattr(
        read_api, "get_videos_by_creator", lambda creator_id: [v for v in videos if v.creator_id == creator_id]
    )
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
        "creatorId": "aizawa_ema",
        "channelName": "藍沢エマ",
        "organization": "vspo",
        "branch": "vspo_jp",
        "groupKey": ["1期生"],
        "channelType": "member",
        "lifecycleStage": "active",
        "latestViewCount": 500,
        "lastUpdatedAt": "2026-09-01T18:00:05+09:00",
        "growth": 400,
        "growthPercent": pytest.approx(400.0),
        "status": "ok",
    }
    assert response["results"][1]["rank"] == 2


def test_get_creator_trending_reports_the_oldest_result_as_last_updated_at(monkeypatch):
    """The trending list's own lastUpdatedAt is the oldest among its results
    (Roadmap 4.1's normalized contract), not the freshest — a list is only
    as current as its stalest entry. Both videos share the same report_date
    (both status "ok", so both are ranked), but v2's point was actually
    observed earlier in that day's collection run than v1's."""
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
            ("v2", "2026-09-01"): _snapshot(
                "2026-09-01", 500, video_id="v2", observed_at="2026-09-01T10:00:00+09:00"
            ),
            ("v2", "2026-08-25"): _snapshot("2026-08-25", 100, video_id="v2"),
        },
    )

    response = get_creator_trending(
        {"creatorId": "aizawa_ema", "reportDate": "2026-09-01", "timeZone": "UTC", "period": "7d"}
    )

    assert {entry["videoId"] for entry in response["results"]} == {"v1", "v2"}
    assert response["lastUpdatedAt"] == "2026-09-01T10:00:00+09:00"


def test_get_creator_trending_compares_last_updated_at_by_instant_not_string(monkeypatch):
    """Two offset-bearing ISO 8601 timestamps don't sort the same
    lexicographically as they do chronologically: "2026-09-01T10:00:00+09:00"
    (01:00 UTC) is the earlier instant, but "2026-09-01T01:30:00+00:00"
    (01:30 UTC) sorts first as a raw string. The aggregate must pick the
    former, and must return its original string, not a reformatted one."""
    _trending_fixture(
        monkeypatch,
        creators=[_creator()],
        videos=[
            _video(video_id="v1", creator_id="aizawa_ema"),
            _video(video_id="v2", creator_id="aizawa_ema", title="Video Two"),
        ],
        snapshots={
            ("v1", "2026-09-01"): _snapshot(
                "2026-09-01", 1240, video_id="v1", observed_at="2026-09-01T10:00:00+09:00"
            ),
            ("v1", "2026-08-25"): _snapshot("2026-08-25", 1000, video_id="v1"),
            ("v2", "2026-09-01"): _snapshot(
                "2026-09-01", 500, video_id="v2", observed_at="2026-09-01T01:30:00+00:00"
            ),
            ("v2", "2026-08-25"): _snapshot("2026-08-25", 100, video_id="v2"),
        },
    )

    response = get_creator_trending(
        {"creatorId": "aizawa_ema", "reportDate": "2026-09-01", "timeZone": "UTC", "period": "7d"}
    )

    assert response["lastUpdatedAt"] == "2026-09-01T10:00:00+09:00"


def test_get_creator_trending_reports_no_last_updated_at_when_there_are_no_results(monkeypatch):
    _trending_fixture(monkeypatch, creators=[_creator()], videos=[], snapshots={})

    response = get_creator_trending(
        {"creatorId": "aizawa_ema", "reportDate": "2026-09-01", "timeZone": "UTC", "period": "7d"}
    )

    assert response["results"] == []
    assert response["lastUpdatedAt"] is None


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


def test_get_creator_trending_includes_legacy_cold_videos(monkeypatch):
    """Legacy activity state no longer excludes a tracked video from ranking."""
    _trending_fixture(
        monkeypatch,
        creators=[_creator()],
        videos=[
            _video(video_id="v1", creator_id="aizawa_ema", activity_state="Warm"),
            _video(video_id="v_cold", creator_id="aizawa_ema", activity_state="Cold"),
        ],
        snapshots={
            ("v1", "2026-09-01"): _snapshot("2026-09-01", 110, video_id="v1"),
            ("v1", "2026-08-31"): _snapshot("2026-08-31", 100, video_id="v1"),
            ("v_cold", "2026-09-01"): _snapshot("2026-09-01", 999999, video_id="v_cold"),
            ("v_cold", "2026-08-31"): _snapshot("2026-08-31", 1, video_id="v_cold"),
        },
    )

    response = get_creator_trending(
        {"creatorId": "aizawa_ema", "reportDate": "2026-09-01", "timeZone": "UTC", "period": "1d"}
    )

    assert [entry["videoId"] for entry in response["results"]] == ["v_cold", "v1"]


def test_load_videos_for_creators_returns_every_tracked_video(monkeypatch):
    """Exact ranking cannot discard videos before their real gain is known."""
    huge_catalog = {
        "c1": [_video(video_id=f"c1_v{i}", creator_id="c1", activity_state="Warm") for i in range(10_000)],
        "c2": [_video(video_id=f"c2_v{i}", creator_id="c2", activity_state="Warm") for i in range(10_000)],
    }
    monkeypatch.setattr(read_api, "get_videos_by_creator", lambda creator_id: huge_catalog[creator_id])

    combined = _load_videos_for_creators({"c1", "c2"})

    assert len(combined) == 20_000


def test_load_videos_for_creators_ignores_legacy_activity_state(monkeypatch):
    videos = [_video(video_id="hot", creator_id="c1", activity_state="Hot")] + [
        _video(video_id=f"cold_{i}", creator_id="c1", activity_state="Cold") for i in range(10)
    ]
    monkeypatch.setattr(read_api, "get_videos_by_creator", lambda creator_id: videos)

    combined = _load_videos_for_creators({"c1"})

    assert [video.video_id for video in combined] == ["hot", *[f"cold_{i}" for i in range(10)]]


def test_compute_growth_results_uses_a_caller_supplied_executor_when_given(monkeypatch):
    """trending_precompute.py shares one executor across hundreds of calls (2026-09-05 leak
    fix) — passing one in must skip creating (and tearing down) a fresh pool per call."""
    created_pools = []
    real_executor_cls = ThreadPoolExecutor

    class _CountingExecutor(real_executor_cls):
        def __init__(self, *args, **kwargs):
            created_pools.append(self)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(read_api, "ThreadPoolExecutor", _CountingExecutor)
    monkeypatch.setattr(read_api, "get_snapshot", lambda video_id, snapshot_date: None)
    shared_executor = real_executor_cls(max_workers=2)

    try:
        _compute_growth_results(
            [_video(video_id="v1")], report_date=date(2026, 9, 1), period="1d", executor=shared_executor
        )
        _compute_growth_results(
            [_video(video_id="v2")], report_date=date(2026, 9, 1), period="1d", executor=shared_executor
        )
    finally:
        shared_executor.shutdown()

    assert created_pools == []


def test_compute_growth_results_creates_its_own_executor_when_none_given(monkeypatch):
    """The live request path (get_creator_trending/get_organization_trending) never passes
    executor= — it must keep self-managing one call's own pool exactly as before."""
    monkeypatch.setattr(read_api, "get_snapshot", lambda video_id, snapshot_date: None)

    results = _compute_growth_results([_video(video_id="v1")], report_date=date(2026, 9, 1), period="1d")

    assert len(results) == 1


def test_get_creator_trending_considers_every_tracked_video(monkeypatch):
    videos = [
        _video(video_id=f"v{i}", creator_id="aizawa_ema", activity_state="Warm", last_checked_at="2026-09-01T00:00:00Z")
        for i in range(550)
    ]
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(read_api, "get_videos_by_creator", lambda creator_id: videos)

    fetch_calls = []

    def _counting_get_snapshot(video_id, snapshot_date):
        fetch_calls.append(video_id)
        return None

    monkeypatch.setattr(read_api, "get_snapshot", _counting_get_snapshot)

    response = get_creator_trending(
        {"creatorId": "aizawa_ema", "reportDate": "2026-09-01", "timeZone": "UTC", "period": "1d"}
    )

    assert response["creatorId"] == "aizawa_ema"
    assert len({video_id for video_id in fetch_calls}) == 550


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
    monkeypatch.setattr(read_api, "get_videos_by_creator", _boom)

    with pytest.raises(ClientError):
        get_creator_trending(
            {"creatorId": "aizawa_ema", "reportDate": "not-a-date", "timeZone": "UTC", "period": "1d"}
        )


@pytest.mark.parametrize(
    "bad_overrides",
    [
        {"timeZone": "Not/A_Real_Zone"},
        {"period": "14d"},
        {"rankingType": "not_a_real_type"},
        {"reportDate": "2026-13-40"},
        {"creatorId": "x" * (read_api.MAX_IDENTIFIER_LENGTH + 1)},
    ],
    ids=["bad_timeZone", "bad_period", "bad_rankingType", "bad_reportDate", "oversized_creatorId"],
)
def test_get_creator_trending_rejects_every_invalid_param_before_touching_storage(monkeypatch, bad_overrides):
    """No malformed query parameter — timeZone, period, rankingType, reportDate, or an
    oversized creatorId — may ever reach live storage (Creator Master or video lookup):
    an attacker probing with garbage values must never trigger a DynamoDB read, let
    alone the live-fallback ranking computation."""

    def _boom(*args, **kwargs):
        raise AssertionError(f"storage should not be touched for an invalid request: {bad_overrides}")

    monkeypatch.setattr(read_api, "load_creators", _boom)
    monkeypatch.setattr(read_api, "get_videos_by_creator", _boom)
    monkeypatch.setattr(read_api, "get_snapshot", _boom)

    query = {"creatorId": "aizawa_ema", "reportDate": "2026-09-01", "timeZone": "UTC", "period": "1d", **bad_overrides}

    with pytest.raises(ClientError):
        get_creator_trending(query)


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
    monkeypatch.setattr(read_api, "get_videos_by_creator", _boom)

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


@pytest.mark.parametrize(
    "bad_overrides",
    [
        {"timeZone": "Not/A_Real_Zone"},
        {"period": "14d"},
        {"rankingType": "not_a_real_type"},
        {"reportDate": "2026-13-40"},
        {"organization": "x" * (read_api.MAX_IDENTIFIER_LENGTH + 1)},
    ],
    ids=["bad_timeZone", "bad_period", "bad_rankingType", "bad_reportDate", "oversized_organization"],
)
def test_get_organization_trending_rejects_every_invalid_param_before_touching_storage(monkeypatch, bad_overrides):
    """Same guarantee as the creator-scoped endpoint: no malformed parameter reaches
    Creator Master or per-creator video lookups, which would otherwise be repeated
    once per creator in the organization — a much larger amplification surface."""

    def _boom(*args, **kwargs):
        raise AssertionError(f"storage should not be touched for an invalid request: {bad_overrides}")

    monkeypatch.setattr(read_api, "load_creators", _boom)
    monkeypatch.setattr(read_api, "get_videos_by_creator", _boom)
    monkeypatch.setattr(read_api, "get_snapshot", _boom)

    query = {"organization": "vspo", "reportDate": "2026-09-01", "timeZone": "UTC", "period": "1d", **bad_overrides}

    with pytest.raises(ClientError):
        get_organization_trending(query)
