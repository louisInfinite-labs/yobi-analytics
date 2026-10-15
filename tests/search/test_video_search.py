from search.video_search import normalize_terms, search_creator_video_rows, video_matches_query
from search.query_normalization import normalize_query


def _row(video_id, title, topic=None, content_type=None, live_status=None, view_count=0, published_at=None, **extra):
    row = {
        "videoId": video_id,
        "creatorId": "creator-1",
        "title": title,
        "topic": topic,
        "contentType": content_type,
        "liveStatus": live_status,
        "currentViewCount": view_count,
        "publishedAt": published_at,
    }
    row.update(extra)
    return row


class TestVideoMatchesQuery:
    """SearchView is TITLE-ONLY: a row's persisted `topic` is never read. `terms` are the literal strings the frontend expanded from the
    query against the Topic Catalog (already normalized here the way search.video_search.normalize_terms produces them)."""

    def test_matches_direct_title_substring(self):
        row = _row("v1", "3Dモデルお披露目")
        assert video_matches_query(row, normalize_query("3D"))

    def test_matches_when_the_title_contains_an_expanded_term(self):
        row = _row("v1", "今日は誕生日配信です")
        assert video_matches_query(row, normalize_query("birth"), frozenset({"birthday", "誕生日"}))

    def test_does_not_match_when_neither_the_query_nor_any_term_is_in_the_title(self):
        row = _row("v1", "雑談配信", topic="chatting")
        assert not video_matches_query(row, normalize_query("minecraft"), frozenset({"マイクラ"}))

    def test_a_row_with_no_topic_is_found_by_an_expanded_title_term(self):
        row = _row("v1", "【3D】お披露目", topic=None)
        assert video_matches_query(row, normalize_query("3d live"), frozenset({"お披露目"}))

    def test_the_persisted_topic_never_decides_a_match(self):
        """A video tagged with the topic whose terms were sent, but whose title contains neither the query nor any term, is NOT a match."""
        row = _row("v1", "全然関係ないタイトル", topic="誕生日")
        assert not video_matches_query(row, normalize_query("birth"), frozenset({"birthday", "誕生日"}))

    def test_a_wrong_or_unrelated_persisted_topic_does_not_hide_a_title_match(self):
        row = _row("v1", "誕生日配信", topic="minecraft")
        assert video_matches_query(row, normalize_query("birth"), frozenset({"誕生日"}))

    def test_empty_query_never_matches_even_with_terms_supplied(self):
        """Defensive rule: an empty/whitespace-only query must never behave like "match everything"."""
        row = _row("v1", "anything")
        assert not video_matches_query(row, "", frozenset({"anything"}))

    def test_a_term_that_matches_nothing_is_harmless(self):
        row = _row("v1", "anything")
        assert not video_matches_query(row, normalize_query("zzz"), frozenset({"not in any title"}))

    def test_matching_is_nfkc_and_case_insensitive_on_the_title_side_too(self):
        row = _row("v1", "ＳＦ６ ランクマ")  # full-width title
        assert video_matches_query(row, normalize_query("sf6"))
        assert video_matches_query(_row("v2", "SF6 live"), normalize_query("ｓｆ６"))


class TestNormalizeTerms:
    def test_terms_are_normalized_blank_dropped_and_deduplicated(self):
        assert normalize_terms(["ＡＢＣ", "abc", "", "   ", " ABC ", "誕生日", "誕生日"]) == frozenset({"abc", "誕生日"})

    def test_internal_whitespace_collapses_like_the_query(self):
        assert normalize_terms(["3d   birthday  live"]) == frozenset({"3d birthday live"})


class TestSearchCreatorVideoRowsTitleOnly:
    """SearchView: title contains the raw query OR any expanded term -- never the persisted topic."""

    def test_a_title_only_match(self):
        rows = [_row("v1", "SF6 ランクマ", topic="chatting", published_at="2026-01-01")]
        assert [r["videoId"] for r in search_creator_video_rows(rows, raw_query="SF6")] == ["v1"]

    def test_birth_finds_a_title_containing_the_japanese_term_through_expansion(self):
        rows = [
            _row("a", "今日は誕生日配信！", topic=None, published_at="2026-01-01"),  # no persisted topic at all
            _row("b", "お誕生日おめでとう", topic="minecraft", published_at="2026-01-02"),  # a wrong persisted topic
            _row("c", "Happy Birthday stream", topic=None, published_at="2026-01-03"),  # the English term
            _row("d", "全然関係ない配信", topic="誕生日", published_at="2026-01-04"),  # tagged, but no title match
        ]
        result = search_creator_video_rows(rows, raw_query="birth", terms=["birthday", "誕生日", "誕生日配信"])
        assert sorted(r["videoId"] for r in result) == ["a", "b", "c"]  # "d" is not returned just because its topic is 誕生日

    def test_a_video_never_matches_solely_because_its_topic_matches(self):
        rows = [_row("v1", "今日の配信アーカイブ", topic="valorant", published_at="2026-01-01")]
        assert search_creator_video_rows(rows, raw_query="VALO", terms=["valorant", "valo", "バロラント"]) == []

    def test_a_query_that_resolved_nothing_still_searches_the_raw_title(self):
        rows = [_row("v1", "funny moment compilation", published_at="2026-01-01"), _row("v2", "unrelated", published_at="2026-01-02")]
        assert [r["videoId"] for r in search_creator_video_rows(rows, raw_query="funny moment", terms=())] == ["v1"]

    def test_duplicate_and_equivalent_terms_do_not_duplicate_results(self):
        rows = [_row("v1", "誕生日 birthday 誕生日配信", published_at="2026-01-01")]
        terms = ["誕生日", "誕生日", " 誕生日 ", "birthday", "BIRTHDAY", "ｂｉｒｔｈｄａｙ", "誕生日配信"]
        result = search_creator_video_rows(rows, raw_query="birth", terms=terms)
        assert [r["videoId"] for r in result] == ["v1"]  # one row, once

    def test_a_video_matching_both_the_raw_query_and_a_term_is_returned_once(self):
        rows = [_row("v1", "Birthday 誕生日", published_at="2026-01-01")]
        assert len(search_creator_video_rows(rows, raw_query="birthday", terms=["誕生日"])) == 1

    def test_terms_are_normalized_nfkc_and_case_insensitive(self):
        rows = [_row("v1", "ABC Stream", published_at="2026-01-01"), _row("v2", "ｗｏｒｄ ＴＥＲＭ", published_at="2026-01-02")]
        assert {r["videoId"] for r in search_creator_video_rows(rows, raw_query="zz", terms=["ａｂｃ", "Term"])} == {"v1", "v2"}

    def test_a_term_containing_a_comma_is_a_single_literal_term(self):
        rows = [_row("v1", "a,b collab", published_at="2026-01-01"), _row("v2", "a b collab", published_at="2026-01-02")]
        assert [r["videoId"] for r in search_creator_video_rows(rows, raw_query="zz", terms=["a,b"])] == ["v1"]

    def test_filter_sort_applies_to_the_title_matched_result(self):
        rows = [
            _row("a", "SF6 live", content_type="live", published_at="2026-01-01"),
            _row("b", "ストリートファイター6 upload", content_type="upload", published_at="2026-01-02"),
        ]
        result = search_creator_video_rows(rows, raw_query="sf6", terms=["ストリートファイター6"], content_type="live")
        assert [r["videoId"] for r in result] == ["a"]

    def test_current_creator_isolation_is_unaffected(self):
        rows = [_row("v1", "Minecraft", topic="minecraft", published_at="2026-01-01")]
        assert {r["creatorId"] for r in search_creator_video_rows(rows, raw_query="minecraft", terms=["マイクラ"])} == {"creator-1"}


class TestSearchCreatorVideoRows:
    def test_direct_title_match_sf6(self):
        rows = [_row("v1", "SF6 ランクマ", published_at="2026-01-01"), _row("v2", "Minecraft建築", published_at="2026-01-02")]
        result = search_creator_video_rows(rows, raw_query="SF6")
        assert [r["videoId"] for r in result] == ["v1"]

    def test_no_match_returns_empty_list(self):
        rows = [_row("v1", "完全に無関係なタイトル", topic="chatting")]
        assert search_creator_video_rows(rows, raw_query="minecraft") == []

    def test_never_fuzzy_matches_a_typo(self):
        rows = [_row("v1", "Minecraft建築", topic="minecraft")]
        assert search_creator_video_rows(rows, raw_query="minceraft") == []

    def test_existing_newest_sort_semantics_apply_to_search_results(self):
        rows = [
            _row("v1", "Minecraft part 1", topic="minecraft", published_at="2026-01-01"),
            _row("v2", "Minecraft part 2", topic="minecraft", published_at="2026-01-03"),
            _row("v3", "Minecraft part 3", topic="minecraft", published_at="2026-01-02"),
        ]
        result = search_creator_video_rows(rows, raw_query="minecraft", sort="newest")
        assert [r["videoId"] for r in result] == ["v2", "v3", "v1"]

    def test_existing_oldest_sort_semantics_apply_to_search_results(self):
        rows = [
            _row("v1", "Minecraft part 1", topic="minecraft", published_at="2026-01-01"),
            _row("v2", "Minecraft part 2", topic="minecraft", published_at="2026-01-03"),
        ]
        result = search_creator_video_rows(rows, raw_query="minecraft", sort="oldest")
        assert [r["videoId"] for r in result] == ["v1", "v2"]

    def test_existing_most_views_metric_semantics_apply_to_search_results(self):
        rows = [
            _row("v1", "Minecraft part 1", topic="minecraft", view_count=100, published_at="2026-01-01"),
            _row("v2", "Minecraft part 2", topic="minecraft", view_count=500, published_at="2026-01-02"),
        ]
        result = search_creator_video_rows(rows, raw_query="minecraft", sort="mostViews", metric="total")
        assert [r["videoId"] for r in result] == ["v2", "v1"]

    def test_most_views_growth_metric_excludes_rows_with_no_anchor_for_that_period(self):
        rows = [
            _row("v1", "Minecraft part 1", topic="minecraft", view_count=100, anchor1dViewCount=50),
            _row("v2", "Minecraft part 2", topic="minecraft", view_count=500, anchor1dViewCount=None),
        ]
        result = search_creator_video_rows(rows, raw_query="minecraft", sort="mostViews", metric="1d")
        assert [r["videoId"] for r in result] == ["v1"]

    def test_content_type_filter_still_applies_during_search(self):
        rows = [
            _row("v1", "Minecraft upload", topic="minecraft", content_type="upload"),
            _row("v2", "Minecraft livestream", topic="minecraft", content_type="live"),
        ]
        result = search_creator_video_rows(rows, raw_query="minecraft", content_type="live")
        assert [r["videoId"] for r in result] == ["v2"]

    def test_exclude_shorts_defaults_to_true(self):
        rows = [
            _row("v1", "Minecraft short", topic="minecraft", content_type="short"),
            _row("v2", "Minecraft video", topic="minecraft", content_type="upload"),
        ]
        result = search_creator_video_rows(rows, raw_query="minecraft")
        assert [r["videoId"] for r in result] == ["v2"]

    def test_exclude_shorts_false_includes_shorts(self):
        rows = [_row("v1", "Minecraft short", topic="minecraft", content_type="short")]
        result = search_creator_video_rows(rows, raw_query="minecraft", exclude_shorts=False)
        assert [r["videoId"] for r in result] == ["v1"]

    def test_search_has_no_topic_parameter_of_any_kind(self):
        """Neither the selected Video Tag nor any persisted topic id can reach the matcher: the only vocabulary parameter is `terms`."""
        import inspect

        parameters = inspect.signature(search_creator_video_rows).parameters
        assert "topic" not in parameters and "topic_ids" not in parameters and "terms" in parameters
