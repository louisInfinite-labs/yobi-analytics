"""Tests for api.read_api.get_oshi_status (GET /creators/{creatorId}/oshi-status): Home's Oshi
Status panel read model over the per-creator S3 video-ranking result."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest

from api import api_handler, read_api
from tracking.creator_master import Creator

NOW = datetime(2026, 10, 1, 3, 0, 0, tzinfo=timezone.utc)
REPORT_DATE = "2026-10-01"


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
    *,
    content_type: str | None = "upload",
    live_status: str | None = None,
    current: int = 1000,
    anchor_1d: int | None = None,
    anchor_7d: int | None = None,
    anchor_30d: int | None = None,
    published: str | None = "2026-09-30T00:00:00Z",
    title: str | None = None,
    creator_id: str = "aizawa_ema",
) -> dict:
    return {
        "videoId": video_id,
        "creatorId": creator_id,
        "topic": "other",
        "contentType": content_type,
        "liveStatus": live_status,
        "currentViewCount": current,
        "anchor1dViewCount": anchor_1d,
        "anchor7dViewCount": anchor_7d,
        "anchor30dViewCount": anchor_30d,
        "title": title or f"title {video_id}",
        "thumbnailUrl": None,
        "publishedAt": published,
        "discoveredAt": "2026-09-01T00:00:00Z",
    }


def _payload(rows: list[dict], *, creator_id: str = "aizawa_ema", report_date: str = REPORT_DATE) -> dict:
    return {
        "schemaVersion": 2,
        "reportDate": report_date,
        "creatorId": creator_id,
        "generatedAt": f"{report_date}T18:05:00+09:00",
        "videos": rows,
    }


class _FakeStore:
    def __init__(self, payloads: dict[tuple[str, str], dict | None]):
        self.payloads = payloads
        self.reads: list[tuple[str, str]] = []

    def read_result(self, report_date: date, creator_id: str):
        self.reads.append((report_date.isoformat(), creator_id))
        return self.payloads.get((report_date.isoformat(), creator_id))


class _FakeSubscriberStore:
    def __init__(self, payloads: dict[str, dict | None], *, error: Exception | None = None):
        self.payloads = payloads
        self.error = error
        self.reads: list[str] = []

    def read_result(self, report_date: date):
        self.reads.append(report_date.isoformat())
        if self.error is not None:
            raise self.error
        return self.payloads.get(report_date.isoformat())


def _wire_subscribers(monkeypatch, payloads=None, *, error: Exception | None = None):
    """Fake the daily subscriber-leaderboard store (default: nothing persisted -> subscriberCount null).

    Always installed by _wire so a test can never reach a real S3 client, whatever YOBI_HISTORY_BUCKET is set to.
    """
    store = _FakeSubscriberStore(payloads or {}, error=error)

    class _StoreClass:
        @classmethod
        def from_environment_or_default(cls, *, s3_client=None):
            return store

    monkeypatch.setattr(read_api, "S3SubscriberRankingStore", _StoreClass)
    return store


def _subscriber_result(rows: dict[str, int], *, report_date: str = REPORT_DATE) -> dict:
    """A persisted subscriber-ranking result: `total.rows` for `rows`, plus growth sections that must never leak out."""
    total_rows = [
        {"rank": rank, "creatorId": creator_id, "organization": "vspo", "subscriberCount": count}
        for rank, (creator_id, count) in enumerate(sorted(rows.items(), key=lambda item: -item[1]), start=1)
    ]
    growth_rows = [
        {"rank": 1, "creatorId": creator_id, "organization": "vspo", "currentSubscriberCount": count,
         "anchorSubscriberCount": count - 5, "absoluteGrowth": 5, "percentageGrowth": 0.01}
        for creator_id, count in rows.items()
    ]
    return {
        "reportDate": report_date,
        "generatedAt": f"{report_date}T18:05:00+09:00",
        "total": {"rows": total_rows, "ineligible": {"hidden_creator": "current_hidden"}},
        "7d": {"rows": growth_rows, "ineligible": {}},
    }


def _wire(monkeypatch, payloads) -> _FakeStore:
    store = _FakeStore(payloads)
    _wire_subscribers(monkeypatch)

    class _StoreClass:
        @classmethod
        def from_environment_or_default(cls, *, s3_client=None):
            return store

    monkeypatch.setattr(read_api, "S3VideoRankingStore", _StoreClass)
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator("aizawa_ema"), _creator("other_creator")])

    def _no_external_call(*args, **kwargs):
        raise AssertionError("Oshi status must read only the persisted S3 result")

    monkeypatch.setattr(read_api, "holodex_get", _no_external_call)
    return store


def _wire_rows(monkeypatch, rows: list[dict]) -> _FakeStore:
    return _wire(monkeypatch, {(REPORT_DATE, "aizawa_ema"): _payload(rows)})


def _call(**query):
    base = {"creatorId": "aizawa_ema", "reportDate": REPORT_DATE}
    base.update(query)
    return read_api.get_oshi_status(base, now=NOW)


def _iso(delta: timedelta) -> str:
    return (NOW + delta).isoformat().replace("+00:00", "Z")


# --- latest video ---------------------------------------------------------------------------------


def test_latest_video_is_the_newest_upload_with_only_its_display_fields_and_no_growth(monkeypatch):
    _wire_rows(
        monkeypatch,
        [
            _row("old", published=_iso(timedelta(days=-9)), current=900),
            _row("new", published=_iso(timedelta(days=-1)), current=5000, anchor_1d=4500, anchor_7d=3000, anchor_30d=None),
        ],
    )

    latest = _call()["latestVideo"]

    assert latest == {
        "videoId": "new",
        "title": "title new",
        "thumbnailUrl": None,
        "publishedAt": _iso(timedelta(days=-1)),
        "currentViewCount": 5000,
    }
    # V1 scope: no per-video / latest-video growth, whatever anchors the stored row carries.
    assert not any(key.startswith("growth") for key in latest)


def test_a_newer_livestream_archive_never_becomes_the_latest_video(monkeypatch):
    _wire_rows(
        monkeypatch,
        [
            _row("up", published=_iso(timedelta(days=-5))),
            _row("stream", content_type="live", live_status="completed", published=_iso(timedelta(hours=-2))),
        ],
    )

    result = _call()

    assert result["latestVideo"]["videoId"] == "up"
    assert [item["videoId"] for item in result["recent"]] == ["stream", "up"]


def test_a_newer_short_is_neither_the_latest_video_nor_a_recent_item_nor_counted_as_an_upload(monkeypatch):
    """B18: a Short (contentType="short") is not a normal uploaded video -- Shorts are a future feature."""
    _wire_rows(
        monkeypatch,
        [
            _row("up", published=_iso(timedelta(days=-2))),
            _row("short", content_type="short", published=_iso(timedelta(hours=-3))),
            _row("stream", content_type="live", live_status="completed", published=_iso(timedelta(days=-1))),
        ],
    )

    result = _call()

    assert result["latestVideo"]["videoId"] == "up"
    assert [item["videoId"] for item in result["recent"]] == ["stream", "up"]
    assert result["thisWeek"]["newUploads"] == 1  # only "up"


def test_no_classified_upload_gives_an_explicit_null_latest_video_and_empty_recent(monkeypatch):
    _wire_rows(monkeypatch, [_row("u", content_type=None), _row("s", content_type="live", live_status="upcoming")])

    result = _call()

    assert result["latestVideo"] is None and result["recent"] == []
    assert result["growth"]["1d"] == {"absoluteGrowth": 0, "videoCount": 0}


# --- recent timeline ------------------------------------------------------------------------------


def test_recent_is_newest_first_bounded_deterministic_and_tagged_by_kind(monkeypatch):
    same = _iso(timedelta(days=-2))
    _wire_rows(
        monkeypatch,
        [
            _row("b", published=same),
            _row("a", published=same),
            _row("c", content_type="live", live_status="completed", published=_iso(timedelta(days=-1))),
            _row("d", published=_iso(timedelta(days=-3))),
        ],
    )

    result = _call(recentLimit="3")

    assert [(item["videoId"], item["kind"]) for item in result["recent"]] == [("c", "livestream"), ("a", "upload"), ("b", "upload")]


def test_upcoming_live_and_unclassified_rows_are_not_timeline_items(monkeypatch):
    _wire_rows(
        monkeypatch,
        [
            _row("upcoming", content_type="live", live_status="upcoming"),
            _row("live", content_type="live", live_status="live"),
            _row("unclassified", content_type=None),
            _row("legacy-live-no-status", content_type="live", live_status=None),
            _row("ok"),
        ],
    )

    assert [item["videoId"] for item in _call()["recent"]] == ["ok"]


def test_future_dated_missing_and_unparseable_published_at_rows_are_skipped(monkeypatch):
    _wire_rows(
        monkeypatch,
        [
            _row("future", published=_iso(timedelta(hours=1))),
            _row("none", published=None),
            _row("junk", published="not-a-date"),
            _row("naive", published="2026-09-30T00:00:00"),
            _row("ok", published=_iso(timedelta(hours=-1))),
        ],
    )

    assert [item["videoId"] for item in _call()["recent"]] == ["ok"]


def test_a_duplicate_video_id_is_counted_once(monkeypatch):
    _wire_rows(monkeypatch, [_row("dup", current=10, anchor_1d=0), _row("dup", current=10, anchor_1d=0), _row("x")])

    result = _call(since=_iso(timedelta(days=-3)))

    assert [item["videoId"] for item in result["recent"]].count("dup") == 1
    assert result["sinceLastVisit"]["newUploads"] == 2
    assert result["growth"]["1d"]["videoCount"] == 1  # only "dup" has a 1d anchor, and it counts once


# --- channel growth -------------------------------------------------------------------------------


def test_channel_growth_sums_every_tracked_video_floors_negatives_and_counts_contributors(monkeypatch):
    _wire_rows(
        monkeypatch,
        [
            _row("a", current=150, anchor_1d=100, anchor_7d=100),
            _row("b", content_type="live", live_status="completed", current=300, anchor_1d=250),
            _row("c", content_type="live", live_status="upcoming", current=0, anchor_1d=0),  # counted: it is a tracked video
            _row("dropped", current=90, anchor_1d=100),  # downward correction is not growth
            _row("noanchor", current=500),
        ],
    )

    growth = _call()["growth"]

    assert growth["1d"] == {"absoluteGrowth": 100, "videoCount": 4}  # 50 + 50 + 0 + 0 over four anchored videos
    assert growth["7d"] == {"absoluteGrowth": 50, "videoCount": 1}
    assert growth["30d"] == {"absoluteGrowth": 0, "videoCount": 0}


# --- since last visit -----------------------------------------------------------------------------


def test_since_counts_are_exact_beyond_any_page_size_with_an_exclusive_lower_bound(monkeypatch):
    since = NOW - timedelta(days=2)
    rows = [_row(f"u{i}", published=_iso(timedelta(days=-1, minutes=-i))) for i in range(30)]
    rows += [
        _row("boundary", published=since.isoformat().replace("+00:00", "Z")),  # exactly at `since`: not new
        _row("before", published=_iso(timedelta(days=-3))),
        _row("s1", content_type="live", live_status="completed", published=_iso(timedelta(hours=-5))),
        _row("s-old", content_type="live", live_status="completed", published=_iso(timedelta(days=-4))),
    ]
    _wire_rows(monkeypatch, rows)

    block = _call(since=since.isoformat().replace("+00:00", "Z"))["sinceLastVisit"]

    assert (block["newUploads"], block["newStreams"], block["clamped"]) == (30, 1, False)


def test_without_since_the_block_is_null(monkeypatch):
    _wire_rows(monkeypatch, [_row("a")])

    assert _call()["sinceLastVisit"] is None


def test_since_older_than_the_lookback_bound_is_clamped_and_reported(monkeypatch):
    _wire_rows(monkeypatch, [_row("recent", published=_iso(timedelta(days=-10))), _row("ancient", published=_iso(timedelta(days=-60)))])

    block = _call(since="2020-01-01T00:00:00Z")["sinceLastVisit"]

    assert block["clamped"] is True
    assert block["since"] == (NOW - timedelta(days=read_api.OSHI_STATUS_MAX_LOOKBACK_DAYS)).isoformat()
    assert block["newUploads"] == 1  # the 60-day-old video is outside the bounded lookback


def test_since_in_the_future_is_treated_as_now_not_an_error(monkeypatch):
    _wire_rows(monkeypatch, [_row("a", published=_iso(timedelta(hours=-1)))])

    block = _call(since=_iso(timedelta(days=1)))["sinceLastVisit"]

    assert block["newUploads"] == 0 and block["since"] == NOW.isoformat() and block["clamped"] is False


def test_since_accepts_an_explicit_offset(monkeypatch):
    _wire_rows(monkeypatch, [_row("a", published=_iso(timedelta(hours=-2)))])

    # "a" was published 01:00Z; 09:00+09:00 is 00:00Z (before it), 10:00+09:00 is 01:00Z (exactly at it: exclusive).
    assert _call(since="2026-10-01T09:00:00+09:00")["sinceLastVisit"]["newUploads"] == 1
    assert _call(since="2026-10-01T10:00:00+09:00")["sinceLastVisit"]["newUploads"] == 0


@pytest.mark.parametrize("bad", ["yesterday", "2026-09-30", "2026-09-30T12:00:00", "x" * 100, "12345"])
def test_malformed_or_offsetless_since_is_a_client_error(monkeypatch, bad):
    _wire_rows(monkeypatch, [_row("a")])

    with pytest.raises(read_api.ClientError):
        _call(since=bad)


# --- parameters, isolation, not-ready ------------------------------------------------------------


@pytest.mark.parametrize("bad", ["0", "-1", "11", "abc", "1.5"])
def test_invalid_recent_limit_is_a_client_error(monkeypatch, bad):
    _wire_rows(monkeypatch, [_row("a")])

    with pytest.raises(read_api.ClientError):
        _call(recentLimit=bad)


def test_recent_limit_defaults_to_six(monkeypatch):
    _wire_rows(monkeypatch, [_row(f"v{i}", published=_iso(timedelta(hours=-i - 1))) for i in range(9)])

    assert len(_call()["recent"]) == read_api.OSHI_STATUS_RECENT_DEFAULT_LIMIT == 6


def test_unknown_or_missing_creator_id_is_a_client_error(monkeypatch):
    _wire_rows(monkeypatch, [_row("a")])

    with pytest.raises(read_api.ClientError):
        _call(creatorId="nobody")
    with pytest.raises(read_api.ClientError):
        read_api.get_oshi_status({"reportDate": REPORT_DATE}, now=NOW)


def test_another_creators_rows_and_object_are_never_used(monkeypatch):
    store = _wire(
        monkeypatch,
        {
            (REPORT_DATE, "aizawa_ema"): _payload(
                [_row("mine"), _row("leaked", creator_id="other_creator", current=9_999_999, anchor_1d=0)]
            ),
            (REPORT_DATE, "other_creator"): _payload([_row("theirs", creator_id="other_creator")], creator_id="other_creator"),
        },
    )

    result = _call()

    assert [item["videoId"] for item in result["recent"]] == ["mine"]
    assert result["growth"]["1d"]["videoCount"] == 0  # the leaked row's growth is not summed either
    assert store.reads == [(REPORT_DATE, "aizawa_ema")]


def test_a_missing_result_is_not_ready_and_an_older_report_date_within_the_lookback_is_used(monkeypatch):
    _wire(monkeypatch, {})
    with pytest.raises(read_api.RankingNotReadyError):
        read_api.get_oshi_status({"creatorId": "aizawa_ema"}, now=NOW)

    store = _wire(monkeypatch, {("2026-09-30", "aizawa_ema"): _payload([_row("a")], report_date="2026-09-30")})
    monkeypatch.setattr(read_api, "_today_in_canonical_time_zone", lambda: date(2026, 10, 1))

    result = read_api.get_oshi_status({"creatorId": "aizawa_ema"}, now=NOW)

    assert result["reportDate"] == "2026-09-30" and store.reads[0] == ("2026-10-01", "aizawa_ema")


# --- payload minimization --------------------------------------------------------------------------


def test_the_response_exposes_only_bounded_ui_fields_and_no_raw_anchors_or_history(monkeypatch):
    _wire_rows(monkeypatch, [_row(f"v{i}", current=100, anchor_1d=50, anchor_7d=40, anchor_30d=10) for i in range(30)])

    result = _call(since=_iso(timedelta(days=-5)), recentLimit="10")

    assert set(result) == {
        "reportDate", "generatedAt", "creatorId", "subscriberCount", "latestVideo", "thisWeek", "growth", "recent", "sinceLastVisit"
    }
    assert set(result["latestVideo"]) == {"videoId", "title", "thumbnailUrl", "publishedAt", "currentViewCount"}
    assert set(result["recent"][0]) == {"videoId", "kind", "title", "thumbnailUrl", "publishedAt", "currentViewCount"}
    assert len(result["recent"]) == 10  # bounded regardless of how many videos the creator has
    assert set(result["growth"]) == {"1d", "7d", "30d"}
    assert "anchor" not in repr(result).lower() and "discoveredAt" not in repr(result)


# --- routing -----------------------------------------------------------------------------------------


def test_the_route_is_registered_and_forwards_the_path_and_query_parameters(monkeypatch):
    assert "GET /creators/{creatorId}/oshi-status" in api_handler._ROUTES
    captured = {}
    monkeypatch.setattr(read_api, "get_oshi_status", lambda params: captured.update(params) or {"ok": True})

    response = api_handler._ROUTES["GET /creators/{creatorId}/oshi-status"](
        {"pathParameters": {"creatorId": "aizawa_ema"}, "queryStringParameters": {"since": "2026-09-30T00:00:00Z", "creatorId": "ignored"}}
    )

    assert response == {"ok": True}
    assert captured == {"creatorId": "aizawa_ema", "since": "2026-09-30T00:00:00Z"}  # the path parameter wins


def _event(**query):
    return {
        "routeKey": "GET /creators/{creatorId}/oshi-status",
        "pathParameters": {"creatorId": "aizawa_ema"},
        "queryStringParameters": {"reportDate": REPORT_DATE, **query},
    }


def test_through_the_lambda_handler_a_bad_since_is_400_a_missing_result_is_503_and_a_good_request_is_200(monkeypatch):
    import json

    _wire_rows(monkeypatch, [_row("a", published="2026-09-30T00:00:00Z")])

    bad = api_handler.lambda_handler(_event(since="yesterday"), None)
    ok = api_handler.lambda_handler(_event(since="2026-09-29T00:00:00Z"), None)
    assert bad["statusCode"] == 400
    assert ok["statusCode"] == 200 and json.loads(ok["body"])["creatorId"] == "aizawa_ema"

    _wire(monkeypatch, {})  # nothing persisted for any date
    not_ready = api_handler.lambda_handler(_event(), None)
    assert not_ready["statusCode"] == 503 and json.loads(not_ready["body"])["code"] == "RANKING_NOT_READY"


def test_this_week_counts_the_fixed_seven_day_window_independent_of_since(monkeypatch):
    _wire_rows(
        monkeypatch,
        [
            _row("u-in", published=_iso(timedelta(days=-6))),
            _row("u-edge", published=_iso(timedelta(days=-7))),  # exactly 7 days ago: exclusive, not counted
            _row("u-out", published=_iso(timedelta(days=-8))),
            _row("s-in", content_type="live", live_status="completed", published=_iso(timedelta(days=-1))),
            _row("s-upcoming", content_type="live", live_status="upcoming", published=_iso(timedelta(days=-1))),
        ],
    )

    without_since = _call()
    with_since = _call(since=_iso(timedelta(hours=-1)))

    assert without_since["thisWeek"] == {"newUploads": 1, "newStreams": 1}
    assert with_since["thisWeek"] == without_since["thisWeek"]  # `since` only drives sinceLastVisit
    assert with_since["sinceLastVisit"]["newUploads"] == 0


def test_recent_only_ever_carries_content_activity_never_milestone_or_growth_events(monkeypatch):
    # Rows with huge growth must not synthesize any milestone/growth timeline entry (out of V1 scope).
    _wire_rows(
        monkeypatch,
        [
            _row("big", current=2_000_000, anchor_1d=100, anchor_7d=100, anchor_30d=100, published=_iso(timedelta(days=-3))),
            _row("stream", content_type="live", live_status="completed", published=_iso(timedelta(days=-1))),
        ],
    )

    result = _call(since=_iso(timedelta(days=-10)))

    assert {item["kind"] for item in result["recent"]} <= {"upload", "livestream"}
    assert [item["videoId"] for item in result["recent"]] == ["stream", "big"]  # exactly the two real videos, no extras
    assert all(set(item) == {"videoId", "kind", "title", "thumbnailUrl", "publishedAt", "currentViewCount"} for item in result["recent"])
    assert "milestone" not in repr(result).lower()
    assert result["growth"]["1d"]["absoluteGrowth"] > 0  # channel-level growth is unaffected


# --- subscriber count (reuses the daily subscriber-leaderboard result) ------------------------------


def test_subscriber_count_is_this_creators_current_count_from_the_subscriber_result(monkeypatch):
    _wire_rows(monkeypatch, [_row("a")])
    _wire_subscribers(monkeypatch, {REPORT_DATE: _subscriber_result({"aizawa_ema": 123_456, "other_creator": 999_999})})

    result = _call()

    assert result["subscriberCount"] == 123_456
    assert type(result["subscriberCount"]) is int


def test_subscriber_count_is_isolated_per_creator(monkeypatch):
    _wire(
        monkeypatch,
        {
            (REPORT_DATE, "aizawa_ema"): _payload([_row("a")]),
            (REPORT_DATE, "other_creator"): _payload([_row("b", creator_id="other_creator")], creator_id="other_creator"),
        },
    )
    _wire_subscribers(monkeypatch, {REPORT_DATE: _subscriber_result({"aizawa_ema": 111, "other_creator": 222})})

    assert _call(creatorId="aizawa_ema")["subscriberCount"] == 111
    assert _call(creatorId="other_creator")["subscriberCount"] == 222


def test_a_hidden_or_missing_subscriber_count_is_null_not_zero_and_not_an_older_days_number(monkeypatch):
    _wire_rows(monkeypatch, [_row("a")])
    # Newest result has no total row for this creator (hidden / collection gap); an older day still has one.
    store = _wire_subscribers(
        monkeypatch,
        {
            REPORT_DATE: _subscriber_result({"other_creator": 5}),
            "2026-09-30": _subscriber_result({"aizawa_ema": 777}, report_date="2026-09-30"),
        },
    )
    monkeypatch.setattr(read_api, "_today_in_canonical_time_zone", lambda: date(2026, 10, 1))

    # No explicit reportDate: the lookback makes the older day a real candidate, so this proves it is NOT used.
    result = read_api.get_oshi_status({"creatorId": "aizawa_ema"}, now=NOW)

    assert result["subscriberCount"] is None
    assert store.reads == [REPORT_DATE]  # the newest result decided; no fallback to the stale day


def test_no_subscriber_result_yet_gives_null_and_the_rest_of_the_response_is_intact(monkeypatch):
    _wire_rows(monkeypatch, [_row("a")])

    not_computed = _call()  # _wire's default: nothing persisted

    assert not_computed["subscriberCount"] is None
    assert not_computed["latestVideo"]["videoId"] == "a"
    assert [item["videoId"] for item in not_computed["recent"]] == ["a"]


def test_an_unreadable_subscriber_result_degrades_to_null_without_failing_or_leaking_error_text(monkeypatch, capsys):
    _wire_rows(monkeypatch, [_row("a")])
    _wire_subscribers(monkeypatch, error=RuntimeError("AccessDenied arn:aws:iam::123456789012:user/SENTINEL-IAM-USER"))

    result = _call()

    assert result["subscriberCount"] is None and result["latestVideo"]["videoId"] == "a"
    out = capsys.readouterr().out
    assert "RuntimeError" in out and "SENTINEL-IAM-USER" not in out and "123456789012" not in out


def test_the_latest_available_subscriber_result_within_the_lookback_is_used(monkeypatch):
    _wire_rows(monkeypatch, [_row("a")])
    monkeypatch.setattr(read_api, "_today_in_canonical_time_zone", lambda: date(2026, 10, 1))
    store = _wire_subscribers(monkeypatch, {"2026-09-30": _subscriber_result({"aizawa_ema": 4242}, report_date="2026-09-30")})

    result = read_api.get_oshi_status({"creatorId": "aizawa_ema"}, now=NOW)  # no explicit reportDate

    assert result["subscriberCount"] == 4242 and store.reads == ["2026-10-01", "2026-09-30"]


def test_no_raw_subscriber_history_or_growth_data_reaches_the_response(monkeypatch):
    _wire_rows(monkeypatch, [_row("a")])
    _wire_subscribers(monkeypatch, {REPORT_DATE: _subscriber_result({"aizawa_ema": 500, "other_creator": 900})})

    result = _call()

    text = repr(result)
    assert "currentSubscriberCount" not in text and "anchorSubscriberCount" not in text
    assert "ineligible" not in text and "other_creator" not in text and "900" not in text
    assert set(result) >= {"subscriberCount"} and not isinstance(result["subscriberCount"], (list, dict))
