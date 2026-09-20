import inspect
import json
from datetime import date, timedelta

import pytest

import comparison_api
import history_ranking
import ranking_reducer
import read_api
from api_handler import lambda_handler
from creator_master import Creator
from history_store import HistoryRow
from trending_cache_keys import creator_summary_cache_key

REPORT_DATE = "2026-09-07"
REPORT = date.fromisoformat(REPORT_DATE)


def _creator(creator_id: str) -> Creator:
    return Creator(
        creator_id=creator_id,
        display_name=creator_id,
        organization="hololive",
        youtube_channel_id="UC_test",
        active=True,
        branch="holo_jp",
        group_key=["NO"],
        channel_type="member",
        lifecycle_stage="active",
    )


def _payload(creator_id: str, period: str, day: date, view_sum: int, eligible: int = 1, catalog: int | None = None) -> dict:
    return {
        "creatorId": creator_id,
        "period": period,
        "reportDate": day.isoformat(),
        "viewSum": view_sum,
        "catalogVideoCount": eligible if catalog is None else catalog,
        "eligibleVideoCount": eligible,
        "isComplete": (eligible if catalog is None else catalog) == eligible,
        "topVideo": None,
        "top10": [],
    }


class _Cache:
    """In-memory stand-in for YobiTrendingCache's single-key read; records every key read."""

    def __init__(self):
        self.items: dict[str, dict] = {}
        self.calls: list[str] = []
        self.failing_creators: set[str] = set()

    def put(self, creator_id: str, period: str, day: date, payload: dict) -> None:
        self.items[creator_summary_cache_key(creator_id=creator_id, period=period, report_date=day)] = payload

    def __call__(self, key: str) -> dict | None:
        self.calls.append(key)
        if any(f"creatorSummary:{creator_id}:" in key for creator_id in self.failing_creators):
            raise RuntimeError("cache unavailable")
        return self.items.get(key)

    @property
    def keys_read(self) -> list[str]:
        return self.calls


def _window() -> list[date]:
    return [REPORT - timedelta(days=offset) for offset in range(6, -1, -1)]


def _fill(cache: _Cache, creator_id: str, *, total_start: int, daily_gain: int, days: list[date] | None = None, catalog: int = 1) -> None:
    for index, day in enumerate(days if days is not None else _window()):
        cache.put(creator_id, "all", day, _payload(creator_id, "all", day, total_start + index * daily_gain, catalog=catalog))
        cache.put(creator_id, "1d", day, _payload(creator_id, "1d", day, daily_gain, catalog=catalog))


def _query(creator_ids, item_ids, **extra):
    query = {"creatorIds": creator_ids, "comparisonItemIds": item_ids, "reportDate": REPORT_DATE, "timeZone": "Asia/Tokyo"}
    query.update(extra)
    return query


def _get(query):
    return lambda_handler(
        {"routeKey": "GET /dashboard/comparison-data", "queryStringParameters": query, "pathParameters": None, "body": None, "headers": {}},
        None,
    )


def _data(response):
    assert response["statusCode"] == 200, response["body"]
    return json.loads(response["body"])


def _legacy_reader_must_not_be_called(*_args, **_kwargs):
    raise AssertionError("the comparison endpoint must not read per-video storage (Video Master / YobiSnapshots)")


@pytest.fixture
def world(monkeypatch):
    cache = _Cache()
    _fill(cache, "alpha", total_start=6000, daily_gain=15)
    _fill(cache, "bravo", total_start=200, daily_gain=20)
    # charlie is a known creator with no stored aggregate at all
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator("alpha"), _creator("bravo"), _creator("charlie")])
    monkeypatch.setattr(comparison_api, "get_cached_trending", cache)
    for name in ("get_snapshot", "get_videos_by_creator", "get_video"):
        monkeypatch.setattr(read_api, name, _legacy_reader_must_not_be_called)
    return cache


def test_supported_creators_and_items_return_stored_series(world):
    data = _data(_get(_query("alpha,bravo", "daily-view-growth,total-views")))

    assert data["reportDate"] == REPORT_DATE and data["timeZone"] == "Asia/Tokyo" and data["windowDays"] == 7
    growth, total = data["items"]
    alpha_growth = growth["creators"][0]
    assert alpha_growth["status"] == "ok"
    assert [p["label"] for p in alpha_growth["points"]] == [f"2026-09-{d:02d}" for d in range(1, 8)]
    assert {p["value"] for p in alpha_growth["points"]} == {15}
    assert {p["value"] for p in growth["creators"][1]["points"]} == {20}
    assert total["creators"][0]["points"][-1] == {"label": "2026-09-07", "value": 6000 + 6 * 15}
    assert total["creators"][1]["points"][0] == {"label": "2026-09-01", "value": 200}


def test_creator_order_is_preserved_and_never_sorted(world):
    data = _data(_get(_query("charlie,bravo,alpha", "total-views")))

    assert [c["creatorId"] for c in data["items"][0]["creators"]] == ["charlie", "bravo", "alpha"]
    assert [c["creatorId"] for c in _data(_get(_query("alpha,bravo", "total-views")))["items"][0]["creators"]] == ["alpha", "bravo"]


def test_item_order_is_preserved(world):
    data = _data(_get(_query("alpha", "total-views,daily-view-growth")))

    assert [item["comparisonItemId"] for item in data["items"]] == ["total-views", "daily-view-growth"]


def test_a_creator_values_do_not_depend_on_its_position(world):
    first = _data(_get(_query("alpha,bravo", "total-views")))["items"][0]["creators"]
    swapped = _data(_get(_query("bravo,alpha", "total-views")))["items"][0]["creators"]

    assert first[0] == swapped[1] and first[1] == swapped[0]


def test_unsupported_item_is_rejected_with_400_before_any_read(world):
    response = _get(_query("alpha", "revenue"))

    assert response["statusCode"] == 400
    assert "revenue" in json.loads(response["body"])["error"]
    assert _get(_query("alpha", "total-views,engagement"))["statusCode"] == 400
    assert world.calls == []


def test_unknown_creator_is_unavailable_with_no_fabricated_data_and_no_read(world):
    entries = _data(_get(_query("alpha,ghost", "total-views")))["items"][0]["creators"]

    assert entries[0]["status"] == "ok"
    assert entries[1] == {"creatorId": "ghost", "status": "unavailable"}
    assert not any("ghost" in key for key in world.keys_read)


def test_a_known_creator_without_any_stored_aggregate_yields_the_empty_state_not_zeros(world):
    assert _data(_get(_query("charlie", "total-views")))["items"][0]["creators"] == []


def test_a_creator_with_no_data_among_others_keeps_its_slot_without_points(world):
    entries = _data(_get(_query("alpha,charlie", "total-views")))["items"][0]["creators"]

    assert [e["creatorId"] for e in entries] == ["alpha", "charlie"]
    assert entries[1] == {"creatorId": "charlie", "status": "ok", "points": []}


def test_a_report_date_without_a_stored_aggregate_gets_no_point_instead_of_zero(monkeypatch):
    cache = _Cache()
    _fill(cache, "alpha", total_start=1000, daily_gain=10, days=[d for d in _window() if d != date(2026, 9, 4)])
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator("alpha")])
    monkeypatch.setattr(comparison_api, "get_cached_trending", cache)

    points = _data(_get(_query("alpha", "daily-view-growth")))["items"][0]["creators"][0]["points"]

    assert [p["label"] for p in points] == ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-05", "2026-09-06", "2026-09-07"]
    assert all(p["value"] == 10 for p in points)


def test_an_aggregate_covering_no_eligible_video_gets_no_point_instead_of_zero(monkeypatch):
    cache = _Cache()
    cache.put("alpha", "1d", REPORT, _payload("alpha", "1d", REPORT, 0, eligible=0, catalog=4))
    cache.put("alpha", "1d", REPORT - timedelta(days=1), _payload("alpha", "1d", REPORT - timedelta(days=1), 25, eligible=2, catalog=4))
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator("alpha")])
    monkeypatch.setattr(comparison_api, "get_cached_trending", cache)

    points = _data(_get(_query("alpha", "daily-view-growth")))["items"][0]["creators"][0]["points"]

    assert points == [{"label": "2026-09-06", "value": 25}]


def test_partial_failure_keeps_the_other_creators_data(world):
    world.failing_creators.add("bravo")

    entries = _data(_get(_query("alpha,bravo", "total-views")))["items"][0]["creators"]

    assert entries[0]["status"] == "ok" and entries[0]["points"]
    assert entries[1] == {"creatorId": "bravo", "status": "error"}


def test_a_malformed_stored_aggregate_is_that_creators_error_only(world):
    world.put("bravo", "all", REPORT, {"creatorId": "bravo", "period": "all", "reportDate": REPORT_DATE, "viewSum": "lots", "eligibleVideoCount": 1})

    entries = _data(_get(_query("alpha,bravo", "total-views")))["items"][0]["creators"]

    assert entries[0]["status"] == "ok" and entries[0]["points"]
    assert entries[1] == {"creatorId": "bravo", "status": "error"}


def test_an_aggregate_stored_for_a_different_creator_is_an_error_not_data(world):
    world.put("alpha", "all", REPORT, _payload("bravo", "all", REPORT, 5))

    entries = _data(_get(_query("alpha", "total-views")))["items"][0]["creators"]

    assert entries == [{"creatorId": "alpha", "status": "error"}]


def test_a_backend_without_the_summary_cache_answers_503_not_fabricated_data(monkeypatch):
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator("alpha")])
    monkeypatch.setattr(comparison_api, "get_cached_trending", None)

    assert _get(_query("alpha", "total-views"))["statusCode"] == 503


@pytest.mark.parametrize(
    "query",
    [
        {},
        {"creatorIds": "", "comparisonItemIds": "total-views", "reportDate": REPORT_DATE, "timeZone": "Asia/Tokyo"},
        {"creatorIds": "alpha", "reportDate": REPORT_DATE, "timeZone": "Asia/Tokyo"},
        {"creatorIds": "alpha", "comparisonItemIds": "total-views", "timeZone": "Asia/Tokyo"},
        {"creatorIds": "alpha", "comparisonItemIds": "total-views", "reportDate": "2026-9-7", "timeZone": "Asia/Tokyo"},
        {"creatorIds": "alpha", "comparisonItemIds": "total-views", "reportDate": REPORT_DATE, "timeZone": "Mars/Base"},
        {"creatorIds": "alpha,,bravo", "comparisonItemIds": "total-views", "reportDate": REPORT_DATE, "timeZone": "Asia/Tokyo"},
        {"creatorIds": "alpha, bravo", "comparisonItemIds": "total-views", "reportDate": REPORT_DATE, "timeZone": "Asia/Tokyo"},
        {"creatorIds": "alpha", "comparisonItemIds": "", "reportDate": REPORT_DATE, "timeZone": "Asia/Tokyo"},
    ],
)
def test_malformed_requests_are_rejected_with_400(world, query):
    assert _get(query or None)["statusCode"] == 400


def test_duplicate_creator_ids_are_rejected_because_the_contract_is_ordered_and_unique(world):
    response = _get(_query("alpha,bravo,alpha", "total-views"))

    assert response["statusCode"] == 400
    assert "duplicates" in json.loads(response["body"])["error"]
    assert _get(_query("alpha", "total-views,total-views"))["statusCode"] == 400


def test_the_ten_creator_limit_is_enforced_and_ten_are_served(world, monkeypatch):
    ids = [f"c{i}" for i in range(comparison_api.MAX_COMPARISON_CREATORS)]
    for creator_id in ids:
        _fill(world, creator_id, total_start=100, daily_gain=1)
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator(creator_id) for creator_id in ids])

    served = _data(_get(_query(",".join(ids), "total-views")))["items"][0]["creators"]
    too_many = _get(_query(",".join([*ids, "c10"]), "total-views"))

    assert [entry["creatorId"] for entry in served] == ids and all(entry["status"] == "ok" for entry in served)
    assert too_many["statusCode"] == 400


# --- work bound -------------------------------------------------------------


def test_two_items_read_each_stored_aggregate_exactly_once(world):
    _data(_get(_query("alpha,bravo", "daily-view-growth,total-views")))

    # C x distinct periods x D single-key reads, none repeated: a second item never re-reads what the first fetched.
    assert len(world.calls) == len(set(world.calls)) == 2 * 2 * comparison_api.COMPARISON_WINDOW_DAYS


def test_a_single_item_reads_only_its_own_period(world):
    _data(_get(_query("alpha,bravo", "total-views")))

    assert len(world.keys_read) == 2 * comparison_api.COMPARISON_WINDOW_DAYS
    assert all(":all:" in key for key in world.keys_read)


def test_reads_do_not_depend_on_how_many_videos_a_creator_has(monkeypatch):
    def run(catalog_videos: int) -> int:
        cache = _Cache()
        _fill(cache, "alpha", total_start=1000, daily_gain=10, catalog=catalog_videos)
        monkeypatch.setattr(read_api, "load_creators", lambda: [_creator("alpha")])
        monkeypatch.setattr(comparison_api, "get_cached_trending", cache)
        _data(_get(_query("alpha", "daily-view-growth,total-views")))
        return len(cache.calls)

    assert run(3) == run(50_000) == 2 * comparison_api.COMPARISON_WINDOW_DAYS


def test_the_endpoint_has_no_per_video_or_snapshot_table_dependency():
    source = inspect.getsource(comparison_api)
    code = "\n".join(line for line in source.splitlines() if not line.lstrip().startswith(("#", '"""')))

    for legacy in ("get_snapshot", "get_videos_by_creator", "get_video(", "snapshot_store", "calculate_growth", "batch_get_item"):
        assert legacy not in code


def test_the_read_keys_are_the_ones_the_reducer_writes(world):
    _data(_get(_query("alpha", "total-views,daily-view-growth")))

    assert set(world.keys_read) == {
        creator_summary_cache_key(creator_id="alpha", period=period, report_date=day) for period in ("all", "1d") for day in _window()
    }


# --- served from the real reducer's output, with no YobiSnapshots data at all ---------


def _history_rows(day: date, counts: dict[str, tuple[str, int]]) -> list[HistoryRow]:
    return [
        HistoryRow(video_id=video_id, creator_id=creator_id, view_count=views, observed_at=f"{day.isoformat()}T18:00:00+09:00", availability_status="available")
        for video_id, (creator_id, views) in counts.items()
    ]


def test_a_response_is_served_from_the_new_pipelines_own_output_with_no_snapshot_data(monkeypatch):
    videos = {"g1": ("gura", 1_000_000, 10_000), "g2": ("gura", 500_000, 5_000), "p1": ("pekora", 2_000_000, 20_000)}
    first_day = REPORT - timedelta(days=8)

    def rows_on(day: date) -> list[HistoryRow]:
        offset = (day - first_day).days
        return _history_rows(day, {video_id: (creator_id, start + offset * gain) for video_id, (creator_id, start, gain) in videos.items()})

    stored: dict[str, dict] = {}
    for day in _window():
        partials = history_ranking.creator_period_partials(
            rows_on(day),
            {days: rows_on(day - timedelta(days=days)) if days == 1 else [] for days in history_ranking.EXACT_ANCHOR_DAYS},
            report_date=day,
        )
        ranking_reducer.persist_creator_and_organization_rankings(
            partials,
            report_date=day,
            dimensions_by_creator={},
            put_cached_trending=lambda key, payload, *, computed_at: stored.__setitem__(key, payload),
            computed_at=f"{day.isoformat()}T18:05:00+09:00",
            wru_budget=ranking_reducer.WruBudget(target_wru_per_second=1_000_000),
        )

    cache = _Cache()
    cache.items = stored
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator("gura"), _creator("pekora")])
    monkeypatch.setattr(comparison_api, "get_cached_trending", cache)
    for name in ("get_snapshot", "get_videos_by_creator", "get_video"):
        monkeypatch.setattr(read_api, name, _legacy_reader_must_not_be_called)

    growth, total = _data(_get(_query("gura,pekora", "daily-view-growth,total-views")))["items"]

    assert {p["value"] for p in growth["creators"][0]["points"]} == {15_000}
    assert {p["value"] for p in growth["creators"][1]["points"]} == {20_000}
    offset = (REPORT - first_day).days
    assert total["creators"][0]["points"][-1] == {"label": REPORT_DATE, "value": (1_000_000 + offset * 10_000) + (500_000 + offset * 5_000)}


def test_every_item_is_backed_by_a_stored_period():
    assert set(comparison_api.METRICS) == {item.metric for item in comparison_api._ITEMS_BY_ID.values()}
    assert set(comparison_api.METRICS.values()) == {"1d", "all"}
