"""Unit tests for collection.history_worker._select_classification_due_ids: the extra videos observed each day so
contentType/liveStatus reach the manifest (unclassified catch-up, bounded per shard) and so an upcoming/live stream is
re-checked daily until it completes."""

from __future__ import annotations

import pytest

from collection import history_worker
from collection.history_worker import _classification_incomplete, _select_classification_due_ids
from tracking.tracking_manifest import ManifestEntry


def _entry(video_id, published_at, *, content_type=None, live_status=None) -> ManifestEntry:
    return ManifestEntry(
        video_id, "c1", True, published_at=published_at, activity_state="Cold", content_type=content_type, live_status=live_status
    )


def test_unclassified_entries_are_selected_newest_published_first_within_the_budget(monkeypatch):
    monkeypatch.setattr(history_worker, "UNCLASSIFIED_OBSERVATION_BUDGET_PER_SHARD", 2)
    entries = [
        _entry("old", "2020-01-01T00:00:00Z"),
        _entry("newest", "2026-09-01T00:00:00Z"),
        _entry("middle", "2024-01-01T00:00:00Z"),
    ]

    assert _select_classification_due_ids(entries, already_due=set()) == {"newest", "middle"}


def test_classified_entries_are_never_selected_for_catch_up():
    entries = [
        _entry("upload", "2020-01-01T00:00:00Z", content_type="upload"),
        _entry("archive", "2020-01-02T00:00:00Z", content_type="live", live_status="completed"),
    ]

    assert _select_classification_due_ids(entries, already_due=set()) == set()


def test_upcoming_and_live_streams_are_always_selected_even_when_classified_and_beyond_the_budget(monkeypatch):
    monkeypatch.setattr(history_worker, "UNCLASSIFIED_OBSERVATION_BUDGET_PER_SHARD", 0)
    entries = [
        _entry("upcoming", "2020-01-01T00:00:00Z", content_type="live", live_status="upcoming"),
        _entry("live", "2020-01-02T00:00:00Z", content_type="live", live_status="live"),
        _entry("done", "2020-01-03T00:00:00Z", content_type="live", live_status="completed"),
    ]

    assert _select_classification_due_ids(entries, already_due=set()) == {"upcoming", "live"}


def test_already_due_videos_do_not_consume_the_budget(monkeypatch):
    monkeypatch.setattr(history_worker, "UNCLASSIFIED_OBSERVATION_BUDGET_PER_SHARD", 1)
    entries = [
        _entry("due_today", "2026-09-01T00:00:00Z"),
        _entry("next_newest", "2026-08-01T00:00:00Z"),
        _entry("older", "2020-01-01T00:00:00Z"),
    ]

    assert _select_classification_due_ids(entries, already_due={"due_today"}) == {"next_newest"}


def test_ties_and_missing_published_at_are_deterministic(monkeypatch):
    monkeypatch.setattr(history_worker, "UNCLASSIFIED_OBSERVATION_BUDGET_PER_SHARD", 2)
    entries = [
        _entry("a", "2024-01-01T00:00:00Z"),
        _entry("b", "2024-01-01T00:00:00Z"),
        _entry("undated", None),
    ]

    # Equal publishedAt breaks ties by videoId descending; an undated entry sorts last, never ahead of a dated one.
    assert _select_classification_due_ids(entries, already_due=set()) == {"a", "b"}


@pytest.mark.parametrize(
    ("content_type", "live_status", "incomplete"),
    [
        (None, None, True),  # never observed (every legacy row)
        (None, "completed", True),  # a liveStatus alone is not a classification
        ("live", None, True),  # a livestream whose lifecycle is unknown
        ("upload", None, False),  # a plain upload: liveStatus is None BY DESIGN, so this is COMPLETE
        ("live", "completed", False),
        ("live", "upcoming", False),
        ("live", "live", False),
    ],
)
def test_classification_incomplete_covers_every_contenttype_livestatus_combination(content_type, live_status, incomplete):
    assert _classification_incomplete(_entry("v", "2020-01-01T00:00:00Z", content_type=content_type, live_status=live_status)) is incomplete


def test_incomplete_livestream_and_stray_live_status_are_selected_but_a_classified_upload_is_not():
    entries = [
        _entry("live_no_status", "2020-01-01T00:00:00Z", content_type="live"),
        _entry("status_no_type", "2020-01-02T00:00:00Z", live_status="completed"),
        _entry("classified_upload", "2020-01-03T00:00:00Z", content_type="upload"),
        _entry("classified_archive", "2020-01-04T00:00:00Z", content_type="live", live_status="completed"),
    ]

    assert _select_classification_due_ids(entries, already_due=set()) == {"live_no_status", "status_no_type"}
