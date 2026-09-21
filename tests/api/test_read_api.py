from concurrent.futures import ThreadPoolExecutor
from datetime import date

import pytest

from api import read_api
from tracking.creator_master import Creator
from api.read_api import (
    ClientError,
    RankingNotReadyError,
    VideoNotFoundError,
    _compute_growth_results,
    _load_videos_for_creators,
    _trending_response,
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
from stores.snapshot_store import Snapshot
from analytics.trending import rank_videos
from tracking.video_master import Video


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


def test_get_creator_trending_uses_cache_when_limit_is_absent(monkeypatch):
    """V5.9: an unbounded request (no limit) now DOES use an existing canonical cache
    entry — this is the exact bug that caused sakura_miko's real cache to be skipped
    and vspo_official's live fallback to time out (V5.7/V5.8)."""

    def _boom(*args, **kwargs):
        raise AssertionError("a cache hit must never touch live catalog/snapshot storage")

    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(read_api, "get_videos_by_creator", _boom)
    monkeypatch.setattr(read_api, "get_snapshot", _boom)
    cached_payload = {"results": [{"rank": 1, "videoId": "v1"}, {"rank": 2, "videoId": "v2"}]}
    monkeypatch.setattr(read_api, "get_cached_trending", lambda cache_key: cached_payload)

    response = get_creator_trending(
        {"creatorId": "aizawa_ema", "reportDate": "2026-09-01", "timeZone": "Asia/Tokyo", "period": "1d"}
    )

    assert [entry["videoId"] for entry in response["results"]] == ["v1", "v2"]


def test_get_creator_trending_omitted_limit_returns_up_to_max_limit_cached_rows(monkeypatch):
    """An omitted limit is bounded by MAX_LIMIT — the same cap the writer itself already
    enforces — never unbounded, and never more than the canonical cache could ever hold."""
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    oversized_payload = {
        "results": [{"rank": i, "videoId": f"v{i}", "lastUpdatedAt": None} for i in range(1, read_api.MAX_LIMIT + 51)]
    }
    monkeypatch.setattr(read_api, "get_cached_trending", lambda cache_key: oversized_payload)

    response = get_creator_trending(
        {"creatorId": "aizawa_ema", "reportDate": "2026-09-01", "timeZone": "Asia/Tokyo", "period": "1d"}
    )

    assert len(response["results"]) == read_api.MAX_LIMIT


def test_get_creator_trending_treats_non_canonical_time_zone_as_ranking_not_ready(monkeypatch):
    """The cache only ever exists for CANONICAL_CACHE_TIME_ZONE (Asia/Tokyo) — a request in
    any other zone can never be satisfied by it. V5.9 removed the live-fallback recomputation
    that previously served this case, so it now behaves exactly like any other genuine miss:
    RankingNotReadyError (503, RANKING_NOT_READY), not a new error shape and not silent
    recomputation in the caller's own requested zone."""

    def _boom(*args, **kwargs):
        raise AssertionError("a non-canonical timeZone must never reach live catalog/snapshot storage")

    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(read_api, "get_videos_by_creator", _boom)
    monkeypatch.setattr(read_api, "get_snapshot", _boom)
    monkeypatch.setattr(read_api, "get_cached_trending", lambda cache_key: {"results": [{"rank": 1, "videoId": "v1"}]})

    with pytest.raises(RankingNotReadyError):
        get_creator_trending(
            {"creatorId": "aizawa_ema", "reportDate": "2026-09-01", "timeZone": "UTC", "period": "1d", "limit": "5"}
        )


def test_get_creator_trending_raises_ranking_not_ready_on_genuine_cache_miss(monkeypatch):
    """V5.9: a genuine cache miss (an existing, valid creator with no cached ranking yet)
    raises RankingNotReadyError — never a live recomputation, regardless of catalog size."""

    def _boom(*args, **kwargs):
        raise AssertionError("a cache miss must never fall through to live catalog/snapshot storage")

    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(read_api, "get_videos_by_creator", _boom)
    monkeypatch.setattr(read_api, "get_snapshot", _boom)
    monkeypatch.setattr(read_api, "_compute_growth_results", _boom)
    monkeypatch.setattr(read_api, "ThreadPoolExecutor", _boom)
    monkeypatch.setattr(read_api, "get_cached_trending", lambda cache_key: None)

    with pytest.raises(RankingNotReadyError):
        get_creator_trending(
            {"creatorId": "aizawa_ema", "reportDate": "2026-09-01", "timeZone": "Asia/Tokyo", "period": "1d", "limit": "5"}
        )


def test_get_organization_trending_serves_a_cache_hit_without_touching_live_storage(monkeypatch):
    """Organization scope mirrors the creator-scope cache-hit contract exactly."""

    def _boom(*args, **kwargs):
        raise AssertionError("a cache hit must never touch live catalog/snapshot storage")

    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator(organization="vspo")])
    monkeypatch.setattr(read_api, "get_videos_by_creator", _boom)
    monkeypatch.setattr(read_api, "get_snapshot", _boom)
    cached_payload = {"organization": "vspo", "results": [{"rank": 1, "videoId": "v1"}]}
    monkeypatch.setattr(read_api, "get_cached_trending", lambda cache_key: cached_payload)

    response = get_organization_trending(
        {"organization": "vspo", "reportDate": "2026-09-01", "timeZone": "Asia/Tokyo", "period": "1d"}
    )

    assert response["results"] == [{"rank": 1, "videoId": "v1"}]


def test_get_organization_trending_raises_ranking_not_ready_on_genuine_cache_miss(monkeypatch):
    """Same cache-only contract as the creator-scoped endpoint: a genuine miss raises
    RankingNotReadyError — never a live recomputation across the organization's
    combined catalog, no matter how many creators/videos it has."""

    def _boom(*args, **kwargs):
        raise AssertionError("a cache miss must never fall through to live catalog/snapshot storage")

    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator(organization="vspo")])
    monkeypatch.setattr(read_api, "get_videos_by_creator", _boom)
    monkeypatch.setattr(read_api, "get_snapshot", _boom)
    monkeypatch.setattr(read_api, "_compute_growth_results", _boom)
    monkeypatch.setattr(read_api, "ThreadPoolExecutor", _boom)
    monkeypatch.setattr(read_api, "get_cached_trending", lambda cache_key: None)

    with pytest.raises(RankingNotReadyError):
        get_organization_trending(
            {"organization": "vspo", "reportDate": "2026-09-01", "timeZone": "Asia/Tokyo", "period": "1d"}
        )


def test_get_creator_trending_behavior_is_identical_regardless_of_catalog_size(monkeypatch):
    """V5.9's whole point: HTTP request cost/behavior must never depend on catalog size.
    get_videos_by_creator is never even called — not for a 172-video creator, not for a
    2204-video creator (the exact real sakura_miko/vspo_official shapes from V5.7), not for
    a hypothetical 10,000-video one — on either the cache-hit or cache-miss path."""

    def _boom(*args, **kwargs):
        raise AssertionError("catalog size must never be queried by the HTTP trending path")

    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(read_api, "get_videos_by_creator", _boom)
    monkeypatch.setattr(read_api, "get_snapshot", _boom)

    for catalog_size, cached in [(172, None), (2204, None), (10_000, {"results": [{"rank": 1, "videoId": "v1"}]})]:
        monkeypatch.setattr(read_api, "get_cached_trending", lambda cache_key, _c=cached: _c)
        if cached is None:
            with pytest.raises(RankingNotReadyError):
                get_creator_trending(
                    {"creatorId": "aizawa_ema", "reportDate": "2026-09-01", "timeZone": "Asia/Tokyo", "period": "1d"}
                )
        else:
            response = get_creator_trending(
                {"creatorId": "aizawa_ema", "reportDate": "2026-09-01", "timeZone": "Asia/Tokyo", "period": "1d"}
            )
            assert response["results"] == cached["results"]


# --- ranking computation (V5.9: rehomed from the HTTP live path) -----------
#
# get_creator_trending/get_organization_trending are cache-only now — this
# exact _compute_growth_results -> rank_videos -> _trending_response pipeline
# only runs in trending_precompute.py's scheduled job. These tests moved from
# exercising it through the (now-removed) HTTP live-fallback branch to calling
# it directly, so ranking-correctness coverage (order, growth values,
# timestamp aggregation, legacy-video inclusion, full-catalog consideration)
# is preserved rather than lost when the HTTP fallback was removed.


def _ranking_fixture(monkeypatch, *, creators, snapshots, videos=()):
    """Wire load_creators/get_video/get_snapshot for a ranking-computation test.

    Unlike the old _trending_fixture, this never wires get_videos_by_creator:
    _compute_growth_results takes its candidate video list as a plain
    argument, exactly as trending_precompute.py already calls it. `videos` is
    only needed here to serve get_video's own by-id lookup (used by
    _ranked_entry_to_dict's title/creatorId enrichment); pass the same list
    given to _compute_ranked_response. `snapshots` maps
    (video_id, snapshot_date_iso) -> Snapshot.
    """
    videos_by_id = {video.video_id: video for video in videos}
    monkeypatch.setattr(read_api, "load_creators", lambda: creators)
    monkeypatch.setattr(read_api, "get_video", lambda video_id: videos_by_id.get(video_id))
    monkeypatch.setattr(
        read_api,
        "get_snapshot",
        lambda video_id, snapshot_date: snapshots.get((video_id, snapshot_date.isoformat())),
    )


def _compute_ranked_response(videos, *, report_date, period, ranking_type, scope, limit=None):
    """The same three-step pipeline trending_precompute._cache_one runs in
    production for every scope/period/rankingType, once a day."""
    growth_results = _compute_growth_results(videos, report_date=report_date, period=period)
    ranked = rank_videos(growth_results, ranking_type, limit=limit or read_api.MAX_LIMIT)
    return _trending_response(
        ranked, scope=scope, report_date=report_date, period=period, ranking_type=ranking_type, time_zone="UTC"
    )


def test_ranking_computation_returns_ranked_response(monkeypatch):
    """Two videos for one creator are ranked by growth, most-grown first, and
    each result row carries classification fields joined from Creator Master."""
    videos = [
        _video(video_id="v1", creator_id="aizawa_ema"),
        _video(video_id="v2", creator_id="aizawa_ema", title="Video Two"),
    ]
    _ranking_fixture(
        monkeypatch,
        creators=[_creator()],
        videos=videos,
        snapshots={
            ("v1", "2026-09-01"): _snapshot("2026-09-01", 1240, video_id="v1"),
            ("v1", "2026-08-25"): _snapshot("2026-08-25", 1000, video_id="v1"),
            ("v2", "2026-09-01"): _snapshot("2026-09-01", 500, video_id="v2"),
            ("v2", "2026-08-25"): _snapshot("2026-08-25", 100, video_id="v2"),
        },
    )

    response = _compute_ranked_response(
        videos, report_date=date(2026, 9, 1), period="7d", ranking_type="7d_trending", scope={"creatorId": "aizawa_ema"}
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


def test_ranking_computation_reports_the_oldest_result_as_last_updated_at(monkeypatch):
    """The trending list's own lastUpdatedAt is the oldest among its results
    (Roadmap 4.1's normalized contract), not the freshest — a list is only
    as current as its stalest entry. Both videos share the same report_date
    (both status "ok", so both are ranked), but v2's point was actually
    observed earlier in that day's collection run than v1's."""
    videos = [
        _video(video_id="v1", creator_id="aizawa_ema"),
        _video(video_id="v2", creator_id="aizawa_ema", title="Video Two"),
    ]
    _ranking_fixture(
        monkeypatch,
        creators=[_creator()],
        videos=videos,
        snapshots={
            ("v1", "2026-09-01"): _snapshot("2026-09-01", 1240, video_id="v1"),
            ("v1", "2026-08-25"): _snapshot("2026-08-25", 1000, video_id="v1"),
            ("v2", "2026-09-01"): _snapshot(
                "2026-09-01", 500, video_id="v2", observed_at="2026-09-01T10:00:00+09:00"
            ),
            ("v2", "2026-08-25"): _snapshot("2026-08-25", 100, video_id="v2"),
        },
    )

    response = _compute_ranked_response(
        videos, report_date=date(2026, 9, 1), period="7d", ranking_type="7d_trending", scope={"creatorId": "aizawa_ema"}
    )

    assert {entry["videoId"] for entry in response["results"]} == {"v1", "v2"}
    assert response["lastUpdatedAt"] == "2026-09-01T10:00:00+09:00"


def test_ranking_computation_compares_last_updated_at_by_instant_not_string(monkeypatch):
    """Two offset-bearing ISO 8601 timestamps don't sort the same
    lexicographically as they do chronologically: "2026-09-01T10:00:00+09:00"
    (01:00 UTC) is the earlier instant, but "2026-09-01T01:30:00+00:00"
    (01:30 UTC) sorts first as a raw string. The aggregate must pick the
    former, and must return its original string, not a reformatted one."""
    videos = [
        _video(video_id="v1", creator_id="aizawa_ema"),
        _video(video_id="v2", creator_id="aizawa_ema", title="Video Two"),
    ]
    _ranking_fixture(
        monkeypatch,
        creators=[_creator()],
        videos=videos,
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

    response = _compute_ranked_response(
        videos, report_date=date(2026, 9, 1), period="7d", ranking_type="7d_trending", scope={"creatorId": "aizawa_ema"}
    )

    assert response["lastUpdatedAt"] == "2026-09-01T10:00:00+09:00"


def test_ranking_computation_reports_no_last_updated_at_when_there_are_no_results(monkeypatch):
    _ranking_fixture(monkeypatch, creators=[_creator()], snapshots={})

    response = _compute_ranked_response(
        [], report_date=date(2026, 9, 1), period="7d", ranking_type="7d_trending", scope={"creatorId": "aizawa_ema"}
    )

    assert response["results"] == []
    assert response["lastUpdatedAt"] is None


def test_ranking_computation_respects_limit(monkeypatch):
    videos = [
        _video(video_id="v1", creator_id="aizawa_ema"),
        _video(video_id="v2", creator_id="aizawa_ema"),
    ]
    _ranking_fixture(
        monkeypatch,
        creators=[_creator()],
        videos=videos,
        snapshots={
            ("v1", "2026-09-01"): _snapshot("2026-09-01", 1240, video_id="v1"),
            ("v1", "2026-08-31"): _snapshot("2026-08-31", 1000, video_id="v1"),
            ("v2", "2026-09-01"): _snapshot("2026-09-01", 500, video_id="v2"),
            ("v2", "2026-08-31"): _snapshot("2026-08-31", 100, video_id="v2"),
        },
    )

    response = _compute_ranked_response(
        videos,
        report_date=date(2026, 9, 1),
        period="1d",
        ranking_type="daily_trending",
        scope={"creatorId": "aizawa_ema"},
        limit=1,
    )

    assert len(response["results"]) == 1
    assert response["results"][0]["videoId"] == "v2"


def test_ranking_computation_includes_legacy_cold_videos(monkeypatch):
    """Legacy activity state no longer excludes a tracked video from ranking."""
    videos = [
        _video(video_id="v1", creator_id="aizawa_ema", activity_state="Warm"),
        _video(video_id="v_cold", creator_id="aizawa_ema", activity_state="Cold"),
    ]
    _ranking_fixture(
        monkeypatch,
        creators=[_creator()],
        videos=videos,
        snapshots={
            ("v1", "2026-09-01"): _snapshot("2026-09-01", 110, video_id="v1"),
            ("v1", "2026-08-31"): _snapshot("2026-08-31", 100, video_id="v1"),
            ("v_cold", "2026-09-01"): _snapshot("2026-09-01", 999999, video_id="v_cold"),
            ("v_cold", "2026-08-31"): _snapshot("2026-08-31", 1, video_id="v_cold"),
        },
    )

    response = _compute_ranked_response(
        videos, report_date=date(2026, 9, 1), period="1d", ranking_type="daily_trending", scope={"creatorId": "aizawa_ema"}
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


def test_ranking_computation_considers_every_tracked_video(monkeypatch):
    """_compute_growth_results (still trending_precompute.py's own computation
    engine) must fetch snapshots for every supplied candidate, not silently
    drop any — exact ranking cannot discard a video before its real gain is
    known. Rehomed from the HTTP live path; see this section's own header."""
    videos = [
        _video(video_id=f"v{i}", creator_id="aizawa_ema", activity_state="Warm", last_checked_at="2026-09-01T00:00:00Z")
        for i in range(550)
    ]
    fetch_calls = []

    def _counting_get_snapshot(video_id, snapshot_date):
        fetch_calls.append(video_id)
        return None

    monkeypatch.setattr(read_api, "get_snapshot", _counting_get_snapshot)

    results = _compute_growth_results(videos, report_date=date(2026, 9, 1), period="1d")

    assert len(results) == 550
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
    alone a YobiTrendingCache lookup."""

    def _boom(*args, **kwargs):
        raise AssertionError(f"storage should not be touched for an invalid request: {bad_overrides}")

    monkeypatch.setattr(read_api, "load_creators", _boom)
    monkeypatch.setattr(read_api, "get_videos_by_creator", _boom)
    monkeypatch.setattr(read_api, "get_snapshot", _boom)

    query = {"creatorId": "aizawa_ema", "reportDate": "2026-09-01", "timeZone": "UTC", "period": "1d", **bad_overrides}

    with pytest.raises(ClientError):
        get_creator_trending(query)


# --- get_organization_trending ----------------------------------------------
#
# V5.9 removed get_organization_trending's own cross-org leak-prevention test
# from this file: that behavior (a video from a different organization's
# creator never leaking into another org's cached entry) lived in the now-
# removed live-fallback branch. It's still real production behavior, just
# owned entirely by the writer now — see
# tests/test_trending_precompute.py::test_run_caches_an_organizations_trending_scoped_to_its_own_creators,
# which already covers it at the layer where the org's creator set is
# actually assembled.


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
