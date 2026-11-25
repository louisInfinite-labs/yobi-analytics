"""F37 Phase 0: the actual livestream start is exposed by the existing API without breaking current consumers -- /videos/recent rows carry
`actualStartAt` only when stored, and the overlay of just-completed streams carries the lifecycle probe's verified start."""

from __future__ import annotations

from datetime import date

from api import read_api
from tracking.creator_master import Creator

REPORT_DATE = "2026-10-27"
START = "2026-10-14T14:50:07+00:00"


def _creator() -> Creator:
    return Creator(
        creator_id="emma", display_name="emma", organization="vspo", youtube_channel_id="UC_emma", active=True, branch="vspo_jp",
        group_key=["1"], channel_type="member", lifecycle_stage="active", display_order=0,
    )


def _row(video_id: str, **extra) -> dict:
    row = {
        "videoId": video_id, "creatorId": "emma", "topic": "chatting", "contentType": "live", "liveStatus": "completed", "currentViewCount": 5,
        "title": "t " + video_id, "thumbnailUrl": None, "publishedAt": "2026-10-14T16:10:00Z", "discoveredAt": None,
    }
    row.update(extra)
    return row


def _wire(monkeypatch, rows: list[dict]) -> None:
    payload = {"schemaVersion": 2, "reportDate": REPORT_DATE, "creatorId": "emma", "generatedAt": f"{REPORT_DATE}T18:05:00+09:00", "videos": rows}

    class _Store:
        def read_result(self, report_date: date, creator_id: str):
            return payload

    class _StoreClass:
        @classmethod
        def from_environment_or_default(cls, *, s3_client=None):
            return _Store()

    monkeypatch.setattr(read_api, "S3VideoRankingStore", _StoreClass)
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])


def _recent(**extra) -> list[dict]:
    return read_api.get_recent_creator_videos({"creatorId": "emma", "reportDate": REPORT_DATE, "limit": "20", **extra})["videos"]


def test_recent_rows_expose_the_start_next_to_the_unchanged_published_date(monkeypatch):
    """A stored start is returned as actualStartAt, and publishedAt keeps its own (different JST) date."""
    _wire(monkeypatch, [_row("a", actualStartAt=START)])

    [row] = _recent()

    assert row["actualStartAt"] == START
    assert row["publishedAt"] == "2026-10-14T16:10:00Z"


def test_recent_rows_without_a_stored_start_have_no_key_at_all(monkeypatch):
    """Backward compatibility: results written before the field existed (and rows with no start) keep their exact old shape."""
    _wire(monkeypatch, [_row("old")])

    [row] = _recent()

    assert "actualStartAt" not in row
    assert set(row) >= {"videoId", "title", "publishedAt", "contentType", "currentViewCount"}


def test_old_and_new_rows_mix_without_loss(monkeypatch):
    """A result with both kinds of rows returns every row and every pre-existing field."""
    _wire(monkeypatch, [_row("new", actualStartAt=START), _row("old", publishedAt="2026-10-13T00:00:00Z")])

    rows = {r["videoId"]: r for r in _recent()}

    assert set(rows) == {"new", "old"} and "actualStartAt" not in rows["old"] and rows["old"]["publishedAt"] == "2026-10-13T00:00:00Z"


def _archive(**facts) -> dict:
    base = {"videoId": "n1", "title": "Fresh", "publishedAt": "2026-10-14T16:10:00Z", "actualEndTime": "2026-10-15T01:00:00Z", "availableAt": "2026-10-15T01:20:00+00:00", "viewCount": 9}
    base.update(facts)
    return base


def _overlay(monkeypatch, rows, archives):
    monkeypatch.setattr(read_api, "_read_available_archives", lambda creator_id: archives)
    monkeypatch.setattr(read_api, "discovery_times_for", lambda ids: {})
    return read_api._with_verified_completed_streams(rows, "emma")


def test_overlay_adds_the_probes_verified_start_to_a_stream_missing_from_the_catalog(monkeypatch):
    """A just-completed stream not yet in the daily result carries the lifecycle probe's start (normalized UTC), never publishedAt."""
    [row] = _overlay(monkeypatch, [], [_archive(actualStartTime="2026-10-14T14:50:07Z")])

    assert row["actualStartAt"] == START and row["liveStatus"] == "completed" and row["publishedAt"] == "2026-10-14T16:10:00Z"


def test_overlay_without_a_start_adds_no_key_and_never_substitutes_published_at(monkeypatch):
    """YouTube gave no actualStartTime: the overlay row has no actualStartAt (and nothing derived from publishedAt/scheduled)."""
    [row] = _overlay(monkeypatch, [], [_archive(scheduledStartTime="2026-10-14T15:00:00Z")])

    assert "actualStartAt" not in row


def test_overlay_fills_a_stale_catalog_row_but_never_replaces_its_stored_start(monkeypatch):
    """A stale upcoming catalog row gets the verified start; a row that already has one keeps it."""
    stale = _row("n1", liveStatus="upcoming")
    [patched] = _overlay(monkeypatch, [stale], [_archive(actualStartTime="2026-10-14T14:50:07Z")])
    assert patched["actualStartAt"] == START

    kept = _row("n1", liveStatus="live", actualStartAt="2026-10-14T14:40:00+00:00")
    [patched] = _overlay(monkeypatch, [kept], [_archive(actualStartTime="2026-10-14T14:50:07Z")])
    assert patched["actualStartAt"] == "2026-10-14T14:40:00+00:00"


def test_overlay_never_gives_a_premiere_an_actual_start(monkeypatch):
    """A completed Premiere is an upload published at its start: it stays dated by publishedAt (no actualStartAt)."""
    premiere = _archive(publishedAt="2026-10-14T14:50:02Z", actualStartTime="2026-10-14T14:50:00Z", actualEndTime="2026-10-14T14:54:00Z")

    [row] = _overlay(monkeypatch, [], [premiere])

    assert row["contentType"] == "upload" and "actualStartAt" not in row
