from search.video_search import search_creator_video_rows, video_matches_query
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
    """`topic_ids` is always caller-SUPPLIED here (the frontend's own local resolution against GET
    /topics, see frontend/dashboard/src/features/video-search/model/topicResolution.ts) -- this module
    no longer resolves a query to topic ids itself, so these tests pass topic_ids directly rather than
    deriving them from a query string."""

    def test_matches_direct_title_substring(self):
        row = _row("v1", "3Dモデルお披露目")
        assert video_matches_query(row, normalize_query("3D"), frozenset())

    def test_matches_topic_even_when_title_does_not_contain_query_text(self):
        row = _row("v1", "ヴァロラント配信 #12", topic="valorant")
        assert video_matches_query(row, normalize_query("VALO"), frozenset({"valorant"}))

    def test_does_not_match_when_neither_title_nor_topic_apply(self):
        row = _row("v1", "雑談配信", topic="chatting")
        assert not video_matches_query(row, normalize_query("minecraft"), frozenset())

    def test_a_row_with_no_topic_can_only_match_by_title(self):
        row = _row("v1", "untitled stream", topic=None)
        assert not video_matches_query(row, normalize_query("VALO"), frozenset({"valorant"}))

    def test_empty_query_never_matches_even_with_real_topic_ids_supplied(self):
        """Defensive rule, unchanged by the frontend-resolved-topics refactor: an empty/whitespace-only
        query must never behave like "match everything" -- including the new case of a caller sending
        non-empty topic_ids alongside an empty q, which a legitimate frontend request never does (an
        empty query resolves to zero topic ids on the frontend too, see topicResolution.ts), but a
        malformed/direct API call might."""
        row = _row("v1", "anything", topic="valorant")
        assert not video_matches_query(row, "", frozenset({"valorant"}))

    def test_an_unknown_topic_id_matches_nothing_but_does_not_raise(self):
        row = _row("v1", "anything", topic="valorant")
        assert not video_matches_query(row, normalize_query("zzz"), frozenset({"not_a_real_topic"}))


class TestSearchCreatorVideoRowsUnionSemantics:
    """Core product rule (Video Search final architecture): direct-title matches UNION topic matches,
    evaluated unconditionally and combined, never a fallback where one suppresses the other."""

    def test_a_title_only_match(self):
        rows = [_row("v1", "SF6 ランクマ", topic="chatting", published_at="2026-01-01")]
        assert [r["videoId"] for r in search_creator_video_rows(rows, raw_query="SF6", topic_ids=frozenset())] == ["v1"]

    def test_a_topic_only_match(self):
        rows = [_row("v1", "今日の配信", topic="valorant", published_at="2026-01-01")]
        result = search_creator_video_rows(rows, raw_query="VALO", topic_ids=frozenset({"valorant"}))
        assert [r["videoId"] for r in result] == ["v1"]

    def test_same_video_matching_both_title_and_topic_is_returned_exactly_once(self):
        """FIXTURE-ONLY canonical id ("monster_hunter" does not exist in the real backend taxonomy --
        tracking.video_topics.TOPICS) used purely to exercise the generic UNION/dedupe mechanics, which
        this module implements as a single per-row OR check (never two separately built lists that need
        a later videoId dedupe pass) -- see this module's own docstring."""
        rows = [
            _row("a", "XX Monster Collection XX", topic="chatting", published_at="2026-01-01"),  # title match only
            _row("b", "狩獵直播 #15", topic="monster_hunter", published_at="2026-01-02"),  # topic match only
            _row("c", "Monster Hunter World #3", topic="monster_hunter", published_at="2026-01-03"),  # both
        ]
        result = search_creator_video_rows(rows, raw_query="monster", topic_ids=frozenset({"monster_hunter"}))
        ids = [r["videoId"] for r in result]
        assert sorted(ids) == ["a", "b", "c"]
        assert ids.count("c") == 1  # matched by both sources, appears once

    def test_multiple_resolved_topic_ids_are_all_unioned(self):
        """FIXTURE-ONLY ids, same reasoning as above: the real 8-topic set is disjoint per query (no
        single real query resolves to two different real topics simultaneously), so multi-id union can
        only be demonstrated generically."""
        rows = [
            _row("a", "unrelated title", topic="topic_x", published_at="2026-01-01"),
            _row("b", "unrelated title", topic="topic_y", published_at="2026-01-02"),
            _row("c", "unrelated title", topic="topic_z", published_at="2026-01-03"),
        ]
        result = search_creator_video_rows(rows, raw_query="zz", topic_ids=frozenset({"topic_x", "topic_y"}))
        assert {r["videoId"] for r in result} == {"a", "b"}

    def test_no_resolved_topic_ids_direct_title_search_still_works(self):
        rows = [_row("v1", "funny moment compilation", published_at="2026-01-01"), _row("v2", "unrelated", published_at="2026-01-02")]
        result = search_creator_video_rows(rows, raw_query="funny moment", topic_ids=frozenset())
        assert [r["videoId"] for r in result] == ["v1"]

    def test_an_unknown_topic_id_does_not_break_direct_title_search(self):
        rows = [_row("v1", "Minecraft建築", topic="minecraft", published_at="2026-01-01")]
        result = search_creator_video_rows(rows, raw_query="minecraft", topic_ids=frozenset({"not_a_real_topic"}))
        assert [r["videoId"] for r in result] == ["v1"]

    def test_filter_sort_applies_to_the_combined_union_not_to_either_source_independently(self):
        rows = [
            _row("a", "SF6 live", topic="chatting", content_type="live", published_at="2026-01-01"),  # title match, live
            _row("b", "unrelated", topic="sf6", content_type="upload", published_at="2026-01-02"),  # topic match, upload
        ]
        result = search_creator_video_rows(rows, raw_query="sf6", topic_ids=frozenset({"sf6"}), content_type="live")
        assert [r["videoId"] for r in result] == ["a"]  # the topic-only match ("b") is filtered out by contentType, same as a title match would be

    def test_current_creator_isolation_is_unaffected_by_union_semantics(self):
        """search_creator_video_rows still assumes `rows` is already scoped to one creator (the caller's
        job, exactly as before, see _row's own fixed "creator-1") -- union semantics do not change that
        contract; it still never re-checks or re-scopes by creator itself."""
        rows = [_row("v1", "Minecraft", topic="minecraft", published_at="2026-01-01")]
        result = search_creator_video_rows(rows, raw_query="minecraft", topic_ids=frozenset({"minecraft"}))
        assert {r["creatorId"] for r in result} == {"creator-1"}


class TestSearchCreatorVideoRows:
    def test_direct_title_match_sf6(self):
        rows = [_row("v1", "SF6 ランクマ", published_at="2026-01-01"), _row("v2", "Minecraft建築", published_at="2026-01-02")]
        result = search_creator_video_rows(rows, raw_query="SF6")
        assert [r["videoId"] for r in result] == ["v1"]

    def test_topic_keyword_match_without_title_overlap(self):
        rows = [
            _row("v1", "今日のバロラント", topic="valorant", published_at="2026-01-01"),
            _row("v2", "Minecraft建築", topic="minecraft", published_at="2026-01-02"),
        ]
        result = search_creator_video_rows(rows, raw_query="VALO", topic_ids=frozenset({"valorant"}))
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

    def test_search_has_no_topic_tag_parameter_at_all(self):
        """Video Tag/Topic SELECTION is never a parameter here -- `topic_ids` is query-derived, a
        completely different concept; Search always considers every topic regardless of the selected Tag."""
        import inspect

        assert "topic" not in inspect.signature(search_creator_video_rows).parameters
