import json
from datetime import date

import pytest

import comparison_api
import read_api
from api_handler import lambda_handler
from creator_master import Creator
from snapshot_store import Snapshot
from video_master import Video

REPORT_DATE = "2026-09-07"


def _creator(creator_id: str, **overrides) -> Creator:
    fields = {
        "creator_id": creator_id,
        "display_name": creator_id,
        "organization": "hololive",
        "youtube_channel_id": "UC_test",
        "active": True,
        "branch": "holo_jp",
        "group_key": ["NO"],
        "channel_type": "member",
        "lifecycle_stage": "active",
    }
    fields.update(overrides)
    return Creator(**fields)


def _video(video_id: str, creator_id: str, **overrides) -> Video:
    fields = {"video_id": video_id, "creator_id": creator_id, "title": video_id, "published_at": "2026-08-20T00:00:00Z"}
    fields.update(overrides)
    return Video(**fields)


def _snapshot(video_id: str, creator_id: str, snapshot_date: str, view_count: int) -> Snapshot:
    return Snapshot(
        snapshot_date=snapshot_date,
        observed_at=f"{snapshot_date}T18:00:05+09:00",
        creator_id=creator_id,
        video_id=video_id,
        title=video_id,
        published_at="2026-08-20T00:00:00Z",
        view_count=view_count,
        organization="hololive",
    )


class _World:
    """In-memory stand-in for Creator Master, Video Master and the snapshot store."""

    def __init__(self, creators, videos, snapshots):
        self.creators = {c.creator_id: c for c in creators}
        self.videos = videos
        self.snapshots = {(s.video_id, s.snapshot_date): s for s in snapshots}
        self.failing_creators: set[str] = set()

    def install(self, monkeypatch):
        monkeypatch.setattr(read_api, "load_creators", lambda: list(self.creators.values()))

        def get_videos_by_creator(creator_id):
            if creator_id in self.failing_creators:
                raise RuntimeError("storage unavailable")
            return [v for v in self.videos if v.creator_id == creator_id]

        monkeypatch.setattr(read_api, "get_videos_by_creator", get_videos_by_creator)
        monkeypatch.setattr(read_api, "get_snapshot", lambda video_id, day: self.snapshots.get((video_id, day.isoformat())))


def _series(video_id, creator_id, start_views, daily_gain, days=8, end="2026-09-07"):
    """Snapshots on the `days` dates ending at `end`, growing by `daily_gain` per day."""
    end_date = date.fromisoformat(end)
    out = []
    for index in range(days):
        day = date.fromordinal(end_date.toordinal() - (days - 1 - index))
        out.append(_snapshot(video_id, creator_id, day.isoformat(), start_views + index * daily_gain))
    return out


def _query(creator_ids, item_ids, **extra):
    query = {"creatorIds": creator_ids, "comparisonItemIds": item_ids, "reportDate": REPORT_DATE, "timeZone": "Asia/Tokyo"}
    query.update(extra)
    return query


def _get(query):
    return lambda_handler(
        {"routeKey": "GET /dashboard/comparison-data", "queryStringParameters": query, "pathParameters": None, "body": None, "headers": {}},
        None,
    )


@pytest.fixture
def world(monkeypatch):
    w = _World(
        creators=[_creator("alpha"), _creator("bravo"), _creator("charlie")],
        videos=[_video("a1", "alpha"), _video("a2", "alpha"), _video("b1", "bravo"), _video("c1", "charlie")],
        snapshots=[
            *_series("a1", "alpha", 1000, 10),
            *_series("a2", "alpha", 5000, 5),
            *_series("b1", "bravo", 200, 20),
            # charlie's only video has no snapshot at all
        ],
    )
    w.install(monkeypatch)
    return w


def _data(response):
    assert response["statusCode"] == 200, response["body"]
    return json.loads(response["body"])


def test_supported_creators_and_items_return_real_series(world):
    data = _data(_get(_query("alpha,bravo", "daily-view-growth,total-views")))

    assert data["reportDate"] == REPORT_DATE and data["timeZone"] == "Asia/Tokyo" and data["windowDays"] == 7
    growth, total = data["items"]
    alpha_growth = growth["creators"][0]
    assert alpha_growth["status"] == "ok"
    assert [p["label"] for p in alpha_growth["points"]] == [f"2026-09-{d:02d}" for d in range(1, 8)]
    assert {p["value"] for p in alpha_growth["points"]} == {15}  # 10 + 5 views gained per day across both videos
    assert {p["value"] for p in growth["creators"][1]["points"]} == {20}
    # total-views is the sum of the same videos' view counts on each date.
    assert total["creators"][0]["points"][-1] == {"label": "2026-09-07", "value": (1000 + 7 * 10) + (5000 + 7 * 5)}


def test_creator_order_is_preserved_and_never_sorted(world):
    data = _data(_get(_query("charlie,bravo,alpha", "total-views")))

    assert [c["creatorId"] for c in data["items"][0]["creators"]] == ["charlie", "bravo", "alpha"]
    reversed_data = _data(_get(_query("alpha,bravo", "total-views")))
    assert [c["creatorId"] for c in reversed_data["items"][0]["creators"]] == ["alpha", "bravo"]


def test_item_order_is_preserved(world):
    data = _data(_get(_query("alpha", "total-views,daily-view-growth")))

    assert [item["comparisonItemId"] for item in data["items"]] == ["total-views", "daily-view-growth"]


def test_a_creator_values_do_not_depend_on_its_position(world):
    first = _data(_get(_query("alpha,bravo", "total-views")))["items"][0]["creators"]
    swapped = _data(_get(_query("bravo,alpha", "total-views")))["items"][0]["creators"]

    assert first[0] == swapped[1] and first[1] == swapped[0]


def test_unsupported_item_is_rejected_with_400(world):
    response = _get(_query("alpha", "revenue"))

    assert response["statusCode"] == 400
    assert "revenue" in json.loads(response["body"])["error"]
    assert _get(_query("alpha", "total-views,engagement"))["statusCode"] == 400


def test_unknown_creator_is_unavailable_with_no_fabricated_data(world):
    entries = _data(_get(_query("alpha,ghost", "total-views")))["items"][0]["creators"]

    assert entries[0]["status"] == "ok"
    assert entries[1] == {"creatorId": "ghost", "status": "unavailable"}


def test_a_known_creator_without_any_snapshot_yields_the_empty_state_not_zeros(world):
    item = _data(_get(_query("charlie", "total-views")))["items"][0]

    assert item["creators"] == []


def test_a_creator_with_no_data_among_others_keeps_its_slot_without_points(world):
    entries = _data(_get(_query("alpha,charlie", "total-views")))["items"][0]["creators"]

    assert [e["creatorId"] for e in entries] == ["alpha", "charlie"]
    assert entries[1] == {"creatorId": "charlie", "status": "ok", "points": []}


def test_a_date_missing_a_snapshot_gets_no_point_instead_of_zero(monkeypatch):
    snapshots = [s for s in _series("a1", "alpha", 1000, 10) if s.snapshot_date != "2026-09-04"]
    _World([_creator("alpha")], [_video("a1", "alpha")], snapshots).install(monkeypatch)

    points = _data(_get(_query("alpha", "daily-view-growth")))["items"][0]["creators"][0]["points"]

    # 09-04 has no snapshot, so 09-04 (no latest) and 09-05 (no previous) both have no pair.
    assert [p["label"] for p in points] == ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-06", "2026-09-07"]
    assert all(p["value"] == 10 for p in points)


def test_partial_failure_keeps_the_other_creators_data(world):
    world.failing_creators.add("bravo")

    entries = _data(_get(_query("alpha,bravo", "total-views")))["items"][0]["creators"]

    assert entries[0]["status"] == "ok" and entries[0]["points"]
    assert entries[1] == {"creatorId": "bravo", "status": "error"}


def test_every_tracked_video_counts_including_cold_ones(monkeypatch):
    w = _World(
        [_creator("alpha")],
        [_video("hot", "alpha"), _video("cold", "alpha", activity_state="Cold")],
        [*_series("hot", "alpha", 100, 1), *_series("cold", "alpha", 9999, 999)],
    )
    w.install(monkeypatch)

    points = _data(_get(_query("alpha", "daily-view-growth")))["items"][0]["creators"][0]["points"]

    assert {p["value"] for p in points} == {1 + 999}


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


def test_too_many_creators_are_rejected(world):
    ids = ",".join(f"c{i}" for i in range(comparison_api.MAX_COMPARISON_CREATORS + 1))

    assert _get(_query(ids, "total-views"))["statusCode"] == 400


def test_every_item_is_computed_from_a_metric_that_exists():
    assert set(comparison_api.METRICS) == {item.metric for item in comparison_api._ITEMS_BY_ID.values()}
