"""F37 Phase 0: the completion lifecycle persists YouTube's verified actualStartTime (from the SAME probe that confirms the end) inside its existing
Video Master completion write. Reuses the lifecycle test harness (moto DynamoDB, counted Holodex/YouTube)."""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone

from stores.dynamodb_store import load_videos
from stores.dynamodb_store import upsert_videos as upsert_dynamo_videos
from tests.tracking.test_livestream_lifecycle import (  # noqa: F401  (fixtures + helpers of the existing lifecycle tests)
    _live_then_vanish,
    _probe,
    dynamo,
    world,
)
from tracking.video_master import Video

JST = timezone(timedelta(hours=9))


def _master(video_id="v1") -> Video:
    [video] = [v for v in load_videos() if v.video_id == video_id]
    return video


def test_completion_persists_the_probes_actual_start_in_the_same_cycle(world):
    """The ended stream's actualStartTime lands on Video Master with liveStatus=completed; nothing else changes."""
    before = _master()
    world.probes = {"v1": _probe(actualStartTime="2026-10-15T09:05:00Z", publishedAt="2026-10-15T13:00:00Z")}

    summary = _live_then_vanish(world)

    assert summary["confirmedCompleted"] == ["v1"]
    after = _master()
    assert after.live_status == "completed"
    assert after.actual_start_at == "2026-10-15T09:05:00+00:00"
    assert (after.title, after.published_at, after.topic, after.content_type) == (before.title, before.published_at, before.topic, before.content_type)


def test_the_stored_instant_keeps_its_utc_precision_and_a_different_jst_date_than_publishedAt(world):
    """Started 23:50 JST on the 14th, archive published 01:10 JST on the 15th: the stored start keeps the 14th; Video Master's publishedAt is untouched."""
    before = _master()
    started, published = "2026-10-14T14:50:07Z", "2026-10-14T16:10:00Z"
    world.probes = {"v1": _probe(actualStartTime=started, publishedAt=published)}

    _live_then_vanish(world)

    video = _master()
    start = datetime.fromisoformat(video.actual_start_at)
    assert start.isoformat() == "2026-10-14T14:50:07+00:00"
    assert start.astimezone(JST).date().isoformat() == "2026-10-14"
    assert datetime.fromisoformat(published.replace("Z", "+00:00")).astimezone(JST).date().isoformat() == "2026-10-15"  # the two JST dates differ
    assert video.published_at == before.published_at  # the probe's publishedAt is never written over the master's


def test_a_missing_actual_start_is_never_filled_from_another_timestamp(world):
    """YouTube reports no actualStartTime: the field stays unset even though scheduled/published times are known."""
    world.probes = {"v1": _probe(scheduledStartTime="2026-10-15T09:00:00Z", publishedAt="2026-10-15T09:00:00Z")}

    _live_then_vanish(world)

    video = _master()
    assert video.live_status == "completed" and video.actual_start_at is None


def test_an_already_stored_start_survives_the_completion_update(world):
    """A start captured earlier (daily run or backfill) is kept; the completion cycle only completes the status."""
    existing = _master()
    upsert_dynamo_videos([replace(existing, actual_start_at="2026-10-15T08:59:00+00:00")])
    world.probes = {"v1": _probe(actualStartTime="2026-10-15T09:05:00Z", publishedAt="2026-10-15T13:00:00Z")}

    _live_then_vanish(world)

    video = _master()
    assert video.actual_start_at == "2026-10-15T08:59:00+00:00" and video.live_status == "completed"


def test_a_completed_premiere_gets_no_actual_start(world):
    """A Premiere is an ordinary video (published at its start): the livestream path records no actualStartAt for it."""
    world.probes = {"v1": _probe(publishedAt="2026-10-15T09:00:02Z", actualStartTime="2026-10-15T09:00:00Z", actualEndTime="2026-10-15T09:04:00Z")}

    _live_then_vanish(world)

    assert _master().actual_start_at is None
