"""Tests for tracking.livestream_lifecycle: the periodic Holodex-refresh + completion-detection job.

Only api.read_api.holodex_get (the actual HTTP boundary) is ever mocked for the Holodex side, matching
tests/api/test_read_api.py's own convention -- fetch_live_streams_from_holodex runs for real, so these tests
exercise the exact same fetch/filter logic GET /live-streams itself relies on, not a stand-in for it.
"""

from __future__ import annotations

import boto3
import pytest
from moto import mock_aws

from api import read_api
from stores.dynamodb_store import CREATOR_ID_INDEX, VIDEO_MASTER_TABLE, load_videos
from stores.dynamodb_store import upsert_videos as upsert_dynamo_videos
from stores.remote_config_store import REMOTE_CONFIG_TABLE
from tracking import livestream_lifecycle
from tracking.creator_master import Creator
from tracking.video_master import Video

REGION = "ap-northeast-1"


@pytest.fixture
def dynamo(aws_credentials):
    """Moto-backed YobiVideoMaster + YobiRemoteConfig, production-shaped (same schema as their own dedicated test files)."""
    with mock_aws():
        client = boto3.client("dynamodb", region_name=REGION)
        client.create_table(
            TableName=VIDEO_MASTER_TABLE,
            AttributeDefinitions=[
                {"AttributeName": "videoId", "AttributeType": "S"},
                {"AttributeName": "creatorId", "AttributeType": "S"},
            ],
            KeySchema=[{"AttributeName": "videoId", "KeyType": "HASH"}],
            GlobalSecondaryIndexes=[
                {
                    "IndexName": CREATOR_ID_INDEX,
                    "KeySchema": [{"AttributeName": "creatorId", "KeyType": "HASH"}],
                    "Projection": {"ProjectionType": "ALL"},
                }
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        client.create_table(
            TableName=REMOTE_CONFIG_TABLE,
            AttributeDefinitions=[
                {"AttributeName": "clientId", "AttributeType": "S"},
                {"AttributeName": "configKey", "AttributeType": "S"},
            ],
            KeySchema=[
                {"AttributeName": "clientId", "KeyType": "HASH"},
                {"AttributeName": "configKey", "KeyType": "RANGE"},
            ],
            GlobalSecondaryIndexes=[
                {
                    "IndexName": "configKey-index",
                    "KeySchema": [{"AttributeName": "configKey", "KeyType": "HASH"}],
                    "Projection": {"ProjectionType": "ALL"},
                }
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        yield


def _creator(**overrides) -> Creator:
    fields = {
        "creator_id": "aizawa_ema",
        "display_name": "藍沢エマ",
        "organization": "vspo",
        "youtube_channel_id": "UC_test",
        "active": True,
        "branch": "vspo_jp",
        "group_key": ["1期生"],
        "channel_type": "member",
        "lifecycle_stage": "active",
        "display_order": 0,
    }
    fields.update(overrides)
    return Creator(**fields)


def _holodex_item(*, video_id="v1", status="live", channel_id="UC_test", channel_name="藍沢エマ", **overrides):
    item = {
        "id": video_id,
        "status": status,
        "channel": {"id": channel_id, "name": channel_name},
        "title": "Test Stream",
        "start_scheduled": None,
        "start_actual": "2026-09-01T10:00:00Z" if status == "live" else None,
    }
    item.update(overrides)
    return item


def _video(video_id="v1", *, content_type="live", live_status="live") -> Video:
    return Video(
        video_id=video_id,
        creator_id="aizawa_ema",
        title="Original Title",
        published_at="2026-09-01T00:00:00Z",
        content_type=content_type,
        live_status=live_status,
    )


# ============ read_snapshot ============


def test_read_snapshot_is_none_when_nothing_was_ever_persisted(dynamo):
    assert livestream_lifecycle.read_snapshot() is None


# ============ refresh_snapshot: persistence ============


def test_refresh_snapshot_persists_what_holodex_reports(dynamo, monkeypatch):
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [_holodex_item(video_id="v1", status="live")])

    summary = livestream_lifecycle.refresh_snapshot()

    assert summary["refreshed"] is True
    assert summary["streamCount"] == 1
    assert [s["videoId"] for s in livestream_lifecycle.read_snapshot()] == ["v1"]


def test_refresh_snapshot_retries_a_transient_holodex_failure_then_succeeds(dynamo, monkeypatch):
    from api.holodex_client import HolodexAPIError

    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(livestream_lifecycle, "_holodex_backoff_seconds", lambda attempt: 0.0)
    attempts = {"n": 0}

    def flaky_holodex_get(path, params=None):
        attempts["n"] += 1
        if attempts["n"] < 2:
            raise HolodexAPIError("transient 503")
        return [_holodex_item(video_id="v1", status="live")]

    monkeypatch.setattr(read_api, "holodex_get", flaky_holodex_get)

    summary = livestream_lifecycle.refresh_snapshot()

    assert summary == {"refreshed": True, "streamCount": 1, "completionCandidates": [], "confirmedCompleted": []}
    assert attempts["n"] == 2


def test_refresh_snapshot_gives_up_after_bounded_attempts_and_keeps_the_last_snapshot(dynamo, monkeypatch):
    from api.holodex_client import HolodexAPIError

    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [_holodex_item(video_id="v0", status="live")])
    livestream_lifecycle.refresh_snapshot()  # seed a good snapshot first

    monkeypatch.setattr(livestream_lifecycle, "_holodex_backoff_seconds", lambda attempt: 0.0)
    attempts = {"n": 0}

    def always_fails(path, params=None):
        attempts["n"] += 1
        raise HolodexAPIError("persistent outage")

    monkeypatch.setattr(read_api, "holodex_get", always_fails)

    summary = livestream_lifecycle.refresh_snapshot()

    assert summary == {"refreshed": False, "streamCount": 1, "completionCandidates": [], "confirmedCompleted": []}
    assert attempts["n"] == livestream_lifecycle._HOLODEX_MAX_ATTEMPTS
    assert [s["videoId"] for s in livestream_lifecycle.read_snapshot()] == ["v0"]  # untouched


def test_refresh_snapshot_never_retries_a_missing_api_key(dynamo, monkeypatch):
    from ops.config import MissingHolodexApiKeyError

    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    attempts = {"n": 0}

    def _boom(path, params=None):
        attempts["n"] += 1
        raise MissingHolodexApiKeyError("no key configured")

    monkeypatch.setattr(read_api, "holodex_get", _boom)

    summary = livestream_lifecycle.refresh_snapshot()

    assert summary["refreshed"] is False
    assert attempts["n"] == 1  # not retried -- a missing key can never be fixed by retrying


# ============ refresh_snapshot: completion-candidate diffing + verification ============


def test_a_stream_missing_from_the_new_fetch_becomes_a_completion_candidate(dynamo, monkeypatch):
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [_holodex_item(video_id="v1", status="live")])
    livestream_lifecycle.refresh_snapshot()  # v1 is live

    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [])  # v1 dropped out of Holodex's response
    monkeypatch.setattr(livestream_lifecycle, "_verify_and_mark_completed", lambda pending: ([], {}))

    summary = livestream_lifecycle.refresh_snapshot()

    assert summary["completionCandidates"] == ["v1"]


def test_a_candidate_confirmed_completed_by_youtube_is_persisted_to_video_master(dynamo, monkeypatch):
    upsert_dynamo_videos([_video("v1", content_type="live", live_status="live")])
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [_holodex_item(video_id="v1", status="live")])
    livestream_lifecycle.refresh_snapshot()  # seed: v1 live

    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [])  # v1 no longer reported
    monkeypatch.setattr("collection.youtube_client.build_youtube_client", lambda api_key: object())
    monkeypatch.setattr("ops.config.get_api_key", lambda: "fake-key")
    monkeypatch.setattr(
        "collection.youtube_client.get_video_statistics",
        lambda youtube, video_ids: ([{"videoId": "v1", "contentType": "live", "liveStatus": "completed"}], {}),
    )

    summary = livestream_lifecycle.refresh_snapshot()

    assert summary["completionCandidates"] == ["v1"]
    assert summary["confirmedCompleted"] == ["v1"]
    [video] = [v for v in load_videos() if v.video_id == "v1"]
    assert video.live_status == "completed"


def test_a_candidate_youtube_still_reports_live_is_not_marked_completed(dynamo, monkeypatch):
    upsert_dynamo_videos([_video("v1", content_type="live", live_status="live")])
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [_holodex_item(video_id="v1", status="live")])
    livestream_lifecycle.refresh_snapshot()

    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [])
    monkeypatch.setattr("collection.youtube_client.build_youtube_client", lambda api_key: object())
    monkeypatch.setattr("ops.config.get_api_key", lambda: "fake-key")
    monkeypatch.setattr(
        "collection.youtube_client.get_video_statistics",
        lambda youtube, video_ids: ([{"videoId": "v1", "contentType": "live", "liveStatus": "live"}], {}),
    )

    summary = livestream_lifecycle.refresh_snapshot()

    assert summary["confirmedCompleted"] == []
    [video] = [v for v in load_videos() if v.video_id == "v1"]
    assert video.live_status == "live"


def test_a_youtube_quota_exhaustion_during_verification_uses_partial_results_without_crashing(dynamo, monkeypatch):
    from collection.youtube_client import QuotaExhaustedError
    upsert_dynamo_videos(
        [
            _video("v1", content_type="live", live_status="live"),
            _video("v2", content_type="live", live_status="live"),
        ]
    )
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(
        read_api, "holodex_get", lambda path, params=None: [_holodex_item(video_id="v1", status="live"), _holodex_item(video_id="v2", status="live")]
    )
    livestream_lifecycle.refresh_snapshot()

    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [])

    def _quota_exhausted(youtube, video_ids):
        raise QuotaExhaustedError("quota exceeded", partial_results=[{"videoId": "v1", "contentType": "live", "liveStatus": "completed"}])

    monkeypatch.setattr("collection.youtube_client.build_youtube_client", lambda api_key: object())
    monkeypatch.setattr("ops.config.get_api_key", lambda: "fake-key")
    monkeypatch.setattr("collection.youtube_client.get_video_statistics", _quota_exhausted)

    summary = livestream_lifecycle.refresh_snapshot()

    assert sorted(summary["completionCandidates"]) == ["v1", "v2"]
    assert summary["confirmedCompleted"] == ["v1"]


def test_a_missing_youtube_api_key_skips_verification_without_crashing(dynamo, monkeypatch):
    from ops.config import MissingAPIKeyError
    upsert_dynamo_videos([_video("v1", content_type="live", live_status="live")])
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [_holodex_item(video_id="v1", status="live")])
    livestream_lifecycle.refresh_snapshot()

    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [])

    def _boom():
        raise MissingAPIKeyError("no key configured")

    monkeypatch.setattr("ops.config.get_api_key", _boom)

    summary = livestream_lifecycle.refresh_snapshot()

    assert summary["confirmedCompleted"] == []


# ============ durable pending candidates: retryable across cycles, bounded, reappearance clears it ============
# A candidate not confirmed in the cycle it first disappears must stay retryable in later cycles -- the bug this
# section guards is a candidate getting exactly one verification attempt and then silently never being
# reconsidered again, since a plain cycle-over-cycle diff (previous snapshot's ids vs this one's) only ever
# "remembers" a video for the one cycle it actually vanishes in.


def _not_yet_confirmed(video_id="v1"):
    return {"videoId": video_id, "contentType": "live", "liveStatus": "live"}  # YouTube: not finalized yet


def test_a_candidate_not_confirmed_stays_pending_and_is_retried_next_cycle(dynamo, monkeypatch):
    upsert_dynamo_videos([_video("v1", content_type="live", live_status="live")])
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [_holodex_item(video_id="v1", status="live")])
    livestream_lifecycle.refresh_snapshot()  # cycle 0: v1 live

    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [])  # v1 gone from Holodex from here on
    monkeypatch.setattr("collection.youtube_client.build_youtube_client", lambda api_key: object())
    monkeypatch.setattr("ops.config.get_api_key", lambda: "fake-key")
    monkeypatch.setattr("collection.youtube_client.get_video_statistics", lambda youtube, video_ids: ([_not_yet_confirmed("v1")], {}))

    cycle_1 = livestream_lifecycle.refresh_snapshot()  # first verification attempt: still not finalized
    assert cycle_1["completionCandidates"] == ["v1"]
    assert cycle_1["confirmedCompleted"] == []

    # Without durable pending state, v1 would have vanished from consideration after cycle 1 (it's no longer in
    # either snapshot's active set) -- it must still be a candidate in cycle 2.
    cycle_2 = livestream_lifecycle.refresh_snapshot()
    assert cycle_2["completionCandidates"] == ["v1"]
    assert cycle_2["confirmedCompleted"] == []

    # Now YouTube finally confirms it -- still retryable means it eventually gets marked completed.
    monkeypatch.setattr(
        "collection.youtube_client.get_video_statistics",
        lambda youtube, video_ids: ([{"videoId": "v1", "contentType": "live", "liveStatus": "completed"}], {}),
    )
    cycle_3 = livestream_lifecycle.refresh_snapshot()
    assert cycle_3["confirmedCompleted"] == ["v1"]
    [video] = [v for v in load_videos() if v.video_id == "v1"]
    assert video.live_status == "completed"
    # Resolved -- no longer pending in a later cycle.
    cycle_4 = livestream_lifecycle.refresh_snapshot()
    assert cycle_4["completionCandidates"] == []


def test_a_temporary_youtube_failure_leaves_the_candidate_pending_not_dropped(dynamo, monkeypatch):
    """A transient YouTube error (not quota exhaustion, not a missing key -- e.g. get_video_statistics itself
    raising) must not be treated as a confirmation, must not crash the whole cycle (the Holodex snapshot this cycle
    already fetched must still be persisted), and must not count against the candidate's attempt budget (nothing
    about ANY candidate was actually learned this cycle)."""
    upsert_dynamo_videos([_video("v1", content_type="live", live_status="live")])
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [_holodex_item(video_id="v1", status="live")])
    livestream_lifecycle.refresh_snapshot()

    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [])
    monkeypatch.setattr("collection.youtube_client.build_youtube_client", lambda api_key: object())
    monkeypatch.setattr("ops.config.get_api_key", lambda: "fake-key")

    def _transient_failure(youtube, video_ids):
        raise RuntimeError("network blip")

    monkeypatch.setattr("collection.youtube_client.get_video_statistics", _transient_failure)

    summary = livestream_lifecycle.refresh_snapshot()  # must not raise -- the snapshot fetch itself already succeeded

    assert summary["refreshed"] is True
    assert summary["completionCandidates"] == ["v1"]
    assert summary["confirmedCompleted"] == []
    value = livestream_lifecycle._read_snapshot_record()
    assert value["pendingCandidates"]["v1"]["attempts"] == 0  # not bumped -- this attempt never actually ran

    # Still retryable next cycle once YouTube recovers.
    monkeypatch.setattr("collection.youtube_client.get_video_statistics", lambda youtube, video_ids: ([_not_yet_confirmed("v1")], {}))
    next_summary = livestream_lifecycle.refresh_snapshot()
    assert next_summary["completionCandidates"] == ["v1"]


def test_a_candidate_reappearing_in_holodex_is_dropped_from_pending(dynamo, monkeypatch):
    """Holodex reporting a candidate live/upcoming again is unambiguous: it did not complete. It must be removed
    from the pending set immediately, not left to expire via attempts."""
    upsert_dynamo_videos([_video("v1", content_type="live", live_status="live")])
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [_holodex_item(video_id="v1", status="live")])
    livestream_lifecycle.refresh_snapshot()

    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [])
    livestream_lifecycle.refresh_snapshot()  # v1 becomes pending

    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [_holodex_item(video_id="v1", status="live")])
    summary = livestream_lifecycle.refresh_snapshot()  # v1 is back -- false alarm

    assert summary["completionCandidates"] == []
    value = livestream_lifecycle._read_snapshot_record()
    assert value["pendingCandidates"] == {}


def test_a_candidate_is_dropped_after_the_bounded_max_attempts_never_force_completed(dynamo, monkeypatch):
    upsert_dynamo_videos([_video("v1", content_type="live", live_status="live")])
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [_holodex_item(video_id="v1", status="live")])
    livestream_lifecycle.refresh_snapshot()

    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: [])
    monkeypatch.setattr("collection.youtube_client.build_youtube_client", lambda api_key: object())
    monkeypatch.setattr("ops.config.get_api_key", lambda: "fake-key")
    monkeypatch.setattr("collection.youtube_client.get_video_statistics", lambda youtube, video_ids: ([_not_yet_confirmed("v1")], {}))

    summary = None
    for _ in range(livestream_lifecycle._MAX_PENDING_ATTEMPTS):
        summary = livestream_lifecycle.refresh_snapshot()
        assert summary["confirmedCompleted"] == []

    # After _MAX_PENDING_ATTEMPTS unresolved attempts, the candidate is dropped -- never force-completed.
    final = livestream_lifecycle.refresh_snapshot()
    assert final["completionCandidates"] == []
    [video] = [v for v in load_videos() if v.video_id == "v1"]
    assert video.live_status == "live"  # last known state, untouched -- never force-marked completed
