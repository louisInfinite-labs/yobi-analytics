"""Home Oshi Videos backend support: creatorId x topic x contentType x sort x viewWindow over the
per-creator S3 video-ranking result, via GET /creators/{id}/videos/recent (newest/oldest) and
GET /creators/{id}/videos/ranking (views total/1d/7d/30d). Always ONE creator, never across creators."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from itertools import product

import pytest

from api import api_handler, read_api
from tracking.creator_master import Creator
from tracking.video_topics import TOPIC_IDS

REPORT_DATE = "2026-10-01"
TOPICS = sorted(TOPIC_IDS)  # apex, chatting, minecraft, mv, other, sf6, singing, valorant
CONTENT_TYPES = ("all", "live", "upload")
WINDOWS = ("total", "1d", "7d", "30d")


def _creator(creator_id: str) -> Creator:
    return Creator(
        creator_id=creator_id,
        display_name=creator_id,
        organization="vspo",
        youtube_channel_id=f"UC_{creator_id}",
        active=True,
        branch="vspo_jp",
        group_key=["1期生"],
        channel_type="member",
        lifecycle_stage="active",
        display_order=0,
    )


def _row(
    video_id: str,
    topic: str,
    *,
    kind: str = "upload",  # "upload" | "stream" (completed) | "upcoming" | "live" | "unclassified"
    creator_id: str = "emma",
    current: int = 1000,
    anchors: tuple[int | None, int | None, int | None] = (None, None, None),
    published: str | None = "2026-09-01T00:00:00Z",
) -> dict:
    content_type, live_status = {
        "upload": ("upload", None),
        "stream": ("live", "completed"),
        "upcoming": ("live", "upcoming"),
        "live": ("live", "live"),
        "unclassified": (None, None),
    }[kind]
    return {
        "videoId": video_id,
        "creatorId": creator_id,
        "topic": topic,
        "contentType": content_type,
        "liveStatus": live_status,
        "currentViewCount": current,
        "anchor1dViewCount": anchors[0],
        "anchor7dViewCount": anchors[1],
        "anchor30dViewCount": anchors[2],
        "title": f"title {video_id}",
        "thumbnailUrl": None,
        "publishedAt": published,
        "discoveredAt": None,
    }


def _payload(rows: list[dict], creator_id: str = "emma") -> dict:
    return {
        "schemaVersion": 2,
        "reportDate": REPORT_DATE,
        "creatorId": creator_id,
        "generatedAt": f"{REPORT_DATE}T18:05:00+09:00",
        "videos": rows,
    }


class _Store:
    def __init__(self, payloads: dict[tuple[str, str], dict]):
        self.payloads = payloads
        self.reads: list[tuple[str, str]] = []

    def read_result(self, report_date: date, creator_id: str):
        self.reads.append((report_date.isoformat(), creator_id))
        return self.payloads.get((report_date.isoformat(), creator_id))


def _wire(monkeypatch, per_creator: dict[str, list[dict]]) -> _Store:
    store = _Store({(REPORT_DATE, cid): _payload(rows, cid) for cid, rows in per_creator.items()})

    class _StoreClass:
        @classmethod
        def from_environment_or_default(cls, *, s3_client=None):
            return store

    monkeypatch.setattr(read_api, "S3VideoRankingStore", _StoreClass)
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator("emma"), _creator("subaru")])
    return store


def _recent(**query) -> dict:
    base = {"creatorId": "emma", "reportDate": REPORT_DATE, "limit": "20"}
    base.update(query)
    return read_api.get_recent_creator_videos(base)


def _ranking(**query) -> dict:
    base = {"creatorId": "emma", "reportDate": REPORT_DATE, "metric": "total"}
    base.update(query)
    return read_api.get_video_ranking(base)


def _ids(response: dict, key: str) -> list[str]:
    return [item["videoId"] for item in response[key]]


def _all_pages(**query) -> list[str]:
    """Every id from /videos/recent, following offset/hasMore to the end."""
    ids, offset = [], 0
    while True:
        page = _recent(offset=str(offset), **query)
        ids += _ids(page, "videos")
        if not page["hasMore"]:
            return ids
        offset += len(page["videos"])


# A dataset covering every topic x kind for the current creator, plus another creator's look-alikes.
def _matrix_rows() -> list[dict]:
    rows = []
    base = datetime(2026, 8, 1, tzinfo=timezone.utc)
    for index, (topic, kind) in enumerate(product(TOPICS, ("upload", "stream", "upcoming", "live", "unclassified"))):
        published = (base + timedelta(days=index)).isoformat().replace("+00:00", "Z")
        # Distinct totals and distinct per-window growth that do NOT follow the publish order.
        current = 10_000 - index * 137
        anchors = (current - (index * 7 % 53 + 1), current - (index * 11 % 97 + 5), current - (index * 13 % 191 + 9))
        rows.append(_row(f"{topic}-{kind}", topic, kind=kind, current=current, anchors=anchors, published=published))
    return rows


def _creator_rows() -> list[dict]:
    return _matrix_rows()


def _other_creator_rows() -> list[dict]:
    return [
        _row(f"subaru-{topic}-{kind}", topic, kind=kind, creator_id="subaru", current=9_999_999, anchors=(0, 0, 0),
             published="2026-09-30T00:00:00Z")
        for topic in TOPICS
        for kind in ("upload", "stream")
    ]


def _matches(row: dict, topic: str, content_type: str) -> bool:
    """Independent oracle for the Home shelf's filter: archives only (no upcoming/live-now rows)."""
    if row["creatorId"] != "emma" or row["liveStatus"] in ("upcoming", "live"):
        return False
    return (topic == "all" or row["topic"] == topic) and (content_type == "all" or row["contentType"] == content_type)


# --- 1. creator isolation --------------------------------------------------------------------------


@pytest.mark.parametrize("creator", ["emma", "subaru"])
def test_every_mode_returns_only_the_requested_creators_videos(monkeypatch, creator):
    store = _wire(monkeypatch, {"emma": _creator_rows() + _other_creator_rows()[:3], "subaru": _other_creator_rows()})

    responses = [
        _recent(creatorId=creator, sort="newest"),
        _recent(creatorId=creator, sort="oldest"),
        *[_ranking(creatorId=creator, metric=window) for window in WINDOWS],
    ]

    for response in responses:
        assert response["creatorId"] == creator
        assert response["videos" if "videos" in response else "rows"], "fixture must yield rows for this creator"
    for response in responses:
        items = response.get("videos") or response.get("rows")
        assert all(item["creatorId"] == creator for item in items)
    assert {creator_id for _date, creator_id in store.reads} == {creator}


def test_a_look_alike_row_with_another_creator_id_inside_this_creators_object_is_never_served(monkeypatch):
    leaked = _row("leak", "sf6", kind="stream", creator_id="subaru", current=9_999_999, anchors=(0, 0, 0))
    _wire(monkeypatch, {"emma": [_row("mine", "sf6", kind="stream"), leaked]})

    assert _ids(_recent(topic="sf6", contentType="live"), "videos") == ["mine"]
    assert _ids(_ranking(metric="1d", topic="sf6", contentType="live"), "rows") == []  # mine has no 1d anchor; leak is dropped
    assert _ids(_ranking(topic="sf6", contentType="live"), "rows") == ["mine"]


# --- 2. combined filtering (explicit acceptance cases) ----------------------------------------------


def test_sf6_live_newest_and_oldest_contain_only_this_creators_sf6_archives(monkeypatch):
    rows = [
        _row("sf6-s1", "sf6", kind="stream", published="2026-09-01T00:00:00Z"),
        _row("sf6-s2", "sf6", kind="stream", published="2026-09-03T00:00:00Z"),
        _row("sf6-s3", "sf6", kind="stream", published="2026-09-02T00:00:00Z"),
        _row("sf6-upload", "sf6", kind="upload", published="2026-09-09T00:00:00Z"),  # wrong content type
        _row("sf6-upcoming", "sf6", kind="upcoming", published="2026-09-10T00:00:00Z"),  # not an archive
        _row("valo-stream", "valorant", kind="stream", published="2026-09-11T00:00:00Z"),  # wrong topic
    ]
    _wire(monkeypatch, {"emma": rows, "subaru": _other_creator_rows()})

    newest = _recent(topic="sf6", contentType="live", liveStatus="archived", sort="newest")
    oldest = _recent(topic="sf6", contentType="live", liveStatus="archived", sort="oldest")

    assert _ids(newest, "videos") == ["sf6-s2", "sf6-s3", "sf6-s1"]
    assert _ids(oldest, "videos") == ["sf6-s1", "sf6-s3", "sf6-s2"]
    assert (newest["topic"], newest["sort"], oldest["sort"]) == ("sf6", "newest", "oldest")


def test_valorant_video_filters_are_a_conjunction_not_a_union(monkeypatch):
    rows = [
        _row("v-up-new", "valorant", kind="upload", published="2026-09-05T00:00:00Z"),
        _row("v-up-old", "valorant", kind="upload", published="2026-09-01T00:00:00Z"),
        _row("v-stream", "valorant", kind="stream", published="2026-09-09T00:00:00Z"),
        _row("sf6-up", "sf6", kind="upload", published="2026-09-09T00:00:00Z"),
    ]
    _wire(monkeypatch, {"emma": rows, "subaru": _other_creator_rows()})

    assert _ids(_recent(topic="valorant", contentType="upload", liveStatus="archived"), "videos") == ["v-up-new", "v-up-old"]
    assert _ids(_recent(topic="valorant", contentType="upload", liveStatus="archived", sort="oldest"), "videos") == [
        "v-up-old",
        "v-up-new",
    ]


@pytest.mark.parametrize(("topic", "content_type"), [("minecraft", "upload"), ("apex", "live"), ("chatting", "all"), ("other", "upload")])
def test_other_topics_work_generically_not_just_sf6_and_valorant(monkeypatch, topic, content_type):
    _wire(monkeypatch, {"emma": _creator_rows() + _other_creator_rows(), "subaru": _other_creator_rows()})
    expected = {row["videoId"] for row in _creator_rows() if _matches(row, topic, content_type)}
    assert expected, "fixture must have matches"

    got_recent = set(_all_pages(topic=topic, contentType=content_type, liveStatus="archived"))
    got_ranking = set(_ids(_ranking(topic=topic, contentType=content_type, liveStatus="archived", limit="100"), "rows"))

    assert got_recent == expected == got_ranking


def test_the_full_topic_by_content_type_by_sort_by_window_matrix_matches_an_independent_oracle(monkeypatch):
    creator_rows = _creator_rows()
    _wire(monkeypatch, {"emma": creator_rows + _other_creator_rows(), "subaru": _other_creator_rows()})
    checked = 0

    for topic, content_type in product(["all", *TOPICS], CONTENT_TYPES):
        matching = [row for row in creator_rows if _matches(row, topic, content_type)]
        by_id = sorted(matching, key=lambda row: row["videoId"])
        query = {"topic": topic, "contentType": content_type, "liveStatus": "archived"}

        newest = [row["videoId"] for row in sorted(by_id, key=lambda row: row["publishedAt"], reverse=True)]
        oldest = [row["videoId"] for row in sorted(by_id, key=lambda row: row["publishedAt"])]
        assert _all_pages(sort="newest", **query) == newest
        assert _all_pages(sort="oldest", **query) == oldest

        total = [row["videoId"] for row in sorted(by_id, key=lambda row: -row["currentViewCount"])]
        assert _ids(_ranking(metric="total", limit="100", **query), "rows") == total
        for period in ("1d", "7d", "30d"):
            field = f"anchor{period}ViewCount"
            ranked = [
                row["videoId"]
                for row in sorted(
                    (row for row in by_id if row[field] is not None),
                    key=lambda row: -(row["currentViewCount"] - row[field]),
                )
            ]
            assert _ids(_ranking(metric=period, limit="100", **query), "rows") == ranked
        checked += 1

    assert checked == len(CONTENT_TYPES) * (len(TOPICS) + 1) == 27  # every capability-matrix cell


# --- 3. oldest is a true ascending sort, never a reversed truncated newest page ----------------------


def test_oldest_returns_the_true_oldest_matches_not_a_reversed_newest_page(monkeypatch):
    # 30 matching SF6 archives, then a newer page's worth of other content; the newest 20 pages exclude the oldest 10.
    rows = [
        _row(f"s{index:02d}", "sf6", kind="stream", published=(datetime(2026, 7, 1, tzinfo=timezone.utc) + timedelta(days=index)).isoformat().replace("+00:00", "Z"))
        for index in range(30)
    ]
    rows += [_row(f"noise{index}", "apex", kind="upload", published="2026-09-20T00:00:00Z") for index in range(40)]
    _wire(monkeypatch, {"emma": rows})
    query = {"topic": "sf6", "contentType": "live", "liveStatus": "archived"}

    first_oldest_page = _ids(_recent(sort="oldest", limit="5", **query), "videos")
    newest_20 = _ids(_recent(sort="newest", limit="20", **query), "videos")

    assert first_oldest_page == ["s00", "s01", "s02", "s03", "s04"]
    assert "s00" not in newest_20 and "s09" not in newest_20  # a reversed newest page could never contain these
    assert _all_pages(sort="oldest", **query) == [f"s{index:02d}" for index in range(30)]  # paging: no gaps, no duplicates


def test_equal_timestamps_break_ties_by_video_id_and_undated_rows_sort_last_in_both_directions(monkeypatch):
    same = "2026-09-01T00:00:00Z"
    rows = [
        _row("b", "sf6", published=same),
        _row("a", "sf6", published=same),
        _row("undated", "sf6", published=None),
        _row("later", "sf6", published="2026-09-02T00:00:00Z"),
    ]
    _wire(monkeypatch, {"emma": rows})

    assert _ids(_recent(sort="newest"), "videos") == ["later", "a", "b", "undated"]
    assert _ids(_recent(sort="oldest"), "videos") == ["a", "b", "later", "undated"]


# --- 4. views ranking applies creator/topic/type BEFORE the limit -------------------------------------


def test_ranking_filters_before_limit_so_matching_low_view_videos_are_not_lost_to_a_prefilter_cut(monkeypatch):
    noise = [_row(f"noise{index}", "apex", kind="upload", creator_id="emma", current=5_000_000 + index) for index in range(150)]
    matches = [_row(f"sf6-{index}", "sf6", kind="stream", current=100 + index) for index in range(3)]
    _wire(monkeypatch, {"emma": noise + matches})

    response = _ranking(metric="total", topic="sf6", contentType="live", liveStatus="archived", limit="100")

    assert _ids(response, "rows") == ["sf6-2", "sf6-1", "sf6-0"]
    assert [row["rank"] for row in response["rows"]] == [1, 2, 3]


def test_growth_windows_rank_by_absolute_growth_after_filtering_and_skip_rows_without_that_anchor(monkeypatch):
    rows = [
        _row("a", "sf6", kind="stream", current=1000, anchors=(900, 500, 100)),  # growth 100 / 500 / 900
        _row("b", "sf6", kind="stream", current=300, anchors=(100, 290, 0)),  # growth 200 / 10 / 300
        _row("c", "sf6", kind="stream", current=5000, anchors=(None, None, None)),  # no anchors: not ranked by growth
        _row("d", "sf6", kind="upload", current=9000, anchors=(0, 0, 0)),  # wrong content type
        _row("e", "valorant", kind="stream", current=9000, anchors=(0, 0, 0)),  # wrong topic
    ]
    _wire(monkeypatch, {"emma": rows})
    query = {"topic": "sf6", "contentType": "live", "liveStatus": "archived"}

    assert _ids(_ranking(metric="total", **query), "rows") == ["c", "a", "b"]
    assert _ids(_ranking(metric="1d", **query), "rows") == ["b", "a"]
    assert _ids(_ranking(metric="7d", **query), "rows") == ["a", "b"]
    assert _ids(_ranking(metric="30d", **query), "rows") == ["a", "b"]
    first = _ranking(metric="7d", **query)["rows"][0]
    assert (first["absoluteGrowth"], first["anchorViewCount"]) == (500, 500)


def test_ranking_rows_carry_published_at_for_the_home_card(monkeypatch):
    _wire(monkeypatch, {"emma": [_row("a", "sf6", kind="stream", current=10, anchors=(5, 5, 5), published="2026-09-02T00:00:00Z")]})

    assert _ranking(metric="total")["rows"][0]["publishedAt"] == "2026-09-02T00:00:00Z"
    assert _ranking(metric="7d")["rows"][0]["publishedAt"] == "2026-09-02T00:00:00Z"


# --- 5. archive semantics (no upcoming/live-now rows on the Home shelf) ------------------------------


def test_the_archived_scope_drops_upcoming_and_live_now_rows_but_keeps_uploads_and_completed_streams(monkeypatch):
    rows = [
        _row("up", "sf6", kind="upload"),
        _row("done", "sf6", kind="stream"),
        _row("soon", "sf6", kind="upcoming"),
        _row("now", "sf6", kind="live"),
        _row("old-unclassified", "sf6", kind="unclassified"),
    ]
    _wire(monkeypatch, {"emma": rows})

    assert sorted(_ids(_recent(liveStatus="archived"), "videos")) == ["done", "old-unclassified", "up"]
    assert sorted(_ids(_ranking(liveStatus="archived"), "rows")) == ["done", "old-unclassified", "up"]
    assert sorted(_ids(_recent(contentType="live", liveStatus="archived"), "videos")) == ["done"]
    # The default stays exactly as before: no liveStatus filter.
    assert sorted(_ids(_recent(contentType="live"), "videos")) == ["done", "now", "soon"]


# --- 5b. graduated creators keep their archive/history through this S3-backed path ------------------------


def _graduated(creator_id: str) -> Creator:
    return Creator(
        creator_id=creator_id,
        display_name=creator_id,
        organization="hololive",
        youtube_channel_id=f"UC_{creator_id}",
        active=True,
        branch="holo_en",
        group_key=["Myth"],
        channel_type="member",
        lifecycle_stage="graduated",
        display_order=0,
        discovery_enabled=False,
    )


def test_a_graduated_creator_is_served_her_stored_archives_from_s3_with_no_holodex_or_youtube_call(monkeypatch):
    """Graduation stops new-content collection; it never removes the creator's stored history. Home's archive
    row reads /videos/recent, which only needs the creator to exist and a stored S3 result -- no Holodex call, no
    YouTube call, no eligibility predicate that excludes graduated creators."""
    rows = [_row("old-stream", "chatting", kind="stream", creator_id="gura"), _row("old-upload", "other", creator_id="gura")]
    store = _wire(monkeypatch, {"gura": rows})
    monkeypatch.setattr(read_api, "load_creators", lambda: [_graduated("gura")])

    def _boom(*args, **kwargs):
        raise AssertionError("the archive read path must never call Holodex")

    monkeypatch.setattr(read_api, "holodex_get", _boom)

    response = _recent(creatorId="gura", contentType="live", liveStatus="completed")

    assert _ids(response, "videos") == ["old-stream"]
    assert store.reads == [(REPORT_DATE, "gura")]  # exactly one stored-result read, nothing else
    assert not hasattr(read_api, "build_youtube_client")  # the module has no YouTube client to call


def test_every_real_graduated_creator_passes_the_archive_read_paths_creator_gate(monkeypatch):
    """The real Creator Master's 13 graduated creators all resolve on the archive path (the gate is existence only);
    this path neither depends on nor changes any collection/polling eligibility."""
    from tracking.creator_master import is_content_collection_eligible, is_live_status_polling_eligible, load_creators

    real = [c for c in load_creators() if c.lifecycle_stage == "graduated"]
    assert len(real) == 13
    for creator in real:
        store = _Store({(REPORT_DATE, creator.creator_id): _payload([_row("a", "other", creator_id=creator.creator_id)], creator.creator_id)})

        class _StoreClass:
            @classmethod
            def from_environment_or_default(cls, *, s3_client=None, _store=store):
                return _store

        monkeypatch.setattr(read_api, "S3VideoRankingStore", _StoreClass)
        monkeypatch.setattr(read_api, "holodex_get", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no Holodex call")))

        response = _recent(creatorId=creator.creator_id)

        assert _ids(response, "videos") == ["a"], creator.creator_id
        # ...and being served does not make them collectable or pollable.
        assert is_content_collection_eligible(creator) is False, creator.creator_id
        assert is_live_status_polling_eligible(creator) is False, creator.creator_id


# --- 6. empty / not ready / invalid ----------------------------------------------------------------------


def test_a_valid_combination_with_no_matches_is_an_empty_response_not_an_error(monkeypatch):
    _wire(monkeypatch, {"emma": [_row("a", "sf6", kind="upload")]})

    recent = _recent(topic="minecraft", contentType="live", liveStatus="archived")
    ranking = _ranking(metric="7d", topic="minecraft", contentType="live", liveStatus="archived")

    assert recent["videos"] == [] and recent["hasMore"] is False
    assert ranking["rows"] == []


def test_a_creator_with_no_stored_result_is_not_ready(monkeypatch):
    _wire(monkeypatch, {"subaru": [_row("a", "sf6", creator_id="subaru")]})

    with pytest.raises(read_api.RankingNotReadyError):
        _recent(creatorId="emma")
    with pytest.raises(read_api.RankingNotReadyError):
        _ranking(creatorId="emma")


@pytest.mark.parametrize(
    "query",
    [
        {"topic": "fortnite"},
        {"contentType": "short"},
        {"sort": "random"},
        {"sort": 5},
        {"liveStatus": "ended"},
        {"creatorId": "nobody"},
    ],
)
def test_invalid_values_are_client_errors_on_the_recent_endpoint(monkeypatch, query):
    _wire(monkeypatch, {"emma": [_row("a", "sf6")]})

    with pytest.raises(read_api.ClientError):
        _recent(**query)


@pytest.mark.parametrize("query", [{"topic": "fortnite"}, {"contentType": "short"}, {"metric": "90d"}, {"liveStatus": "ended"}])
def test_invalid_values_are_client_errors_on_the_ranking_endpoint(monkeypatch, query):
    _wire(monkeypatch, {"emma": [_row("a", "sf6")]})

    with pytest.raises(read_api.ClientError):
        _ranking(**query)


def test_sort_and_topic_are_case_insensitive_like_the_other_enums(monkeypatch):
    _wire(monkeypatch, {"emma": [_row("a", "sf6", published="2026-09-01T00:00:00Z"), _row("b", "sf6", published="2026-09-02T00:00:00Z")]})

    assert _ids(_recent(sort="OLDEST", topic="SF6"), "videos") == ["a", "b"]

def _handler_event(route_suffix: str, **query) -> dict:
    return {
        "routeKey": f"GET /creators/{{creatorId}}/videos/{route_suffix}",
        "pathParameters": {"creatorId": "emma"},
        "queryStringParameters": {"reportDate": REPORT_DATE, **query},
    }


def test_through_the_lambda_handler_topic_content_type_live_status_and_sort_reach_both_endpoints(monkeypatch):
    import json

    _wire(
        monkeypatch,
        {
            "emma": [
                _row("old", "sf6", kind="stream", published="2026-08-01T00:00:00Z"),
                _row("new", "sf6", kind="stream", published="2026-09-01T00:00:00Z", current=5),
                _row("now", "sf6", kind="live", published="2026-09-30T00:00:00Z"),
                _row("clip", "sf6", kind="upload", published="2026-09-15T00:00:00Z"),
                _row("valo", "valorant", kind="stream", published="2026-09-10T00:00:00Z"),
            ]
        },
    )
    query = {"topic": "sf6", "contentType": "live", "liveStatus": "archived"}

    recent = api_handler.lambda_handler(_handler_event("recent", sort="oldest", **query), None)
    ranking = api_handler.lambda_handler(_handler_event("ranking", metric="total", **query), None)

    assert recent["statusCode"] == 200 and ranking["statusCode"] == 200
    recent_body, ranking_body = json.loads(recent["body"]), json.loads(ranking["body"])
    assert [v["videoId"] for v in recent_body["videos"]] == ["old", "new"]  # true oldest-first; live-now dropped
    assert recent_body["sort"] == "oldest" and recent_body["topic"] == "sf6"
    assert [r["videoId"] for r in ranking_body["rows"]] == ["old", "new"]  # 1000 views then 5; same filtered set
    assert ranking_body["liveStatus"] == "archived"

    bad = api_handler.lambda_handler(_handler_event("recent", sort="sideways"), None)
    assert bad["statusCode"] == 400
