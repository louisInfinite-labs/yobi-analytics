"""Tests for the 1-minute LIVE/UPCOMING display refresh and the freshness-bounded read GET /live-streams uses.

The completion lifecycle (5 minutes, pending candidates, 12 attempts) keeps its own tests in
test_livestream_lifecycle.py; here the point is that it is independent of the display path. As there, only
api.read_api.holodex_get (the HTTP boundary) is mocked, so the real fetch/filter logic runs.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from api import read_api
from api.holodex_client import HolodexAPIError
from tests.tracking.test_livestream_lifecycle import _creator, _holodex_item, dynamo  # noqa: F401 -- shared moto fixture
from tracking import livestream_lifecycle as lifecycle

T0 = datetime(2026, 10, 15, 3, 0, 0, tzinfo=timezone.utc)
REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def _holodex_returns(monkeypatch, *items):
    """Make the Holodex boundary report `items`, counting how many upstream requests are made."""
    calls = {"n": 0}

    def _get(path, params=None):
        calls["n"] += 1
        return list(items)

    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(read_api, "holodex_get", _get)
    return calls


def _holodex_fails(monkeypatch, error):
    """Make every Holodex request raise `error`, counting the attempts."""
    calls = {"n": 0}

    def _get(path, params=None):
        calls["n"] += 1
        raise error

    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(read_api, "holodex_get", _get)
    return calls


def _ids(streams):
    """The videoIds of a stream list."""
    return [stream["videoId"] for stream in streams]


# ============ the reported bug: a new LIVE stream must not wait for the 5-minute cycle ============


def test_a_stream_that_just_went_live_is_served_right_after_a_display_refresh_not_after_the_next_completion_cycle(dynamo, monkeypatch):
    _holodex_returns(monkeypatch)  # nobody live
    lifecycle.refresh_snapshot(now=T0)  # the 5-minute cycle saw OFFLINE at 12:00
    assert lifecycle.read_serving_snapshot(now=T0 + timedelta(seconds=30)) == []

    _holodex_returns(monkeypatch, _holodex_item(video_id="new_live", status="live"))
    summary = lifecycle.refresh_display_snapshot(now=T0 + timedelta(minutes=1))  # one minute later, NOT five

    assert summary == {"refreshed": True, "streamCount": 1}
    assert _ids(lifecycle.read_serving_snapshot(now=T0 + timedelta(minutes=1, seconds=5))) == ["new_live"]


def test_an_upcoming_stream_that_becomes_live_is_reflected_on_the_next_display_refresh(dynamo, monkeypatch):
    upcoming = _holodex_item(video_id="v1", status="upcoming", start_scheduled="2026-10-15T04:00:00Z")
    _holodex_returns(monkeypatch, upcoming)
    lifecycle.refresh_display_snapshot(now=T0)
    [stream] = lifecycle.read_serving_snapshot(now=T0)
    assert stream["status"] == "upcoming"

    _holodex_returns(monkeypatch, _holodex_item(video_id="v1", status="live"))
    lifecycle.refresh_display_snapshot(now=T0 + timedelta(minutes=1))

    [stream] = lifecycle.read_serving_snapshot(now=T0 + timedelta(minutes=1))
    assert stream["status"] == "live"


def test_a_stream_that_ended_leaves_the_display_snapshot_on_the_next_refresh(dynamo, monkeypatch):
    _holodex_returns(monkeypatch, _holodex_item(video_id="v1", status="live"))
    lifecycle.refresh_display_snapshot(now=T0)
    _holodex_returns(monkeypatch)
    lifecycle.refresh_display_snapshot(now=T0 + timedelta(minutes=1))

    assert lifecycle.read_serving_snapshot(now=T0 + timedelta(minutes=1)) == []


# ============ independence from the completion lifecycle ============


def test_the_display_refresh_never_touches_the_completion_snapshot_or_its_pending_candidates(dynamo, monkeypatch):
    _holodex_returns(monkeypatch, _holodex_item(video_id="v1", status="live"))
    lifecycle.refresh_snapshot(now=T0)
    _holodex_returns(monkeypatch)  # v1 dropped -> a completion candidate on the next 5-minute cycle
    lifecycle.refresh_snapshot(now=T0 + timedelta(minutes=5))
    before = lifecycle._read_snapshot_record()
    assert set(before["pendingCandidates"]) == {"v1"}

    _holodex_returns(monkeypatch, _holodex_item(video_id="v9", status="live"))
    for minute in range(1, 5):
        lifecycle.refresh_display_snapshot(now=T0 + timedelta(minutes=5, seconds=minute * 60))

    assert lifecycle._read_snapshot_record() == before  # byte-for-byte: streams, refreshedAt, pending, attempts


def test_the_display_refresh_does_not_verify_or_write_video_master(dynamo, monkeypatch):
    _holodex_returns(monkeypatch, _holodex_item(video_id="v1", status="live"))
    monkeypatch.setattr(lifecycle, "_verify_and_mark_completed", lambda pending: (_ for _ in ()).throw(AssertionError("completion path ran")))

    lifecycle.refresh_display_snapshot(now=T0)


def test_the_completion_cadence_and_retry_window_are_unchanged():
    assert lifecycle._MAX_PENDING_ATTEMPTS == 12  # 12 five-minute cycles ~ 1 hour, NOT shortened by the new 1-minute job
    terraform = (REPO_ROOT / "terraform" / "eventbridge.tf").read_text(encoding="utf-8")
    block = terraform[terraform.index('resource "aws_scheduler_schedule" "livestream_lifecycle_refresh"') :]
    assert 'schedule_expression          = "rate(5 minutes)"' in block.split("\nresource ")[0]


def test_lambda_handler_routes_the_display_event_to_the_display_job_and_anything_else_to_the_completion_job(monkeypatch):
    monkeypatch.setattr(lifecycle, "refresh_display_snapshot", lambda: {"job": "display"})
    monkeypatch.setattr(lifecycle, "refresh_snapshot", lambda: {"job": "completion"})

    assert lifecycle.lambda_handler({"mode": "display"}, None) == {"job": "display"}
    assert lifecycle.lambda_handler({}, None) == {"job": "completion"}
    assert lifecycle.lambda_handler({"source": "aws.scheduler"}, None) == {"job": "completion"}


# ============ upstream request controls ============


def test_a_failed_display_refresh_makes_exactly_one_upstream_request_and_keeps_the_last_good_snapshot(dynamo, monkeypatch):
    _holodex_returns(monkeypatch, _holodex_item(video_id="v1", status="live"))
    lifecycle.refresh_display_snapshot(now=T0)

    calls = _holodex_fails(monkeypatch, HolodexAPIError("upstream 503", status_code=503))
    summary = lifecycle.refresh_display_snapshot(now=T0 + timedelta(minutes=1))

    assert calls["n"] == 1  # no in-run retry: the next minute is the retry
    assert summary == {"refreshed": False, "failures": 1, "cooldownSeconds": 0}
    assert _ids(lifecycle.read_serving_snapshot(now=T0 + timedelta(minutes=1))) == ["v1"]  # untouched, still within bounded age


def test_a_429_starts_a_shared_cooldown_during_which_no_upstream_request_is_made(dynamo, monkeypatch):
    calls = _holodex_fails(monkeypatch, HolodexAPIError("rate limited", status_code=429))
    first = lifecycle.refresh_display_snapshot(now=T0)
    assert first["cooldownSeconds"] == 300 and calls["n"] == 1

    for second in (60, 120, 240, 299):
        skipped = lifecycle.refresh_display_snapshot(now=T0 + timedelta(seconds=second))
        assert skipped["skipped"] == "cooldown"
    assert calls["n"] == 1  # four more scheduled minutes, zero more upstream requests

    lifecycle.refresh_display_snapshot(now=T0 + timedelta(seconds=300))
    assert calls["n"] == 2  # cooldown over -> exactly one probe


def test_consecutive_failures_back_off_exponentially_up_to_a_cap_and_a_success_resets_them(dynamo, monkeypatch):
    _holodex_fails(monkeypatch, HolodexAPIError("boom", status_code=500))
    now, cooldowns = T0, []
    for _ in range(7):
        summary = lifecycle.refresh_display_snapshot(now=now)
        cooldowns.append(summary["cooldownSeconds"])
        now += timedelta(seconds=summary["cooldownSeconds"] or 60)

    assert cooldowns == [0, 0, 120, 240, 480, 600, 600]  # isolated failures are free; then 2/4/8 minutes, capped at 10

    _holodex_returns(monkeypatch, _holodex_item(video_id="v1", status="live"))
    assert lifecycle.refresh_display_snapshot(now=now)["refreshed"] is True
    assert lifecycle._read_record(lifecycle.DISPLAY_SNAPSHOT_KEY)["consecutiveFailures"] == 0
    assert "cooldownUntil" not in lifecycle._read_record(lifecycle.DISPLAY_SNAPSHOT_KEY)


def test_a_missing_api_key_is_one_failed_attempt_not_a_crash(dynamo, monkeypatch):
    from ops.config import MissingHolodexApiKeyError

    calls = _holodex_fails(monkeypatch, MissingHolodexApiKeyError("no key"))

    summary = lifecycle.refresh_display_snapshot(now=T0)

    assert summary["refreshed"] is False and calls["n"] == 1


def test_many_concurrent_reads_never_reach_holodex(dynamo, monkeypatch):
    _holodex_returns(monkeypatch, _holodex_item(video_id="v1", status="live"))
    lifecycle.refresh_display_snapshot(now=T0)

    def _no_upstream(path, params=None):
        raise AssertionError("a /live-streams read must never call Holodex")

    monkeypatch.setattr(read_api, "holodex_get", _no_upstream)
    monkeypatch.setenv("YOBI_STORAGE_BACKEND", "dynamodb")

    for _ in range(200):
        assert _ids(lifecycle.read_serving_snapshot(now=T0 + timedelta(seconds=10))) == ["v1"]


# ============ bounded freshness on the read side ============


def test_read_serving_snapshot_is_none_when_nothing_usable_was_ever_persisted(dynamo):
    assert lifecycle.read_serving_snapshot(now=T0) is None


def test_a_display_record_holding_only_failure_bookkeeping_is_not_a_snapshot(dynamo, monkeypatch):
    _holodex_fails(monkeypatch, HolodexAPIError("boom", status_code=500))
    lifecycle.refresh_display_snapshot(now=T0)  # fails on a brand-new deploy: no streams yet

    assert lifecycle.read_serving_snapshot(now=T0) is None  # -> the API's one-request direct fetch, as before this existed


def test_a_fresh_display_snapshot_is_preferred_over_the_completion_snapshot(dynamo, monkeypatch):
    _holodex_returns(monkeypatch, _holodex_item(video_id="from_completion", status="live"))
    lifecycle.refresh_snapshot(now=T0)
    _holodex_returns(monkeypatch, _holodex_item(video_id="from_display", status="live"))
    lifecycle.refresh_display_snapshot(now=T0 + timedelta(seconds=30))

    assert _ids(lifecycle.read_serving_snapshot(now=T0 + timedelta(seconds=60))) == ["from_display"]


def test_when_the_display_job_is_late_the_fresher_completion_snapshot_is_served(dynamo, monkeypatch):
    _holodex_returns(monkeypatch, _holodex_item(video_id="old_display", status="live"))
    lifecycle.refresh_display_snapshot(now=T0)
    _holodex_returns(monkeypatch, _holodex_item(video_id="completion", status="live"))
    lifecycle.refresh_snapshot(now=T0 + timedelta(minutes=4))

    assert _ids(lifecycle.read_serving_snapshot(now=T0 + timedelta(minutes=4, seconds=30))) == ["completion"]


def test_a_late_display_snapshot_is_still_served_within_the_bounded_age_if_it_is_the_freshest(dynamo, monkeypatch):
    _holodex_returns(monkeypatch, _holodex_item(video_id="v1", status="live"))
    lifecycle.refresh_display_snapshot(now=T0)

    just_inside = T0 + timedelta(seconds=lifecycle.MAX_SNAPSHOT_AGE_SECONDS)
    assert _ids(lifecycle.read_serving_snapshot(now=just_inside)) == ["v1"]


def test_snapshots_older_than_the_bounded_age_are_refused_not_served_as_current(dynamo, monkeypatch):
    _holodex_returns(monkeypatch)  # an all-OFFLINE snapshot that must not be served forever
    lifecycle.refresh_display_snapshot(now=T0)
    lifecycle.refresh_snapshot(now=T0)

    too_old = T0 + timedelta(seconds=lifecycle.MAX_SNAPSHOT_AGE_SECONDS + 1)
    with pytest.raises(lifecycle.LiveSnapshotStaleError):
        lifecycle.read_serving_snapshot(now=too_old)


def test_the_stale_error_is_a_holodex_api_error_so_the_existing_503_mapping_applies():
    assert issubclass(lifecycle.LiveSnapshotStaleError, HolodexAPIError)


def test_a_malformed_snapshot_timestamp_is_treated_as_unusable(dynamo):
    lifecycle._put_display_record({"streams": [], "refreshedAt": "not-a-date"}, T0)

    assert lifecycle.read_serving_snapshot(now=T0) is None


# ============ the HolodexAPIError status carrier ============


def test_holodex_api_error_carries_the_upstream_status_and_defaults_to_none():
    assert HolodexAPIError("x", status_code=429).status_code == 429
    assert HolodexAPIError("x").status_code is None


# ============ infrastructure (static) ============


def test_the_display_schedule_runs_every_minute_against_the_lifecycle_lambda_in_display_mode():
    terraform = (REPO_ROOT / "terraform" / "eventbridge.tf").read_text(encoding="utf-8")
    start = terraform.index('resource "aws_scheduler_schedule" "livestream_display_refresh"')
    following = re.search(r"\nresource ", terraform[start + 10 :])
    block = terraform[start : start + 10 + following.start()] if following else terraform[start:]

    assert 'schedule_expression          = "rate(1 minute)"' in block
    assert "aws_lambda_function.livestream_lifecycle.arn" in block
    assert '\\"mode\\":\\"display\\"' in block
    assert "dead_letter_config" in block
    assert "for_each" not in block
