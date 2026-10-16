"""Tests for tracking.livestream_lifecycle's COMPLETION lifecycle: reuse of the shared display snapshot, ended-stream candidates, end
confirmation, the archive lookup and the persisted ended-stream record.

Only api.read_api.holodex_get (the actual HTTP boundary) is mocked on the Holodex side, so the real fetch/filter logic runs and every
upstream request is counted. YouTube is mocked at collection.youtube_client (get_archive_probe, the one batched call per cycle). The display
refresh's own behavior (write-on-change, heartbeat, cooldown) is covered in test_livestream_display_refresh.py.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import boto3
import pytest
from moto import mock_aws

from api import read_api
from stores.dynamodb_store import CREATOR_ID_INDEX, VIDEO_MASTER_TABLE, load_videos
from stores.dynamodb_store import upsert_videos as upsert_dynamo_videos
from stores.remote_config_store import REMOTE_CONFIG_TABLE
from tracking import livestream_lifecycle as lifecycle
from tracking.creator_master import Creator
from tracking.video_master import Video

REGION = "ap-northeast-1"
CHANNEL_ID = "UC_test"
T0 = datetime(2026, 10, 15, 13, 0, 0, tzinfo=timezone.utc)


@pytest.fixture
def dynamo(aws_credentials):
    """Moto-backed YobiVideoMaster + YobiRemoteConfig, production-shaped (same schema as their own dedicated test files)."""
    with mock_aws():
        client = boto3.client("dynamodb", region_name=REGION)
        client.create_table(
            TableName=VIDEO_MASTER_TABLE,
            AttributeDefinitions=[{"AttributeName": "videoId", "AttributeType": "S"}, {"AttributeName": "creatorId", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "videoId", "KeyType": "HASH"}],
            GlobalSecondaryIndexes=[{"IndexName": CREATOR_ID_INDEX, "KeySchema": [{"AttributeName": "creatorId", "KeyType": "HASH"}], "Projection": {"ProjectionType": "ALL"}}],
            BillingMode="PAY_PER_REQUEST",
        )
        client.create_table(
            TableName=REMOTE_CONFIG_TABLE,
            AttributeDefinitions=[{"AttributeName": "clientId", "AttributeType": "S"}, {"AttributeName": "configKey", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "clientId", "KeyType": "HASH"}, {"AttributeName": "configKey", "KeyType": "RANGE"}],
            GlobalSecondaryIndexes=[{"IndexName": "configKey-index", "KeySchema": [{"AttributeName": "configKey", "KeyType": "HASH"}], "Projection": {"ProjectionType": "ALL"}}],
            BillingMode="PAY_PER_REQUEST",
        )
        lifecycle.reset_ended_cache()
        yield
        lifecycle.reset_ended_cache()


def _creator(**overrides) -> Creator:
    """Creator."""
    fields = {
        "creator_id": "aizawa_ema",
        "display_name": "藍沢エマ",
        "organization": "vspo",
        "youtube_channel_id": CHANNEL_ID,
        "active": True,
        "branch": "vspo_jp",
        "group_key": ["1期生"],
        "channel_type": "member",
        "lifecycle_stage": "active",
        "display_order": 0,
    }
    fields.update(overrides)
    return Creator(**fields)


def _holodex_item(*, video_id="v1", status="live", channel_id=CHANNEL_ID, channel_name="藍沢エマ", **overrides):
    """Holodex item."""
    item = {
        "id": video_id,
        "status": status,
        "channel": {"id": channel_id, "name": channel_name},
        "title": "Test Stream",
        "start_scheduled": "2026-10-16T01:00:00Z" if status == "upcoming" else None,
        "start_actual": "2026-10-15T10:00:00Z" if status == "live" else None,
    }
    item.update(overrides)
    return item


def _video(video_id="v1", *, content_type="live", live_status="live") -> Video:
    """Video."""
    return Video(
        video_id=video_id,
        creator_id="aizawa_ema",
        title="Original Title",
        published_at="2026-09-01T00:00:00Z",
        content_type=content_type,
        live_status=live_status,
    )


def _probe(**overrides):
    """What YouTube reports for an ENDED, publicly playable archive (override fields to vary)."""
    probe = {
        "title": "Test Stream",
        "channelId": CHANNEL_ID,
        "publishedAt": "2026-10-15T09:00:00Z",
        "actualEndTime": "2026-10-15T12:30:00Z",
        "privacyStatus": "public",
        "uploadStatus": "processed",
        "embeddable": True,
        "viewCount": 1234,
    }
    probe.update(overrides)
    return probe


class World:
    """Holodex (counted), YouTube (counted) and the clock, driven a minute at a time like the real schedules."""

    def __init__(self, monkeypatch):
        """Init."""
        self.clock = T0
        self.items: list[dict] = []
        self.holodex_calls = 0
        self.holodex_error: Exception | None = None
        self.probes: dict[str, dict] = {}
        self.probe_calls: list[list[str]] = []
        self.probe_error: Exception | None = None
        monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
        monkeypatch.setattr(read_api, "holodex_get", self._holodex_get)
        monkeypatch.setattr(lifecycle, "_holodex_backoff_seconds", lambda attempt: 0.0)
        monkeypatch.setattr("collection.youtube_client.build_youtube_client", lambda api_key: object())
        monkeypatch.setattr("ops.config.get_api_key", lambda: "fake-key")
        monkeypatch.setattr("collection.youtube_client.get_archive_probe", self._get_probe)

    def _holodex_get(self, path, params=None):
        """Holodex get."""
        self.holodex_calls += 1
        if self.holodex_error is not None:
            raise self.holodex_error
        return list(self.items)

    def _get_probe(self, youtube, video_ids):
        """Get probe."""
        self.probe_calls.append(list(video_ids))
        if self.probe_error is not None:
            raise self.probe_error
        return {video_id: self.probes[video_id] for video_id in video_ids if video_id in self.probes}

    def display(self, minutes=1):
        """One display refresh `minutes` after the previous action."""
        self.clock += timedelta(minutes=minutes)
        return lifecycle.refresh_display_snapshot(now=self.clock)

    def completion(self):
        """One completion cycle at the current time."""
        return lifecycle.refresh_snapshot(now=self.clock)

    def minutes(self, count, *, completion=True):
        """Run `count` minutes of the real schedule: a display refresh each minute and a completion cycle on every fifth."""
        summary = None
        for minute in range(1, count + 1):
            self.display()
            if completion and minute % 5 == 0:
                summary = self.completion()
        return summary

    def ended(self):
        """Ended."""
        lifecycle.reset_ended_cache()
        return lifecycle.read_ended_streams() or {}


@pytest.fixture
def world(dynamo, monkeypatch):
    """World."""
    upsert_dynamo_videos([_video("v1")])
    return World(monkeypatch)


def _live_then_vanish(world, *, status="live", extra_minutes=0):
    """v1 is observed in `status` by a completion cycle, then is gone from Holodex by the next one. Returns that next cycle's summary."""
    world.items = [_holodex_item(video_id="v1", status=status)]
    world.display()
    world.completion()
    world.items = []
    world.clock += timedelta(minutes=5)
    world.display(minutes=0)
    return world.completion()


# ============ PRIORITY 1: the completion cycle reuses the shared display snapshot ============


def test_a_five_minute_window_makes_exactly_five_routine_holodex_requests_not_six(world):
    """A five minute window makes exactly five routine holodex requests not six."""
    world.items = [_holodex_item(video_id="v1", status="live")]

    world.minutes(5)  # five display refreshes and one completion cycle

    assert world.holodex_calls == 5  # the completion cycle added none


def test_the_completion_cycle_reads_the_display_snapshot_and_makes_no_holodex_request(world):
    """The completion cycle reads the display snapshot and makes no holodex request."""
    world.items = [_holodex_item(video_id="v1", status="live")]
    world.display()
    calls_before = world.holodex_calls

    summary = world.completion()

    assert world.holodex_calls == calls_before
    assert summary["refreshed"] is True
    assert summary["streamCount"] == 1
    record = lifecycle._read_snapshot_record()
    assert [stream["videoId"] for stream in record["liveBaseline"]] == ["v1"]
    assert "streams" not in record  # no duplicate copy of the whole snapshot


def test_a_stale_display_snapshot_triggers_one_bounded_holodex_fetch_and_a_backup_copy(world):
    """A stale display snapshot triggers one bounded holodex fetch and a backup copy."""
    world.items = [_holodex_item(video_id="v1", status="live")]
    world.display()
    world.clock += timedelta(seconds=lifecycle.DISPLAY_FRESH_SECONDS + 60)  # the display job has stopped

    summary = world.completion()

    assert world.holodex_calls == 2  # the display refresh + exactly one fallback fetch
    assert summary["refreshed"] is True
    assert [stream["videoId"] for stream in lifecycle.read_snapshot()] == ["v1"]  # backup serving copy, as before


def test_the_fallback_retries_are_bounded_and_a_total_failure_changes_nothing(world):
    """The fallback retries are bounded and a total failure changes nothing."""
    world.items = [_holodex_item(video_id="v1", status="live")]
    world.display()
    world.completion()
    before = lifecycle._read_snapshot_record()
    world.clock += timedelta(minutes=10)  # display stale
    world.holodex_error = lifecycle.HolodexAPIError("persistent outage")
    calls_before = world.holodex_calls

    summary = world.completion()

    assert world.holodex_calls - calls_before == lifecycle._HOLODEX_MAX_ATTEMPTS
    assert summary == {"refreshed": False, "streamCount": 1, "completionCandidates": [], "confirmedCompleted": []}
    assert lifecycle._read_snapshot_record() == before
    assert world.ended() == {}  # an unknown observation never ends a stream


def test_during_a_display_cooldown_the_completion_cycle_skips_without_calling_holodex_or_ending_anything(world):
    """During a display cooldown the completion cycle skips without calling holodex or ending anything."""
    world.items = [_holodex_item(video_id="v1", status="live")]
    world.display()
    world.completion()
    before = lifecycle._read_snapshot_record()
    world.holodex_error = lifecycle.HolodexAPIError("rate limited", status_code=429)
    world.display(minutes=6)  # a 429 -> shared 5-minute cooldown
    calls_before = world.holodex_calls
    world.clock += timedelta(minutes=1)

    summary = world.completion()

    assert world.holodex_calls == calls_before  # the cooldown keeps Holodex alone
    assert summary["skipped"] == "display_cooldown"
    assert lifecycle._read_snapshot_record() == before
    assert world.ended() == {} and world.probe_calls == []


def test_a_re_delivered_completion_invocation_is_ignored_and_never_double_counts(world):
    """A re delivered completion invocation is ignored and never double counts."""
    world.probes = {"v1": _probe(actualEndTime=None)}
    _live_then_vanish(world)  # v1 is now a pending candidate, YouTube says "still live"
    probes_after_first = len(world.probe_calls)
    state_after_first = lifecycle._read_snapshot_record()

    world.clock += timedelta(seconds=30)  # Lambda re-delivers the same event half a minute later
    summary = world.completion()

    assert summary["skipped"] == "duplicate_invocation"
    assert len(world.probe_calls) == probes_after_first
    assert lifecycle._read_snapshot_record() == state_after_first


def test_a_cycle_whose_state_cannot_be_written_is_reported_not_raised_and_repeats_cleanly(world, monkeypatch):
    """A cycle whose state cannot be written is reported not raised and repeats cleanly."""
    world.probes = {"v1": _probe()}
    world.items = [_holodex_item(video_id="v1", status="live")]
    world.display()
    world.completion()
    world.items = []
    world.clock += timedelta(minutes=5)
    world.display(minutes=0)

    real_put = lifecycle.put_remote_config
    monkeypatch.setattr(lifecycle, "put_remote_config", lambda record: (_ for _ in ()).throw(RuntimeError("DynamoDB throttled")))
    failed = world.completion()
    monkeypatch.setattr(lifecycle, "put_remote_config", real_put)
    world.clock += timedelta(minutes=5)
    world.display(minutes=0)
    retried = world.completion()

    assert failed["refreshed"] is False and failed["writeFailed"] is True
    assert retried["refreshed"] is True
    assert list(world.ended()) == ["v1"]  # recorded exactly once


# ============ PRIORITY 3: which disappearances are ends, and how an end is confirmed ============


def test_a_live_stream_that_disappears_is_confirmed_ended_by_youtube_with_its_actual_end_time(world):
    """A live stream that disappears is confirmed ended by youtube with its actual end time."""
    world.probes = {"v1": _probe(actualEndTime="2026-10-15T12:30:00Z")}

    summary = _live_then_vanish(world)

    assert summary["completionCandidates"] == ["v1"]
    assert summary["confirmedCompleted"] == ["v1"]
    entry = world.ended()["v1"]
    assert entry["endState"] == lifecycle.END_STATE_ENDED
    assert entry["actualEnd"] == "2026-10-15T12:30:00Z"  # YouTube's value, not the time we noticed
    assert entry["confirmedEndedAt"] == world.clock.isoformat()
    assert entry["creatorId"] == "aizawa_ema" and entry["title"] == "Test Stream"
    assert entry["lastSeenLiveAt"] is not None
    [video] = [v for v in load_videos() if v.video_id == "v1"]
    assert video.live_status == "completed"  # the Video Master side write still happens


def test_an_upcoming_stream_that_disappears_is_not_an_ended_candidate(world):
    """An upcoming stream that disappears is not an ended candidate."""
    world.probes = {"v1": _probe()}

    summary = _live_then_vanish(world, status="upcoming")

    assert summary["completionCandidates"] == []
    assert world.probe_calls == []  # nothing to ask YouTube about
    assert world.ended() == {}


def test_a_live_stream_that_became_upcoming_or_stays_listed_is_not_a_candidate(world):
    """A live stream that became upcoming or stays listed is not a candidate."""
    world.items = [_holodex_item(video_id="v1", status="live")]
    world.display()
    world.completion()
    world.items = [_holodex_item(video_id="v1", status="upcoming")]
    world.clock += timedelta(minutes=5)
    world.display(minutes=0)

    summary = world.completion()

    assert summary["completionCandidates"] == []
    assert world.ended() == {}


def test_a_hidden_view_count_does_not_stop_an_end_from_being_confirmed(world):
    """A hidden view count does not stop an end from being confirmed."""
    world.probes = {"v1": _probe(viewCount=None)}  # the channel hides view counts

    summary = _live_then_vanish(world)

    assert summary["confirmedCompleted"] == ["v1"]
    entry = world.ended()["v1"]
    assert entry["endState"] == lifecycle.END_STATE_ENDED
    assert entry["archive"]["status"] == lifecycle.ARCHIVE_AVAILABLE
    assert entry["archive"]["viewCount"] is None  # unknown stays unknown


def test_a_stream_youtube_still_reports_live_stays_a_candidate_and_costs_no_attempt(world):
    """A stream youtube still reports live stays a candidate and costs no attempt."""
    world.probes = {"v1": _probe(actualEndTime=None)}  # Holodex merely lost it
    _live_then_vanish(world)

    for _ in range(lifecycle._MAX_PENDING_ATTEMPTS + 3):
        world.clock += timedelta(minutes=5)
        world.display(minutes=0)
        world.completion()

    assert world.ended() == {}
    assert lifecycle._read_snapshot_record()["pendingCandidates"]["v1"]["attempts"] == 0
    world.probes = {"v1": _probe()}  # now it really ended
    world.clock += timedelta(minutes=5)
    world.display(minutes=0)
    world.completion()
    assert world.ended()["v1"]["endState"] == lifecycle.END_STATE_ENDED


def test_a_video_youtube_does_not_return_is_retried_boundedly_then_recorded_unavailable_not_silently_dropped(world):
    """A video youtube does not return is retried boundedly then recorded unavailable not silently dropped."""
    world.probes = {}  # deleted / private / unavailable
    _live_then_vanish(world)  # check 1

    for _ in range(lifecycle._MAX_PENDING_ATTEMPTS - 2):
        world.clock += timedelta(minutes=5)
        world.display(minutes=0)
        world.completion()
    assert world.ended() == {}  # still within the bound

    world.clock += timedelta(minutes=5)
    world.display(minutes=0)
    world.completion()
    entry = world.ended()["v1"]
    assert entry["endState"] == lifecycle.END_STATE_UNAVAILABLE
    assert entry["actualEnd"] is None  # no end time is invented
    assert entry["archive"]["status"] == lifecycle.ARCHIVE_UNAVAILABLE
    assert lifecycle._read_snapshot_record()["pendingCandidates"] == {}
    checks = len(world.probe_calls)
    world.clock += timedelta(minutes=5)
    world.display(minutes=0)
    world.completion()
    assert len(world.probe_calls) == checks  # nothing left to ask


@pytest.mark.parametrize("error", [RuntimeError("network blip"), lifecycle.HolodexAPIError("not even the right error")])
def test_a_youtube_failure_is_transient_it_changes_nothing_and_costs_no_attempt(world, error):
    """A youtube failure is transient it changes nothing and costs no attempt."""
    world.probe_error = error
    _live_then_vanish(world)
    state = lifecycle._read_snapshot_record()["pendingCandidates"]["v1"]

    for _ in range(lifecycle._MAX_PENDING_ATTEMPTS + 2):
        world.clock += timedelta(minutes=5)
        world.display(minutes=0)
        world.completion()

    assert lifecycle._read_snapshot_record()["pendingCandidates"]["v1"]["attempts"] == state["attempts"] == 0
    assert world.ended() == {}
    world.probe_error = None
    world.probes = {"v1": _probe()}
    world.clock += timedelta(minutes=5)
    world.display(minutes=0)
    world.completion()
    assert "v1" in world.ended()  # recovered with nothing lost


def test_a_youtube_quota_wall_concludes_nothing_about_the_unasked_ids(world, monkeypatch):
    """A youtube quota wall concludes nothing about the unasked ids."""
    from collection.youtube_client import QuotaExhaustedError

    world.items = [_holodex_item(video_id="v1", status="live"), _holodex_item(video_id="v2", status="live")]
    world.display()
    world.completion()
    world.items = []
    world.clock += timedelta(minutes=5)
    world.display(minutes=0)

    def _quota(youtube, video_ids):
        """Quota."""
        raise QuotaExhaustedError("quota", partial_results=[{"videoId": "v1", **_probe()}], remaining_video_ids=["v2"])

    monkeypatch.setattr("collection.youtube_client.get_archive_probe", _quota)
    summary = world.completion()

    assert summary["confirmedCompleted"] == ["v1"]
    assert lifecycle._read_snapshot_record()["pendingCandidates"]["v2"]["attempts"] == 0  # not asked, not counted


def test_a_missing_api_key_is_transient_not_a_crash(world, monkeypatch):
    """A missing api key is transient not a crash."""
    from ops.config import MissingAPIKeyError

    def _no_key():
        """No key."""
        raise MissingAPIKeyError("no key configured")

    world.probes = {"v1": _probe()}
    monkeypatch.setattr("ops.config.get_api_key", _no_key)

    summary = _live_then_vanish(world)

    assert summary["refreshed"] is True and summary["confirmedCompleted"] == []
    assert lifecycle._read_snapshot_record()["pendingCandidates"]["v1"]["attempts"] == 0


def test_a_candidate_that_reappears_in_holodex_is_dropped_immediately(world):
    """A candidate that reappears in holodex is dropped immediately."""
    world.probes = {"v1": _probe(actualEndTime=None)}
    _live_then_vanish(world)
    world.items = [_holodex_item(video_id="v1", status="live")]
    world.clock += timedelta(minutes=5)
    world.display(minutes=0)

    summary = world.completion()

    assert summary["completionCandidates"] == []
    assert lifecycle._read_snapshot_record()["pendingCandidates"] == {}


def test_an_unresolved_candidate_is_dropped_after_the_age_limit(world):
    """An unresolved candidate is dropped after the age limit."""
    world.probe_error = RuntimeError("down for a day")
    _live_then_vanish(world)

    world.clock += lifecycle.PENDING_MAX_AGE + timedelta(minutes=10)
    world.display(minutes=0)
    world.completion()

    assert lifecycle._read_snapshot_record()["pendingCandidates"] == {}


def test_confirmation_is_idempotent_a_stream_is_recorded_once_even_if_the_state_is_replayed(world):
    """Confirmation is idempotent a stream is recorded once even if the state is replayed."""
    world.probes = {"v1": _probe()}
    _live_then_vanish(world)
    first = dict(world.ended()["v1"])
    snapshot_before = lifecycle._read_snapshot_record()

    # Replay: the same pending candidate arrives again (e.g. the main record was not written last time).
    lifecycle.put_remote_config(
        {"clientId": lifecycle.SYSTEM_CLIENT_ID, "key": lifecycle.LIVE_SNAPSHOT_KEY, "value": {**snapshot_before, "refreshedAt": (world.clock - timedelta(minutes=30)).isoformat(), "pendingCandidates": {"v1": {"firstSeenMissingAt": world.clock.isoformat(), "attempts": 0, "stream": {"videoId": "v1"}}}}, "updatedAt": world.clock.isoformat()}
    )
    world.clock += timedelta(minutes=5)
    world.display(minutes=0)
    world.completion()

    assert world.ended()["v1"] == first  # not recorded twice, nothing overwritten


def test_a_failed_video_master_write_keeps_the_end_recorded_and_retries_only_the_write_boundedly(world, monkeypatch):
    """A failed video master write keeps the end recorded and retries only the write boundedly."""
    world.probes = {"v1": _probe()}
    monkeypatch.setattr("stores.dynamodb_store.set_video_live_status", lambda video_id, status: (_ for _ in ()).throw(RuntimeError("throttled")))

    summary = _live_then_vanish(world)

    assert summary["confirmedCompleted"] == ["v1"]  # the end is recorded regardless
    assert "v1" in world.ended()
    assert lifecycle._read_snapshot_record()["pendingCandidates"]["v1"]["attempts"] == 1  # retried, boundedly


def test_a_stream_not_in_video_master_is_still_recorded_as_ended(dynamo, monkeypatch):
    """A stream not in video master is still recorded as ended."""
    world = World(monkeypatch)  # no Video Master row for v1 at all (not discovered yet)
    world.probes = {"v1": _probe()}

    summary = _live_then_vanish(world)

    assert summary["confirmedCompleted"] == ["v1"]
    assert world.ended()["v1"]["endState"] == lifecycle.END_STATE_ENDED


def test_the_ended_record_is_written_only_when_it_changes(world, monkeypatch):
    """The ended record is written only when it changes."""
    world.items = [_holodex_item(video_id="v1", status="live")]
    world.display()
    writes: list[str] = []
    real_put = lifecycle.put_remote_config
    monkeypatch.setattr(lifecycle, "put_remote_config", lambda record: (writes.append(record["key"]), real_put(record))[1])

    world.completion()  # first ever cycle: the (empty) ended record is created
    world.clock += timedelta(minutes=5)
    world.display(minutes=0)
    writes.clear()
    world.completion()  # nothing ended: the ended record must not be rewritten

    assert lifecycle.ENDED_STREAMS_KEY not in writes
    assert lifecycle.LIVE_SNAPSHOT_KEY in writes


def test_ended_records_expire_after_the_retention_and_are_capped(world):
    """Ended records expire after the retention and are capped."""
    world.probes = {"v1": _probe()}
    _live_then_vanish(world)
    assert "v1" in world.ended()

    world.clock += lifecycle.RECENTLY_ENDED_RETENTION + timedelta(minutes=10)
    world.display(minutes=0)
    world.completion()
    assert world.ended() == {}

    entries = {f"v{i}": {"videoId": f"v{i}", "confirmedEndedAt": (T0 - timedelta(minutes=i)).isoformat()} for i in range(lifecycle.RECENTLY_ENDED_MAX_ENTRIES + 5)}
    kept = lifecycle._prune_ended(entries, T0)
    assert len(kept) == lifecycle.RECENTLY_ENDED_MAX_ENTRIES and "v0" in kept and f"v{lifecycle.RECENTLY_ENDED_MAX_ENTRIES + 4}" not in kept

# ============ ARCHIVE LOOKUP: exact videoId, three attempts on the shared cadence, then the daily task ============


def test_the_first_lookup_is_the_cycle_that_confirms_the_end_and_a_playable_archive_is_recorded_with_its_facts(world):
    """The first lookup is the cycle that confirms the end and a playable archive is recorded with its facts."""
    world.probes = {"v1": _probe()}

    _live_then_vanish(world)

    assert world.probe_calls == [["v1"]]  # one batched call in the confirming cycle itself (no extra delay)
    archive = world.ended()["v1"]["archive"]
    assert archive["status"] == lifecycle.ARCHIVE_AVAILABLE
    assert archive["attempts"] == 1
    assert (archive["title"], archive["channelId"], archive["publishedAt"], archive["viewCount"]) == ("Test Stream", CHANNEL_ID, "2026-10-15T09:00:00Z", 1234)
    calls = len(world.probe_calls)
    world.clock += timedelta(minutes=5)
    world.display(minutes=0)
    world.completion()
    assert len(world.probe_calls) == calls  # resolved: never looked up again


def test_an_archive_that_is_not_ready_is_retried_on_the_next_cycles_only_up_to_three_attempts_then_handed_off(world):
    """An archive that is not ready is retried on the next cycles only up to three attempts then handed off."""
    world.probes = {"v1": _probe(uploadStatus="uploaded")}  # ended, but the recording is still processing

    _live_then_vanish(world)  # attempt 1
    assert world.ended()["v1"]["archive"]["status"] == lifecycle.ARCHIVE_PENDING
    assert lifecycle._read_snapshot_record()["archiveWatch"]["v1"]["attempts"] == 1
    for _ in range(2):  # attempts 2 and 3
        world.clock += timedelta(minutes=5)
        world.display(minutes=0)
        world.completion()

    archive = world.ended()["v1"]["archive"]
    assert archive["status"] == lifecycle.ARCHIVE_HANDED_OFF
    assert archive["attempts"] == lifecycle.ARCHIVE_LOOKUP_MAX_ATTEMPTS
    assert archive["reason"] == "still_processing"
    assert lifecycle._read_snapshot_record()["archiveWatch"] == {}
    calls = len(world.probe_calls)
    for _ in range(4):
        world.clock += timedelta(minutes=5)
        world.display(minutes=0)
        world.completion()
    assert len(world.probe_calls) == calls  # a handed-off stream is never looked up here again


def test_the_archive_appearing_on_a_later_attempt_is_recorded_and_stops_the_lookup(world):
    """The archive appearing on a later attempt is recorded and stops the lookup."""
    world.probes = {"v1": _probe(uploadStatus="uploaded")}
    _live_then_vanish(world)
    world.probes = {"v1": _probe()}

    world.clock += timedelta(minutes=5)
    world.display(minutes=0)
    world.completion()

    archive = world.ended()["v1"]["archive"]
    assert archive["status"] == lifecycle.ARCHIVE_AVAILABLE and archive["attempts"] == 2


@pytest.mark.parametrize(
    ("overrides", "reason"),
    [
        ({"privacyStatus": "private"}, "not_public"),
        ({"uploadStatus": "processing"}, "still_processing"),
        ({"embeddable": False}, "not_embeddable"),
        ({"channelId": "UC_someone_else"}, "channel_mismatch"),
        ({"title": ""}, "metadata_missing"),
    ],
)
def test_an_archive_that_is_not_playable_or_not_the_creators_is_never_marked_available(world, overrides, reason):
    """An archive that is not playable or not the creators is never marked available."""
    world.probes = {"v1": _probe(**overrides)}

    _live_then_vanish(world)
    for _ in range(2):
        world.clock += timedelta(minutes=5)
        world.display(minutes=0)
        world.completion()

    entry = world.ended()["v1"]
    assert entry["endState"] == lifecycle.END_STATE_ENDED  # the end itself is unaffected by the archive
    assert entry["archive"]["status"] == lifecycle.ARCHIVE_HANDED_OFF and entry["archive"]["reason"] == reason


def test_an_archive_that_disappears_after_the_end_was_confirmed_is_handed_off_not_retried_forever(world):
    """An archive that disappears after the end was confirmed is handed off not retried forever."""
    world.probes = {"v1": _probe(uploadStatus="uploaded")}
    _live_then_vanish(world)
    world.probes = {}  # the creator deleted it

    for _ in range(2):
        world.clock += timedelta(minutes=5)
        world.display(minutes=0)
        world.completion()

    entry = world.ended()["v1"]
    assert entry["endState"] == lifecycle.END_STATE_ENDED and entry["actualEnd"] == "2026-10-15T12:30:00Z"
    assert entry["archive"]["status"] == lifecycle.ARCHIVE_HANDED_OFF and entry["archive"]["reason"] == "not_returned_by_youtube"


def test_the_lookup_matches_the_exact_video_id_never_another_videos_archive(world):
    """The lookup matches the exact video id never another videos archive."""
    world.probes = {"v1": _probe(), "some-other-video": _probe(title="Other")}

    _live_then_vanish(world)

    assert world.ended()["v1"]["archive"]["title"] == "Test Stream"
    assert all(call == ["v1"] for call in world.probe_calls[1:])


def test_probes_that_cannot_run_hand_the_stream_to_the_daily_task_after_the_age_limit_not_never(world):
    """Probes that cannot run hand the stream to the daily task after the age limit not never."""
    world.probes = {"v1": _probe()}
    world.probe_error = RuntimeError("quota wall")
    _live_then_vanish(world)  # the end cannot even be confirmed; seed an ended record directly instead
    world.probe_error = None
    world.probes = {"v1": _probe(uploadStatus="uploaded")}
    world.clock += timedelta(minutes=5)
    world.display(minutes=0)
    world.completion()
    assert world.ended()["v1"]["archive"]["status"] == lifecycle.ARCHIVE_PENDING

    world.probe_error = RuntimeError("quota wall")
    world.clock += lifecycle.ARCHIVE_LOOKUP_MAX_AGE + timedelta(minutes=5)
    world.display(minutes=0)
    world.completion()

    archive = world.ended()["v1"]["archive"]
    assert archive["status"] == lifecycle.ARCHIVE_HANDED_OFF and archive["reason"] == "still_processing"


def test_an_archive_failure_never_prevents_the_end_state_from_being_recorded(world, monkeypatch):
    """An archive failure never prevents the end state from being recorded."""
    world.probes = {"v1": _probe()}
    monkeypatch.setattr(lifecycle, "_run_archive_lookups", lambda *args, **kwargs: (_ for _ in ()).throw(ValueError("unexpected")))

    summary = _live_then_vanish(world)

    assert summary["confirmedCompleted"] == ["v1"]
    assert world.ended()["v1"]["endState"] == lifecycle.END_STATE_ENDED


# ============ reading the end state ============


def test_the_end_signal_is_unavailable_until_the_record_exists_then_empty_means_nothing_ended(world):
    """The end signal is unavailable until the record exists then empty means nothing ended."""
    assert lifecycle.read_recently_ended() is None  # never written: "not supported", NOT "nothing ended"

    world.items = [_holodex_item(video_id="v1", status="live")]
    world.display()
    world.completion()
    lifecycle.reset_ended_cache()

    assert lifecycle.read_recently_ended() == []


def test_recently_ended_exposes_slim_fields_newest_first_for_the_exposure_window_only(world):
    """Recently ended exposes slim fields newest first for the exposure window only."""
    world.probes = {"v1": _probe()}
    _live_then_vanish(world)
    lifecycle.reset_ended_cache()

    [entry] = lifecycle.read_recently_ended(now=world.clock)

    assert set(entry) == {"videoId", "creatorId", "title", "scheduledStart", "actualStart", "lastSeenLiveAt", "confirmedEndedAt", "actualEnd", "endState", "archive"}
    assert entry["archive"] == {"status": lifecycle.ARCHIVE_AVAILABLE}  # status only: no facts, no counters
    assert lifecycle.read_recently_ended(now=world.clock + lifecycle.RECENTLY_ENDED_EXPOSE + timedelta(minutes=1)) == []


def test_available_archives_lists_only_verified_ended_streams_of_that_creator(world):
    """Available archives lists only verified ended streams of that creator."""
    world.items = [_holodex_item(video_id="v1", status="live"), _holodex_item(video_id="v2", status="live"), _holodex_item(video_id="v3", status="live")]
    world.display()
    world.completion()
    world.items = []
    world.clock += timedelta(minutes=5)
    world.display(minutes=0)
    world.probes = {"v1": _probe(), "v2": _probe(embeddable=False), "v3": _probe(title="Third")}
    world.completion()
    lifecycle.reset_ended_cache()

    assert sorted(item["videoId"] for item in lifecycle.read_available_archives("aizawa_ema")) == ["v1", "v3"]  # v2 is not playable
    assert lifecycle.read_available_archives("someone_else") == []


def test_the_ended_map_is_cached_in_memory_between_requests(world, monkeypatch):
    """The ended map is cached in memory between requests."""
    world.items = [_holodex_item(video_id="v1", status="live")]
    world.display()
    world.completion()
    lifecycle.reset_ended_cache()
    reads: list[str] = []
    real_get = lifecycle.get_remote_config
    monkeypatch.setattr(lifecycle, "get_remote_config", lambda client_id, key: (reads.append(key), real_get(client_id, key))[1])

    for _ in range(5):
        lifecycle.read_ended_streams()

    assert reads == [lifecycle.ENDED_STREAMS_KEY]  # one DynamoDB read, not five


# ============ compatibility with records written by the previous version ============


def test_a_completion_record_from_before_the_live_baseline_existed_still_yields_live_candidates(world):
    """A completion record from before the live baseline existed still yields live candidates."""
    lifecycle.put_remote_config(
        {
            "clientId": lifecycle.SYSTEM_CLIENT_ID,
            "key": lifecycle.LIVE_SNAPSHOT_KEY,
            "value": {
                "streams": [
                    {"videoId": "v1", "creatorId": "aizawa_ema", "title": "Old format live", "status": "live", "scheduledStart": None, "actualStart": "2026-10-15T10:00:00+00:00"},
                    {"videoId": "v2", "creatorId": "aizawa_ema", "title": "Old format upcoming", "status": "upcoming", "scheduledStart": "2026-10-16T01:00:00+00:00", "actualStart": None},
                ],
                "refreshedAt": (T0 - timedelta(minutes=5)).isoformat(),
                "pendingCandidates": {},
            },
            "updatedAt": T0.isoformat(),
        }
    )
    world.probes = {"v1": _probe()}
    world.items = []
    world.display()

    summary = world.completion()

    assert summary["completionCandidates"] == ["v1"]  # the vanished upcoming v2 is not one
    assert "v1" in world.ended()


def test_the_completion_cadence_and_retry_window_are_unchanged_by_the_new_display_path():
    """The completion cadence and retry window are unchanged by the new display path."""
    assert lifecycle._MAX_PENDING_ATTEMPTS == 12  # 12 five-minute cycles ~ 1 hour
    assert lifecycle.ARCHIVE_LOOKUP_MAX_ATTEMPTS == 3