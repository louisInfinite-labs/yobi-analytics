"""GET /creators/{creatorId}/videos/search: Video Search over one creator's COMPLETE persisted video
catalog (never a paginated "recent" subset), via read_api.get_creator_video_search. Mirrors
tests/api/test_home_oshi_videos_api.py's own fixture shape (same _Store/_wire pattern), since this
endpoint reads from the exact same S3VideoRankingStore per-creator result."""

from __future__ import annotations

import json

from datetime import date

import pytest

from api import api_handler, read_api
from api.read_api import ClientError
from tracking.creator_master import Creator

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
    title: str,
    topic: str | None = None,
    *,
    creator_id: str = "emma",
    content_type: str | None = "upload",
    current: int = 1000,
    anchors: tuple[int | None, int | None, int | None] = (None, None, None),
    published: str | None = "2026-09-01T00:00:00Z",
) -> dict:
    return {
        "videoId": video_id,
        "creatorId": creator_id,
        "topic": topic,
        "contentType": content_type,
        "liveStatus": None,
        "currentViewCount": current,
        "anchor1dViewCount": anchors[0],
        "anchor7dViewCount": anchors[1],
        "anchor30dViewCount": anchors[2],
        "title": title,
        "thumbnailUrl": None,
        "publishedAt": published,
        "discoveredAt": None,
    }


def _payload(rows: list[dict], creator_id: str = "emma") -> dict:
    return {"schemaVersion": 2, "reportDate": REPORT_DATE, "creatorId": creator_id, "generatedAt": f"{REPORT_DATE}T18:05:00+09:00", "videos": rows}


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


def _search(**query) -> dict:
    base = {"creatorId": "emma", "reportDate": REPORT_DATE}
    base.update(query)
    return read_api.get_creator_video_search(base)


def _ids(response: dict) -> list[str]:
    return [item["videoId"] for item in response["videos"]]


class TestVideoSearchApiContract:
    def test_requires_q(self, monkeypatch):
        _wire(monkeypatch, {"emma": [_row("v1", "title")]})
        with pytest.raises(ClientError):
            _search()

    def test_rejects_an_unknown_creator(self, monkeypatch):
        _wire(monkeypatch, {"emma": [_row("v1", "title")]})
        with pytest.raises(ClientError):
            _search(creatorId="not-a-real-creator", q="title")

    def test_response_shape_echoes_the_query_and_applied_filters(self, monkeypatch):
        _wire(monkeypatch, {"emma": [_row("v1", "Minecraft part 1", topic="minecraft")]})
        response = _search(q="minecraft")
        assert response["query"] == "minecraft"
        assert response["creatorId"] == "emma"
        assert response["contentType"] == "all"
        assert "topic" not in response  # Video Tag/Topic is never part of this endpoint's contract

    def test_an_empty_query_returns_zero_videos_never_the_whole_catalog(self, monkeypatch):
        """Explicit defensive proof (Search-session cache follow-up, sections 9/30/46): an empty q must
        never behave like "no filter" -- a creator's whole catalog must never come back for q=""."""
        _wire(monkeypatch, {"emma": [_row("v1", "a"), _row("v2", "b", topic="minecraft"), _row("v3", "c", topic="chatting")]})
        response = _search(q="")
        assert response["videos"] == []

    def test_a_whitespace_only_query_also_returns_zero_videos(self, monkeypatch):
        _wire(monkeypatch, {"emma": [_row("v1", "a"), _row("v2", "b")]})
        assert _search(q="   ")["videos"] == []

    def test_each_video_still_carries_its_persisted_topic_as_a_display_field_only(self, monkeypatch):
        """`topic` stays in the response shape (an existing field) but plays no part in matching -- see TestVideoSearchMatching."""
        _wire(monkeypatch, {"emma": [_row("v1", "今日のバロラント配信", topic="valorant")]})
        response = _search(q="バロラント")
        assert response["videos"][0]["topic"] == "valorant"
        assert "matchedTopicAliases" not in response["videos"][0]

    def test_a_query_with_no_terms_still_does_plain_direct_title_matching(self, monkeypatch):
        _wire(monkeypatch, {"emma": [_row("v1", "3Dモデルお披露目", topic="chatting")]})
        response = _search(q="3D")
        assert _ids(response) == ["v1"]

    def test_the_response_has_no_pagination_fields_at_all(self, monkeypatch):
        """Search-session cache follow-up (product correction): this endpoint returns EVERY matching
        video in one response -- there is no limit/offset/hasMore contract to check before a frontend
        caller may treat a response as complete."""
        _wire(monkeypatch, {"emma": [_row("v1", "Minecraft part 1", topic="minecraft")]})
        response = _search(q="minecraft")
        assert "hasMore" not in response
        assert "limit" not in response
        assert "offset" not in response

    def test_a_limit_or_offset_query_parameter_is_simply_ignored_not_honored(self, monkeypatch):
        """There is nothing left in this endpoint's signature to parse `limit`/`offset` into -- a caller
        that still sends one (e.g. a stale client) gets the same complete result set regardless."""
        rows = [_row(f"v{i}", f"Minecraft {i}", topic="minecraft") for i in range(5)]
        _wire(monkeypatch, {"emma": rows})
        assert len(_search(q="minecraft", limit="2", offset="1")["videos"]) == 5

    def test_a_result_set_far_larger_than_the_old_100_item_page_size_still_returns_in_one_complete_response(self, monkeypatch):
        """250 matching videos -- more than the previous VIDEO_SEARCH_DEFAULT_LIMIT=100 and the previous
        VIDEO_SEARCH_MAX_LIMIT=200 both -- all come back in the one response, proving there is no
        remaining truncation anywhere in this path."""
        rows = [_row(f"v{i}", f"Minecraft {i}", topic="minecraft") for i in range(250)]
        _wire(monkeypatch, {"emma": rows})
        response = _search(q="minecraft")
        assert len(response["videos"]) == 250
        assert {v["videoId"] for v in response["videos"]} == {f"v{i}" for i in range(250)}


class TestVideoSearchMatching:
    def test_direct_title_match(self, monkeypatch):
        _wire(monkeypatch, {"emma": [_row("v1", "3Dモデルお披露目"), _row("v2", "雑談配信", topic="chatting")]})
        assert _ids(_search(q="3D")) == ["v1"]

    def test_birth_finds_a_title_containing_the_expanded_japanese_term(self, monkeypatch):
        """The frontend resolves "birth" against the catalog (English label Birthday) and sends the concept's LITERAL labels/aliases as
        `terms`; the backend only checks titles."""
        _wire(monkeypatch, {"emma": [_row("v1", "今日は誕生日配信", topic=None), _row("v2", "unrelated", topic="誕生日")]})
        assert _ids(_search(q="birth", terms=json.dumps(["birthday", "誕生日", "誕生日配信"], ensure_ascii=False))) == ["v1"]

    def test_the_same_result_with_no_persisted_topic_or_a_wrong_one(self, monkeypatch):
        rows = [_row("a", "誕生日の日", topic=None), _row("b", "誕生日の夜", topic="minecraft"), _row("c", "誕生日の朝", topic="誕生日")]
        _wire(monkeypatch, {"emma": rows})
        assert set(_ids(_search(q="birth", terms=json.dumps(["誕生日"], ensure_ascii=False)))) == {"a", "b", "c"}

    def test_a_video_is_not_returned_solely_because_its_persisted_topic_matches(self, monkeypatch):
        _wire(monkeypatch, {"emma": [_row("v1", "全く別の配信", topic="誕生日")]})
        assert _ids(_search(q="birth", terms=json.dumps(["birthday", "誕生日"], ensure_ascii=False))) == []

    def test_the_old_topicids_parameter_is_ignored_not_honored(self, monkeypatch):
        _wire(monkeypatch, {"emma": [_row("v1", "今日の配信アーカイブ", topic="valorant")]})
        assert _ids(_search(q="VALO", topicIds="valorant")) == []  # an old client: title-only, never a persisted-topic match
        assert _ids(_search(q="配信", topicIds="valorant")) == ["v1"]

    def test_a_raw_query_that_resolved_nothing_still_searches_titles(self, monkeypatch):
        _wire(monkeypatch, {"emma": [_row("v1", "funny moment compilation", topic="chatting")]})
        assert _ids(_search(q="funny moment")) == ["v1"]
        assert _ids(_search(q="funny moment", terms="[]")) == ["v1"]

    def test_duplicate_and_equivalent_terms_do_not_create_duplicate_results(self, monkeypatch):
        _wire(monkeypatch, {"emma": [_row("v1", "誕生日 birthday")]})
        terms = json.dumps(["誕生日", "誕生日", " 誕生日 ", "birthday", "BIRTHDAY", "ｂｉｒｔｈｄａｙ"], ensure_ascii=False)
        assert _ids(_search(q="birth", terms=terms)) == ["v1"]

    def test_normalization_is_nfkc_and_case_insensitive_for_the_query_and_the_terms(self, monkeypatch):
        _wire(monkeypatch, {"emma": [_row("v1", "ＡＢＣ Stream"), _row("v2", "plain TERM here")]})
        assert set(_ids(_search(q="abc"))) == {"v1"}
        assert set(_ids(_search(q="zz", terms=json.dumps(["ａｂｃ", "term"])))) == {"v1", "v2"}

    def test_a_term_may_contain_a_comma(self, monkeypatch):
        _wire(monkeypatch, {"emma": [_row("v1", "a,b collab"), _row("v2", "a b collab")]})
        assert _ids(_search(q="zz", terms=json.dumps(["a,b"]))) == ["v1"]

    def test_an_empty_query_with_terms_still_returns_zero_videos(self, monkeypatch):
        _wire(monkeypatch, {"emma": [_row("v1", "anything", topic="valorant")]})
        assert _search(q="", terms=json.dumps(["anything"]))["videos"] == []

    def test_terms_must_be_a_json_array_of_bounded_strings(self, monkeypatch):
        _wire(monkeypatch, {"emma": [_row("v1", "anything")]})
        for bad in ("not json", '{"a": 1}', "[1, 2]", "[" + ",".join(['"a"'] * 101) + "]", json.dumps(["x" * 101])):
            with pytest.raises(read_api.ClientError):
                _search(q="anything", terms=bad)

    def test_no_match_returns_an_empty_list_not_an_error(self, monkeypatch):
        _wire(monkeypatch, {"emma": [_row("v1", "Minecraft part 1", topic="minecraft")]})
        response = _search(q="completely unrelated query")
        assert response["videos"] == []

    def test_never_fuzzy_matches_a_typo(self, monkeypatch):
        _wire(monkeypatch, {"emma": [_row("v1", "Minecraft part 1", topic="minecraft")]})
        assert _search(q="minceraft")["videos"] == []


class TestVideoSearchIsScopedToCurrentCreatorAndCompleteDataset:
    def test_never_returns_another_creators_videos(self, monkeypatch):
        _wire(
            monkeypatch,
            {
                "emma": [_row("emma-1", "Minecraft stream", topic="minecraft")],
                "subaru": [_row("subaru-1", "Minecraft stream", topic="minecraft", creator_id="subaru")],
            },
        )
        assert _ids(_search(q="minecraft")) == ["emma-1"]

    def test_searches_the_whole_persisted_catalog_not_only_a_small_recent_page(self, monkeypatch):
        """50 unrelated videos plus one real match scattered deep in the catalog (oldest of the set, so a
        'recent N' style page would miss it) -- Search must still find it, proving it isn't silently
        limited to whatever a small paginated endpoint would have returned."""
        rows = [_row(f"filler-{i}", f"filler title {i}", topic="chatting", published=f"2026-0{1 + i % 9}-01T00:00:00Z") for i in range(50)]
        rows.append(_row("needle", "Minecraft deep in the catalog", topic="minecraft", published="2025-01-01T00:00:00Z"))
        _wire(monkeypatch, {"emma": rows})
        assert _ids(_search(q="minecraft")) == ["needle"]

    def test_search_has_no_video_tag_topic_parameter_to_narrow_by(self, monkeypatch):
        """There is no `topic` query parameter on this endpoint at all -- Video Tag/Topic selection can
        never narrow a Search request, which is what actually enforces 'Search ignores the Video Tag'."""
        import inspect

        assert "topic" not in inspect.signature(read_api.get_creator_video_search).parameters


class TestVideoSearchExistingFilterSortRemainsActive:
    def test_content_type_filter_remains_active_during_search(self, monkeypatch):
        _wire(
            monkeypatch,
            {
                "emma": [
                    _row("v1", "Minecraft upload", topic="minecraft", content_type="upload"),
                    _row("v2", "Minecraft live", topic="minecraft", content_type="live"),
                ]
            },
        )
        assert _ids(_search(q="minecraft", contentType="live")) == ["v2"]

    def test_newest_sort_remains_active_during_search(self, monkeypatch):
        _wire(
            monkeypatch,
            {
                "emma": [
                    _row("v1", "Minecraft part 1", topic="minecraft", published="2026-01-01T00:00:00Z"),
                    _row("v2", "Minecraft part 2", topic="minecraft", published="2026-01-03T00:00:00Z"),
                ]
            },
        )
        assert _ids(_search(q="minecraft", sort="newest")) == ["v2", "v1"]

    def test_oldest_sort_remains_active_during_search(self, monkeypatch):
        _wire(
            monkeypatch,
            {
                "emma": [
                    _row("v1", "Minecraft part 1", topic="minecraft", published="2026-01-01T00:00:00Z"),
                    _row("v2", "Minecraft part 2", topic="minecraft", published="2026-01-03T00:00:00Z"),
                ]
            },
        )
        assert _ids(_search(q="minecraft", sort="oldest")) == ["v1", "v2"]

    def test_most_views_sort_remains_active_during_search(self, monkeypatch):
        _wire(
            monkeypatch,
            {
                "emma": [
                    _row("v1", "Minecraft part 1", topic="minecraft", current=100),
                    _row("v2", "Minecraft part 2", topic="minecraft", current=900),
                ]
            },
        )
        assert _ids(_search(q="minecraft", sort="mostViews", metric="total")) == ["v2", "v1"]

    def test_exclude_shorts_defaults_to_true_matching_the_alls_tag_definition(self, monkeypatch):
        _wire(
            monkeypatch,
            {
                "emma": [
                    _row("v1", "Minecraft short", topic="minecraft", content_type="short"),
                    _row("v2", "Minecraft video", topic="minecraft", content_type="upload"),
                ]
            },
        )
        assert _ids(_search(q="minecraft")) == ["v2"]


class TestVideoSearchApiRouting:
    def test_the_route_is_wired_to_the_search_handler(self):
        assert api_handler._ROUTES["GET /creators/{creatorId}/videos/search"] is api_handler._handle_get_creator_video_search
