"""Focused tests for the cache-only creator-summary/organization-leaderboard
Read API (Roadmap 5.x): get_creator_summary/get_organization_leaderboard.

Cache-only means exactly one YobiTrendingCache GetItem and nothing else —
no S3/history reads, no video/snapshot storage, no ranking computation. A
genuine cache miss is a 503 (RankingNotReadyError), never a recompute; an
unknown creatorId/organization is a 404 (ScopeNotFoundError), rejected
before the cache is ever touched.
"""

from datetime import date

import pytest

import read_api
import ranking_reducer
import trending_cache_keys
from creator_master import Creator
from read_api import (
    RankingNotReadyError,
    ScopeNotFoundError,
    get_creator_summary,
    get_organization_leaderboard,
)


def _creator(creator_id, organization="vspo"):
    return Creator(
        creator_id=creator_id,
        display_name=creator_id,
        organization=organization,
        youtube_channel_id="UC_test",
        active=True,
        branch="vspo_jp",
        group_key=["1期生"],
        channel_type="member",
        lifecycle_stage="active",
    )


def _boom(*args, **kwargs):
    raise AssertionError("cache-only endpoint must never touch live/history storage or ranking functions")


def _wire_no_live_fallback(monkeypatch):
    """Monkeypatch every live-compute/storage/ranking function these
    cache-only endpoints must never call, so any accidental call fails
    loudly instead of silently succeeding."""
    monkeypatch.setattr(read_api, "get_videos_by_creator", _boom)
    monkeypatch.setattr(read_api, "get_snapshot", _boom)
    monkeypatch.setattr(read_api, "get_video", _boom)
    monkeypatch.setattr(read_api, "rank_videos", _boom)
    monkeypatch.setattr(read_api, "_compute_growth_results", _boom)
    monkeypatch.setattr(read_api, "_load_videos_for_creators", _boom)


# --- 200 happy paths --------------------------------------------------------


def test_get_creator_summary_returns_200_payload_on_cache_hit(monkeypatch):
    _wire_no_live_fallback(monkeypatch)
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator("aizawa_ema")])
    cached_payload = {
        "creatorId": "aizawa_ema", "period": "7d", "reportDate": "2026-09-10",
        "viewSum": 1500, "isComplete": True,
    }
    calls = []
    monkeypatch.setattr(read_api, "get_cached_trending", lambda key: (calls.append(key), cached_payload)[1])

    result = get_creator_summary({"creatorId": "aizawa_ema", "period": "7d", "reportDate": "2026-09-10"})

    assert result == cached_payload
    assert calls == ["creatorSummary:aizawa_ema:7d:2026-09-10"]


def test_get_organization_leaderboard_returns_200_payload_on_cache_hit(monkeypatch):
    _wire_no_live_fallback(monkeypatch)
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator("aizawa_ema", organization="vspo")])
    cached_payload = {
        "organization": "vspo", "period": "7d", "reportDate": "2026-09-10",
        "byTotalViews": [], "byTopVideo": [],
    }
    calls = []
    monkeypatch.setattr(read_api, "get_cached_trending", lambda key: (calls.append(key), cached_payload)[1])

    result = get_organization_leaderboard({"organization": "vspo", "period": "7d", "reportDate": "2026-09-10"})

    assert result == cached_payload
    assert calls == ["orgLeaderboard:vspo:7d:2026-09-10"]


# --- incomplete cache is still 200, not an error ---------------------------


def test_get_creator_summary_returns_200_even_when_is_complete_is_false(monkeypatch):
    _wire_no_live_fallback(monkeypatch)
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator("aizawa_ema")])
    cached_payload = {
        "creatorId": "aizawa_ema", "period": "7d", "reportDate": "2026-09-10",
        "isComplete": False, "catalogVideoCount": 10, "eligibleVideoCount": 8,
    }
    monkeypatch.setattr(read_api, "get_cached_trending", lambda key: cached_payload)

    result = get_creator_summary({"creatorId": "aizawa_ema", "period": "7d", "reportDate": "2026-09-10"})

    assert result == cached_payload
    assert result["isComplete"] is False


def test_get_organization_leaderboard_returns_200_even_when_is_complete_is_false(monkeypatch):
    _wire_no_live_fallback(monkeypatch)
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator("aizawa_ema", organization="vspo")])
    cached_payload = {"organization": "vspo", "period": "7d", "isComplete": False, "memberCount": 2, "completeMemberCount": 1}
    monkeypatch.setattr(read_api, "get_cached_trending", lambda key: cached_payload)

    result = get_organization_leaderboard({"organization": "vspo", "period": "7d", "reportDate": "2026-09-10"})

    assert result == cached_payload


# --- cache miss -> 503, no live compute ------------------------------------


def test_get_creator_summary_cache_miss_raises_ranking_not_ready_without_live_compute(monkeypatch):
    _wire_no_live_fallback(monkeypatch)
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator("aizawa_ema")])
    monkeypatch.setattr(read_api, "get_cached_trending", lambda key: None)

    with pytest.raises(RankingNotReadyError):
        get_creator_summary({"creatorId": "aizawa_ema", "period": "7d", "reportDate": "2026-09-10"})


def test_get_organization_leaderboard_cache_miss_raises_ranking_not_ready_without_live_compute(monkeypatch):
    _wire_no_live_fallback(monkeypatch)
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator("aizawa_ema", organization="vspo")])
    monkeypatch.setattr(read_api, "get_cached_trending", lambda key: None)

    with pytest.raises(RankingNotReadyError):
        get_organization_leaderboard({"organization": "vspo", "period": "7d", "reportDate": "2026-09-10"})


# --- unknown scope -> 404, rejected before any cache read ------------------


def test_get_creator_summary_unknown_creator_id_raises_before_any_cache_read(monkeypatch):
    _wire_no_live_fallback(monkeypatch)
    monkeypatch.setattr(read_api, "load_creators", lambda: [])  # no creators at all

    def _boom_cache(key):
        raise AssertionError("must not touch the cache for an unknown creatorId")

    monkeypatch.setattr(read_api, "get_cached_trending", _boom_cache)

    with pytest.raises(ScopeNotFoundError):
        get_creator_summary({"creatorId": "no_such_creator", "period": "7d", "reportDate": "2026-09-10"})


def test_get_organization_leaderboard_unknown_organization_raises_before_any_cache_read(monkeypatch):
    _wire_no_live_fallback(monkeypatch)
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator("aizawa_ema", organization="vspo")])

    def _boom_cache(key):
        raise AssertionError("must not touch the cache for an unknown organization")

    monkeypatch.setattr(read_api, "get_cached_trending", _boom_cache)

    with pytest.raises(ScopeNotFoundError):
        get_organization_leaderboard({"organization": "no_such_org", "period": "7d", "reportDate": "2026-09-10"})


# --- invalid period/date -> 400, before any storage ------------------------


def test_get_creator_summary_rejects_invalid_period_before_any_storage(monkeypatch):
    monkeypatch.setattr(read_api, "load_creators", _boom)
    monkeypatch.setattr(read_api, "get_cached_trending", _boom)

    with pytest.raises(read_api.ClientError):
        get_creator_summary({"creatorId": "aizawa_ema", "period": "not_a_real_period", "reportDate": "2026-09-10"})


def test_get_creator_summary_rejects_invalid_report_date_before_any_storage(monkeypatch):
    monkeypatch.setattr(read_api, "load_creators", _boom)
    monkeypatch.setattr(read_api, "get_cached_trending", _boom)

    with pytest.raises(read_api.ClientError):
        get_creator_summary({"creatorId": "aizawa_ema", "period": "7d", "reportDate": "not-a-date"})


def test_get_organization_leaderboard_rejects_invalid_period_and_date_before_any_storage(monkeypatch):
    monkeypatch.setattr(read_api, "load_creators", _boom)
    monkeypatch.setattr(read_api, "get_cached_trending", _boom)

    with pytest.raises(read_api.ClientError):
        get_organization_leaderboard({"organization": "vspo", "period": "bogus", "reportDate": "2026-09-10"})
    with pytest.raises(read_api.ClientError):
        get_organization_leaderboard({"organization": "vspo", "period": "7d", "reportDate": "2026/09/10"})


# --- exactly one cache GetItem per successful request ----------------------


def test_get_creator_summary_costs_exactly_one_cache_get_item(monkeypatch):
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator("aizawa_ema")])
    calls = []

    def counting_get(key):
        calls.append(key)
        return {"creatorId": "aizawa_ema"}

    monkeypatch.setattr(read_api, "get_cached_trending", counting_get)

    get_creator_summary({"creatorId": "aizawa_ema", "period": "7d", "reportDate": "2026-09-10"})

    assert len(calls) == 1


def test_get_organization_leaderboard_costs_exactly_one_cache_get_item(monkeypatch):
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator("aizawa_ema", organization="vspo")])
    calls = []

    def counting_get(key):
        calls.append(key)
        return {"organization": "vspo"}

    monkeypatch.setattr(read_api, "get_cached_trending", counting_get)

    get_organization_leaderboard({"organization": "vspo", "period": "7d", "reportDate": "2026-09-10"})

    assert len(calls) == 1


# --- defaults: period="all", reportDate=today (Asia/Tokyo) -----------------


def test_get_creator_summary_defaults_period_to_all_and_report_date_to_today(monkeypatch):
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator("aizawa_ema")])
    calls = []
    monkeypatch.setattr(
        read_api, "get_cached_trending", lambda key: (calls.append(key), {"creatorId": "aizawa_ema"})[1]
    )

    get_creator_summary({"creatorId": "aizawa_ema"})

    today = read_api._today_in_canonical_time_zone()
    assert calls == [f"creatorSummary:aizawa_ema:all:{today.isoformat()}"]


# --- moved cache-key builders: byte-for-byte identical, shared, not duplicated --


def test_trending_cache_key_output_unchanged_after_moving_to_shared_module():
    key = read_api.trending_cache_key(
        scope_type="creator",
        scope_value="aizawa_ema",
        period="7d",
        ranking_type="7d_trending",
        report_date=date(2026, 9, 10),
    )
    assert key == "creator:aizawa_ema:7d:7d_trending:2026-09-10:Asia/Tokyo"


def test_read_api_and_ranking_reducer_share_the_exact_same_cache_key_functions():
    """No duplicated definitions after the move -- both modules must be
    referencing the identical function objects from trending_cache_keys."""
    assert read_api.trending_cache_key is trending_cache_keys.trending_cache_key
    assert ranking_reducer.trending_cache_key is trending_cache_keys.trending_cache_key
    assert read_api.creator_summary_cache_key is trending_cache_keys.creator_summary_cache_key
    assert ranking_reducer.creator_summary_cache_key is trending_cache_keys.creator_summary_cache_key
    assert read_api.organization_leaderboard_cache_key is trending_cache_keys.organization_leaderboard_cache_key
    assert ranking_reducer.organization_leaderboard_cache_key is trending_cache_keys.organization_leaderboard_cache_key
