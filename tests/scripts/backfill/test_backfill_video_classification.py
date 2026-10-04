"""Focused tests for scripts/backfill/backfill_video_classification.py: the one-time contentType/liveStatus migration.

Everything between YouTube and storage is the real production code on moto: the real parser
(collection.youtube_client.get_video_statistics fed raw videos.list items), the real conditional Video Master
write (stores.dynamodb_store.set_video_classification), the real manifest patch (tracking_manifest.patch_shard) and
the real collector republish (collection.main._publish_manifest_if_configured). Only the YouTube network call is faked.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import boto3
import pytest
from moto import mock_aws

_MODULE_PATH = Path(__file__).resolve().parents[3] / "scripts" / "backfill" / "backfill_video_classification.py"
_spec = importlib.util.spec_from_file_location("backfill_video_classification", _MODULE_PATH)
backfill = importlib.util.module_from_spec(_spec)
sys.modules.setdefault("backfill_video_classification", backfill)
_spec.loader.exec_module(backfill)

from collection import main as collector_main  # noqa: E402
from collection import youtube_client  # noqa: E402
from collection.youtube_client import MAX_IDS_PER_REQUEST, QuotaExhaustedError  # noqa: E402
from stores import dynamodb_store  # noqa: E402
from stores.dynamodb_store import CREATOR_ID_INDEX, VIDEO_MASTER_TABLE, set_video_classification, upsert_videos  # noqa: E402
from stores.history_store import HISTORY_SHARD_COUNT, shard_for_video  # noqa: E402
from tracking.tracking_manifest import (  # noqa: E402
    S3TrackingManifestStore,
    TrackingManifestError,
    manifest_key,
    patch_shard,
    publish_tracking_manifest,
)
from tracking.video_master import Video, is_classification_incomplete  # noqa: E402

AWS_REGION = "ap-northeast-1"
BUCKET = "test-history-bucket"
JST = timezone(timedelta(hours=9))
NOW = datetime(2026, 10, 2, 14, 0, tzinfo=JST)
STOP_AT = NOW + timedelta(hours=4)

UNAVAILABLE_REASON = "No data returned by YouTube API (video may be deleted or private)"


# --- fixtures and builders -------------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _no_real_sleep(monkeypatch):
    """The client's retry backoff must never really sleep in a test."""
    monkeypatch.setattr(youtube_client.time, "sleep", lambda seconds: None)


@pytest.fixture
def s3(aws_credentials, monkeypatch):
    """One moto context holding YobiVideoMaster (DynamoDB) and the manifest/history bucket (S3)."""
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", BUCKET)
    with mock_aws():
        boto3.client("dynamodb", region_name=AWS_REGION).create_table(
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
        client = boto3.client("s3", region_name=AWS_REGION)
        client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": AWS_REGION})
        yield client


def _video(video_id: str, *, content_type=None, live_status=None, **overrides) -> Video:
    """A fully populated legacy Video: every field a classification write must leave alone is non-default."""
    fields = {
        "video_id": video_id,
        "creator_id": "c1",
        "title": f"title {video_id}",
        "published_at": "2026-09-01T00:00:00Z",
        "thumbnail_url": f"https://i.ytimg.com/vi/{video_id}/hq.jpg",
        "activity_state": "Hot",
        "last_checked_at": "2026-10-01T18:00:00+09:00",
        "last_view_count": 1234,
        "snapshot_count": 7,
        "quiet_streak": 2,
        "last_classification_reason": "growth",
        "last_percent_growth_per_day": 1.5,
        "last_avg_views_per_day": 40.0,
        "discovered_at": "2026-09-02T00:00:00+09:00",
        "topic": "valorant",
        "content_type": content_type,
        "live_status": live_status,
    }
    fields.update(overrides)
    return Video(**fields)


def _ids_for_shard(prefix: str, shard: int, count: int) -> list[str]:
    """`count` distinct video ids that all hash to `shard` (so a test controls batch boundaries exactly)."""
    ids, counter = [], 0
    while len(ids) < count:
        candidate = f"{prefix}{counter:04d}"
        if shard_for_video(candidate) == shard:
            ids.append(candidate)
        counter += 1
    return ids


def _seed(s3_client, videos: list[Video]) -> None:
    """Video Master and the manifest, in the state production has: manifest built from Video Master."""
    upsert_videos(videos)
    publish_tracking_manifest(videos, S3TrackingManifestStore(BUCKET, s3_client=s3_client))


def _item(video_id: str, kind: str, view_count: int = 100) -> dict:
    """A raw videos.list item: kind is upload / upcoming / live / completed (liveStreamingDetails drives the parser)."""
    item = {
        "id": video_id,
        "snippet": {"title": f"yt title {video_id}", "publishedAt": "2026-09-01T00:00:00Z"},
        "statistics": {"viewCount": str(view_count)},
    }
    details = {"upcoming": {}, "live": {"actualStartTime": "x"}, "completed": {"actualStartTime": "x", "actualEndTime": "y"}}
    if kind != "upload":
        item["liveStreamingDetails"] = details[kind]
    return item


class FakeYouTube:
    """Stands in for the googleapiclient resource: serves raw items by id; ids absent from `items` are not returned."""

    def __init__(self, items: dict[str, dict]):
        self.items = dict(items)
        self.fail_ids: set[str] = set()
        self.calls: list[list[str]] = []  # one entry per SUCCESSFUL request
        self.attempts = 0
        self._ids: list[str] = []

    def videos(self):
        return self

    def list(self, *, part, id):  # noqa: A002 - mirrors the real signature
        self._ids = id.split(",")
        return self

    def execute(self):
        self.attempts += 1
        if any(video_id in self.fail_ids for video_id in self._ids):
            raise OSError("simulated network failure")
        self.calls.append(list(self._ids))
        return {"items": [self.items[video_id] for video_id in self._ids if video_id in self.items]}

    @property
    def requested_ids(self) -> list[str]:
        return [video_id for call in self.calls for video_id in call]


def _store(s3_client) -> S3TrackingManifestStore:
    return S3TrackingManifestStore(BUCKET, s3_client=s3_client)


def _run(s3_client, youtube, *, execute=True, stop_at=STOP_AT, now_fn=lambda: NOW, **kwargs) -> dict:
    return backfill.backfill_classification(
        execute=execute,
        manifest_store=_store(s3_client),
        youtube_factory=lambda: youtube,
        stop_at=stop_at,
        now_fn=now_fn,
        workers=2,
        **kwargs,
    )


def _master() -> dict[str, Video]:
    return {video.video_id: video for video in dynamodb_store.load_videos()}


def _manifest(s3_client) -> dict:
    store = _store(s3_client)
    return {entry.video_id: entry for shard in range(HISTORY_SHARD_COUNT) for entry in store.read_shard(shard)}


def _etags(s3_client) -> dict[str, str]:
    listing = s3_client.list_objects_v2(Bucket=BUCKET).get("Contents", [])
    return {obj["Key"]: obj["ETag"] for obj in listing}


# --- the plan: dry run and the quota/time numbers --------------------------------------------------------


def test_dry_run_is_the_default_reads_only_and_never_builds_a_youtube_client(s3):
    _seed(s3, [_video(f"v{n}") for n in range(30)])
    master_before, manifest_before, etags_before = _master(), _manifest(s3), _etags(s3)

    def _must_not_be_called():
        raise AssertionError("a dry run must not build a YouTube client (no API key, no quota)")

    summary = backfill.backfill_classification(
        execute=False, manifest_store=_store(s3), youtube_factory=_must_not_be_called, stop_at=STOP_AT, now_fn=lambda: NOW
    )

    assert summary["status"] == backfill.STATUS_DRY_RUN
    assert summary["entriesIncomplete"] == 30 and summary["toObserveOnYouTube"] == 30
    assert summary["youtubeRequests"] == 0 and summary["masterWritten"] == 0
    assert _master() == master_before and _manifest(s3) == manifest_before and _etags(s3) == etags_before


def test_plan_numbers_follow_the_production_batch_size_and_one_quota_unit_per_request(s3):
    videos = [_video(f"v{n:03d}") for n in range(137)]
    _seed(s3, videos)
    per_shard: dict[int, int] = {}
    for video in videos:
        per_shard[shard_for_video(video.video_id)] = per_shard.get(shard_for_video(video.video_id), 0) + 1
    expected_requests = sum(-(-count // MAX_IDS_PER_REQUEST) for count in per_shard.values())

    summary = _run(s3, FakeYouTube({}), execute=False)

    assert summary["youtubeBatchSize"] == MAX_IDS_PER_REQUEST == 50
    assert summary["youtubeRequestsPlanned"] == expected_requests
    assert summary["youtubeQuotaUnitsPlanned"] == expected_requests  # videos.list = 1 unit per request
    assert summary["masterWritesPlannedMax"] == 137
    assert summary["manifestShardWritesPlanned"] == len(per_shard)
    assert 0 < summary["estimatedMinutesTypical"] < summary["estimatedMinutesConservative"]


def test_the_estimate_for_the_real_catalog_size_is_a_conservative_hour_and_a_half():
    """129,543 legacy entries / 16 shards: the documented go/no-go arithmetic, from the same estimator."""
    per_shard = [8097] * 7 + [8096] * 9  # sums to exactly 129,543
    plans = [backfill.ShardPlan(shard=i, needs_youtube=[f"v{i}_{n}" for n in range(count)]) for i, count in enumerate(per_shard)]

    estimate = backfill.estimate_run(plans, workers=backfill.MASTER_WRITE_WORKERS)

    assert sum(per_shard) == 129_543
    assert estimate["youtubeRequestsPlanned"] == 2592  # every shard needs ceil(~8,096 / 50) = 162 requests
    assert estimate["youtubeQuotaUnitsPlanned"] == 2592
    assert estimate["youtubeQuotaPercentOfDailyLimit"] == 25.9
    assert estimate["masterWritesPlannedMax"] == sum(per_shard)
    assert estimate["manifestShardWritesPlanned"] == 16
    assert 60 <= estimate["estimatedMinutesConservative"] <= 100
    assert estimate["estimatedMinutesTypical"] < 40


def test_a_dry_run_reports_the_go_no_go_verdict_against_stop_at(s3):
    _seed(s3, [_video(f"v{n}") for n in range(20)])

    safe = _run(s3, FakeYouTube({}), execute=False, stop_at=NOW + timedelta(hours=4))
    unsafe = _run(s3, FakeYouTube({}), execute=False, stop_at=NOW + timedelta(minutes=2))

    assert safe["deadlineVerdict"] == "SAFE"
    assert unsafe["deadlineVerdict"].startswith("NOT SAFE")


# --- classification --------------------------------------------------------------------------------------


def test_full_legacy_rows_are_classified_in_video_master_and_the_manifest(s3):
    videos = [_video("v_up"), _video("v_done"), _video("v_live"), _video("v_soon")]
    _seed(s3, videos)
    youtube = FakeYouTube(
        {
            "v_up": _item("v_up", "upload"),
            "v_done": _item("v_done", "completed"),
            "v_live": _item("v_live", "live"),
            "v_soon": _item("v_soon", "upcoming"),
        }
    )
    expected = {"v_up": ("upload", None), "v_done": ("live", "completed"), "v_live": ("live", "live"), "v_soon": ("live", "upcoming")}
    manifest_before = _manifest(s3)

    summary = _run(s3, youtube)

    assert summary["status"] == backfill.STATUS_COMPLETE
    master, manifest = _master(), _manifest(s3)
    for video_id, pair in expected.items():
        assert (master[video_id].content_type, master[video_id].live_status) == pair
        assert (manifest[video_id].content_type, manifest[video_id].live_status) == pair
        # nothing but the two classification fields moved, on either side
        assert replace(master[video_id], content_type=None, live_status=None) == _video(video_id)
        assert replace(manifest[video_id], content_type=None, live_status=None) == replace(
            manifest_before[video_id], content_type=None, live_status=None
        )


@pytest.mark.parametrize(
    ("kind", "expected"),
    [("upload", ("upload", None)), ("completed", ("live", "completed")), ("live", ("live", "live")), ("upcoming", ("live", "upcoming"))],
)
def test_a_live_row_missing_its_live_status_is_completed_from_the_same_parser_the_worker_uses(s3, kind, expected):
    """live/None is incomplete: it is re-observed and takes whatever the production parser says (even upload)."""
    _seed(s3, [_video("v1", content_type="live", live_status=None)])

    summary = _run(s3, FakeYouTube({"v1": _item("v1", kind)}))

    assert summary["status"] == backfill.STATUS_COMPLETE
    assert (_master()["v1"].content_type, _master()["v1"].live_status) == expected
    assert (_manifest(s3)["v1"].content_type, _manifest(s3)["v1"].live_status) == expected


def test_upload_with_no_live_status_is_complete_never_requested_never_touched(s3):
    _seed(s3, [_video("v_upload", content_type="upload", live_status=None), _video("v_legacy")])
    youtube = FakeYouTube({"v_legacy": _item("v_legacy", "upload"), "v_upload": _item("v_upload", "completed")})
    etag_before = _etags(s3)

    summary = _run(s3, youtube)

    assert summary["entriesIncomplete"] == 1  # only the legacy row counts as incomplete
    assert youtube.requested_ids == ["v_legacy"]  # the upload/None row is never asked about
    assert (_master()["v_upload"].content_type, _master()["v_upload"].live_status) == ("upload", None)
    assert (_manifest(s3)["v_upload"].content_type, _manifest(s3)["v_upload"].live_status) == ("upload", None)
    assert etag_before != _etags(s3)  # (the legacy row's shard did change)


def test_an_upload_only_catalog_needs_no_request_and_no_write_at_all(s3):
    _seed(s3, [_video(f"v{n}", content_type="upload") for n in range(10)])
    youtube, etags_before = FakeYouTube({}), _etags(s3)

    summary = _run(s3, youtube)

    assert summary["entriesIncomplete"] == 0 and summary["status"] == backfill.STATUS_COMPLETE
    assert youtube.attempts == 0 and summary["masterWritten"] == 0 and _etags(s3) == etags_before


def test_already_classified_rows_are_unchanged_even_if_youtube_would_now_say_otherwise(s3):
    _seed(
        s3,
        [
            _video("v_done", content_type="live", live_status="completed"),
            _video("v_up", content_type="upload"),
            _video("v_legacy"),
        ],
    )
    youtube = FakeYouTube(
        {"v_done": _item("v_done", "upcoming"), "v_up": _item("v_up", "live"), "v_legacy": _item("v_legacy", "completed")}
    )

    _run(s3, youtube)

    assert youtube.requested_ids == ["v_legacy"]
    master, manifest = _master(), _manifest(s3)
    assert (master["v_done"].content_type, master["v_done"].live_status) == ("live", "completed")
    assert (master["v_up"].content_type, master["v_up"].live_status) == ("upload", None)
    assert (manifest["v_done"].content_type, manifest["v_done"].live_status) == ("live", "completed")


def test_topic_title_thumbnail_scheduler_state_and_view_counts_are_preserved(s3):
    _seed(s3, [_video("v1", topic="sf6", title="Original Title", last_view_count=987654, activity_state="Cold")])

    _run(s3, FakeYouTube({"v1": _item("v1", "completed", view_count=1)}))

    master, entry = _master()["v1"], _manifest(s3)["v1"]
    assert (master.topic, master.title, master.last_view_count, master.activity_state) == ("sf6", "Original Title", 987654, "Cold")
    assert master.thumbnail_url == "https://i.ytimg.com/vi/v1/hq.jpg" and master.snapshot_count == 7
    assert (entry.topic, entry.title, entry.activity_state, entry.active) == ("sf6", "Original Title", "Cold", True)
    assert entry.thumbnail_url == "https://i.ytimg.com/vi/v1/hq.jpg"
    assert master.title != "yt title v1"  # the YouTube title never overwrites the stored one


def test_history_rankings_and_every_non_catalog_object_are_never_touched(s3):
    _seed(s3, [_video(f"v{n}") for n in range(20)])
    untouched = {
        "history/daily/date=2026-10-01/shard=00.parquet": b"history-bytes",
        "video-ranking/date=2026-10-01/creator=c1.json": b'{"rows": []}',
        "subscriber-ranking/date=2026-10-01.json": b'{"total": {}}',
        "history/subscribers/date=2026-10-01.json": b"{}",
    }
    for key, body in untouched.items():
        s3.put_object(Bucket=BUCKET, Key=key, Body=body)
    before = _etags(s3)

    _run(s3, FakeYouTube({f"v{n}": _item(f"v{n}", "upload") for n in range(20)}))

    after = _etags(s3)
    changed = {key for key in after if after[key] != before.get(key)} | (set(before) - set(after))
    assert changed and all(key.startswith(manifest_key(0).rsplit("/", 1)[0] + "/") for key in changed)
    assert set(after) == set(before)  # no object created or deleted either
    for key, body in untouched.items():
        assert s3.get_object(Bucket=BUCKET, Key=key)["Body"].read() == body


# --- failure, retry, unavailable videos, idempotence -----------------------------------------------------


def test_a_failed_batch_is_reported_partial_and_a_rerun_requests_only_the_failed_ids(s3):
    ids = _ids_for_shard("v", 0, 120)  # one shard -> batches [0:50] [50:100] [100:120]
    _seed(s3, [_video(video_id) for video_id in ids])
    youtube = FakeYouTube({video_id: _item(video_id, "upload") for video_id in ids})
    youtube.fail_ids = {ids[60]}  # the whole second batch fails (after the client's own retries)

    first = _run(s3, youtube)

    assert first["status"] == backfill.STATUS_PARTIAL
    assert first["apiFailedVideoIds"] == ids[50:100]
    assert first["observedClassified"] == 70
    assert sum(1 for v in _master().values() if v.content_type) == 70
    assert sum(1 for e in _manifest(s3).values() if e.content_type) == 70
    assert youtube.requested_ids == ids[:50] + ids[100:]

    youtube.fail_ids.clear()
    youtube.calls.clear()
    second = _run(s3, youtube)

    assert second["status"] == backfill.STATUS_COMPLETE
    assert youtube.requested_ids == ids[50:100]  # nothing that already succeeded is asked again
    assert all(v.content_type == "upload" for v in _master().values())
    assert all(e.content_type == "upload" for e in _manifest(s3).values())


def test_a_video_youtube_does_not_return_is_reported_separately_and_never_fabricated(s3):
    _seed(s3, [_video("v_ok"), _video("v_gone"), _video("v_noviews")])
    broken = _item("v_noviews", "upcoming")
    del broken["statistics"]["viewCount"]  # the production parser rejects this item (it needs viewCount)
    youtube = FakeYouTube({"v_ok": _item("v_ok", "upload"), "v_noviews": broken})  # v_gone: not returned at all

    summary = _run(s3, youtube)

    assert summary["unavailableVideoIds"] == ["v_gone"]
    assert summary["unparseableVideoIds"] == ["v_noviews"]
    assert summary["apiFailedVideoIds"] == []
    assert summary["status"] == backfill.STATUS_COMPLETE  # an expected, separately reported outcome, not a failure
    for video_id in ("v_gone", "v_noviews"):
        assert _master()[video_id].content_type is None and _master()[video_id].live_status is None
        assert _manifest(s3)[video_id].content_type is None and _manifest(s3)[video_id].live_status is None
    assert _master()["v_ok"].content_type == "upload"


def test_unavailable_ids_are_left_untouched_on_a_rerun_and_only_they_are_requested_again(s3):
    _seed(s3, [_video("v_ok"), _video("v_gone")])
    youtube = FakeYouTube({"v_ok": _item("v_ok", "upload")})
    _run(s3, youtube)
    youtube.calls.clear()

    summary = _run(s3, youtube)

    assert youtube.requested_ids == ["v_gone"]  # bounded: only the unavailable id is asked about again
    assert summary["unavailableVideoIds"] == ["v_gone"] and summary["masterWritten"] == 0


def test_a_rerun_after_a_complete_run_is_a_no_op(s3):
    ids = _ids_for_shard("v", 3, 60)
    _seed(s3, [_video(video_id) for video_id in ids])
    youtube = FakeYouTube({video_id: _item(video_id, "completed") for video_id in ids})
    _run(s3, youtube)
    master_before, manifest_before, etags_before = _master(), _manifest(s3), _etags(s3)
    attempts_before = youtube.attempts

    again = _run(s3, youtube)

    assert again["status"] == backfill.STATUS_COMPLETE and again["entriesIncomplete"] == 0
    assert youtube.attempts == attempts_before  # not one more YouTube request
    assert again["masterWritten"] == 0 and again["manifestShardsPatched"] == 0
    assert _master() == master_before and _manifest(s3) == manifest_before and _etags(s3) == etags_before


def test_a_run_interrupted_after_video_master_but_before_the_manifest_resumes_without_youtube(s3, monkeypatch):
    ids = _ids_for_shard("v", 5, 30)
    _seed(s3, [_video(video_id) for video_id in ids])
    youtube = FakeYouTube({video_id: _item(video_id, "upload") for video_id in ids})

    def _manifest_write_fails(self, shard, entries, *, version):
        raise TrackingManifestError("simulated S3 failure")

    with monkeypatch.context() as patched:
        patched.setattr(S3TrackingManifestStore, "write_shard_if_version", _manifest_write_fails)
        first = _run(s3, youtube)

    assert first["status"] == backfill.STATUS_PARTIAL and first["manifestShardErrors"] == 1
    assert all(v.content_type == "upload" for v in _master().values())  # Video Master (the truth) is done
    assert all(e.content_type is None for e in _manifest(s3).values())  # the manifest is not
    attempts_before = youtube.attempts

    second = _run(s3, youtube)

    assert second["status"] == backfill.STATUS_COMPLETE
    assert second["toObserveOnYouTube"] == 0 and second["manifestSyncFromMasterOnly"] == 30
    assert youtube.attempts == attempts_before  # synced from Video Master, no second YouTube request
    assert all(e.content_type == "upload" for e in _manifest(s3).values())


def test_a_manifest_that_is_ahead_of_video_master_heals_video_master_without_youtube(s3):
    _seed(s3, [_video("v1")])
    store = _store(s3)
    patch_shard(
        store,
        shard_for_video("v1"),
        lambda entries: [replace(e, content_type="live", live_status="completed") for e in entries],
    )
    youtube = FakeYouTube({"v1": _item("v1", "upload")})

    summary = _run(s3, youtube)

    assert summary["masterHealFromManifest"] == 1 and youtube.attempts == 0
    assert (_master()["v1"].content_type, _master()["v1"].live_status) == ("live", "completed")


def test_a_concurrent_classification_wins_and_the_manifest_follows_video_master(s3):
    _seed(s3, [_video("v1")])
    youtube = FakeYouTube({"v1": _item("v1", "completed")})

    def racing_write(video_id, content_type, live_status):
        set_video_classification(video_id, "upload", None)  # another writer got there first
        return set_video_classification(video_id, content_type, live_status)  # -> rejected by the condition

    summary = _run(s3, youtube, write_classification=racing_write)

    assert summary["masterRejectedAlreadyClassified"] == 1 and summary["masterWritten"] == 0
    assert (_master()["v1"].content_type, _master()["v1"].live_status) == ("upload", None)  # never overwritten
    assert (_manifest(s3)["v1"].content_type, _manifest(s3)["v1"].live_status) == ("upload", None)  # follows the truth
    assert summary["status"] == backfill.STATUS_COMPLETE


def test_a_manifest_entry_classified_meanwhile_is_never_overwritten_by_the_patch(s3):
    """Non-destructive to already classified rows: the patch re-checks each entry against the shard's CURRENT state."""
    _seed(s3, [_video("v1")])
    youtube = FakeYouTube({"v1": _item("v1", "completed")})

    def classified_by_someone_else_mid_run(client, batch):
        patch_shard(
            _store(s3),
            shard_for_video("v1"),
            lambda entries: [replace(e, content_type="upload", live_status=None) for e in entries],
        )
        return backfill.get_video_statistics(client, batch)

    summary = _run(s3, youtube, get_statistics=classified_by_someone_else_mid_run)

    assert summary["manifestEntriesPatched"] == 0
    assert (_manifest(s3)["v1"].content_type, _manifest(s3)["v1"].live_status) == ("upload", None)


def test_rows_classified_differently_in_video_master_and_the_manifest_are_reported_never_overwritten(s3):
    _seed(s3, [_video("v1", content_type="live", live_status="completed")])
    patch_shard(
        _store(s3),
        shard_for_video("v1"),
        lambda entries: [replace(e, content_type="upload", live_status=None) for e in entries],
    )
    youtube = FakeYouTube({"v1": _item("v1", "upcoming")})

    summary = _run(s3, youtube)

    assert summary["classifiedButDivergent"] == 1 and youtube.attempts == 0 and summary["masterWritten"] == 0
    assert (_master()["v1"].content_type, _master()["v1"].live_status) == ("live", "completed")
    assert (_manifest(s3)["v1"].content_type, _manifest(s3)["v1"].live_status) == ("upload", None)


def test_manifest_entries_without_a_video_master_row_are_reported_not_classified(s3):
    _seed(s3, [_video("v_known")])
    store = _store(s3)
    ghost_shard = shard_for_video("v_ghost")
    patch_shard(store, ghost_shard, lambda entries: entries + [replace(_manifest(s3)["v_known"], video_id="v_ghost")])
    youtube = FakeYouTube({"v_known": _item("v_known", "upload"), "v_ghost": _item("v_ghost", "upload")})

    summary = _run(s3, youtube)

    assert summary["noMasterRowVideoIds"] == ["v_ghost"]
    assert "v_ghost" not in youtube.requested_ids  # nothing can persist for it, so no quota is spent on it
    assert _manifest(s3)["v_ghost"].content_type is None


def test_a_non_active_manifest_entry_is_ignored(s3):
    _seed(s3, [_video("v1"), _video("v_off")])
    patch_shard(
        _store(s3),
        shard_for_video("v_off"),
        lambda entries: [replace(e, active=False) if e.video_id == "v_off" else e for e in entries],
    )
    youtube = FakeYouTube({"v1": _item("v1", "upload"), "v_off": _item("v_off", "upload")})

    summary = _run(s3, youtube)

    assert summary["inactiveEntriesIgnored"] == 1 and "v_off" not in youtube.requested_ids


# --- stopping safely: quota, deadline, the pre-start guard -----------------------------------------------


def test_quota_exhaustion_persists_what_was_fetched_stops_and_a_rerun_finishes(s3):
    ids = _ids_for_shard("v", 0, 120)
    _seed(s3, [_video(video_id) for video_id in ids])
    youtube = FakeYouTube({video_id: _item(video_id, "upload") for video_id in ids})
    calls = {"n": 0}

    def quota_gone_after_one_batch(client, batch):
        calls["n"] += 1
        if calls["n"] > 1:
            raise QuotaExhaustedError("quota exhausted")
        return backfill.get_video_statistics(client, batch)

    first = _run(s3, youtube, get_statistics=quota_gone_after_one_batch)

    assert first["status"] == backfill.STATUS_FAILED and "quota" in first["abortedReason"].lower()
    assert first["observedClassified"] == 50 and first["deferredNotAttempted"] == 70
    assert sum(1 for v in _master().values() if v.content_type) == 50  # the paid-for batch was persisted
    assert sum(1 for e in _manifest(s3).values() if e.content_type) == 50

    second = _run(s3, youtube)

    assert second["status"] == backfill.STATUS_COMPLETE
    assert all(v.content_type == "upload" for v in _master().values())


def test_the_deadline_stops_new_batches_before_stop_at_and_a_later_rerun_resumes(s3):
    ids = _ids_for_shard("v", 0, 120)
    _seed(s3, [_video(video_id) for video_id in ids])
    youtube = FakeYouTube({video_id: _item(video_id, "upload") for video_id in ids})
    clock = {"now": NOW}

    def slow_batches(client, batch):
        clock["now"] += timedelta(minutes=25)  # each request "takes" 25 minutes
        return backfill.get_video_statistics(client, batch)

    first = _run(s3, youtube, stop_at=NOW + timedelta(minutes=45), now_fn=lambda: clock["now"], get_statistics=slow_batches)

    assert first["stoppedByDeadline"] is True and first["status"] == backfill.STATUS_PARTIAL
    assert first["youtubeRequests"] == 2 and first["deferredNotAttempted"] == 20
    assert sum(1 for e in _manifest(s3).values() if e.content_type) == 100  # the finished batches are durable

    youtube.calls.clear()
    second = _run(s3, youtube)

    assert second["status"] == backfill.STATUS_COMPLETE
    assert youtube.requested_ids == ids[100:]  # exactly the deferred 20


def test_execute_refuses_to_start_when_the_estimate_cannot_finish_before_stop_at(s3):
    _seed(s3, [_video(f"v{n}") for n in range(25)])
    master_before, manifest_before, etags_before = _master(), _manifest(s3), _etags(s3)

    def _must_not_be_called():
        raise AssertionError("no YouTube client may be built when the guard refuses")

    summary = backfill.backfill_classification(
        execute=True,
        manifest_store=_store(s3),
        youtube_factory=_must_not_be_called,
        stop_at=NOW + timedelta(minutes=5),
        now_fn=lambda: NOW,
    )

    assert summary["guardRefused"] is True and summary["status"] == backfill.STATUS_FAILED
    assert backfill._exit_code(summary) == 2
    assert summary["masterWritten"] == 0 and summary["youtubeRequests"] == 0
    assert _master() == master_before and _manifest(s3) == manifest_before and _etags(s3) == etags_before


def test_a_systemic_write_failure_aborts_instead_of_failing_every_item_one_by_one(s3):
    ids = _ids_for_shard("v", 0, 60)
    _seed(s3, [_video(video_id) for video_id in ids])
    youtube = FakeYouTube({video_id: _item(video_id, "upload") for video_id in ids})

    def broken_table(video_id, content_type, live_status):
        raise dynamodb_store.VideoMasterError("simulated outage")

    summary = _run(s3, youtube, write_classification=broken_table)

    assert summary["status"] == backfill.STATUS_FAILED and "writes failed" in summary["abortedReason"]
    assert summary["masterWritten"] == 0
    assert all(e.content_type is None for e in _manifest(s3).values())  # nothing reached the manifest


def test_a_youtube_client_that_cannot_be_built_aborts_before_any_write(s3):
    """A missing API key must be found BEFORE the first Video Master/manifest write, not at the first batch."""
    _seed(s3, [_video("v1")])
    master_before, manifest_before, etags_before = _master(), _manifest(s3), _etags(s3)

    def no_api_key():
        raise RuntimeError("YOUTUBE_API_KEY is not configured")

    summary = backfill.backfill_classification(
        execute=True, manifest_store=_store(s3), youtube_factory=no_api_key, stop_at=STOP_AT, now_fn=lambda: NOW
    )

    assert summary["preflightFailed"] is True and backfill._exit_code(summary) == 2
    assert summary["youtubeRequests"] == 0 and summary["masterWritten"] == 0
    assert _master() == master_before and _manifest(s3) == manifest_before and _etags(s3) == etags_before


def test_an_unreadable_manifest_aborts_before_any_write(s3, monkeypatch):
    _seed(s3, [_video("v1")])
    master_before = _master()

    def unreadable(self, shard):
        raise TrackingManifestError("simulated read failure")

    monkeypatch.setattr(S3TrackingManifestStore, "read_shard_for_patch", unreadable)

    summary = _run(s3, FakeYouTube({"v1": _item("v1", "upload")}))

    assert summary["preflightFailed"] is True and backfill._exit_code(summary) == 2
    assert _master() == master_before and summary["masterWritten"] == 0


# --- persistence: the classification must survive the collector's own republish --------------------------


def test_the_collectors_full_manifest_publication_preserves_the_classification(s3):
    """The real collection.main._publish_manifest_if_configured (rebuild from Video Master) keeps contentType/liveStatus."""
    videos = [_video("v_up"), _video("v_done"), _video("v_live"), _video("v_soon"), _video("v_old", content_type="upload")]
    _seed(s3, videos)
    youtube = FakeYouTube(
        {
            "v_up": _item("v_up", "upload"),
            "v_done": _item("v_done", "completed"),
            "v_live": _item("v_live", "live"),
            "v_soon": _item("v_soon", "upcoming"),
        }
    )
    _run(s3, youtube)
    classified = {vid: (e.content_type, e.live_status) for vid, e in _manifest(s3).items()}
    assert classified == {
        "v_up": ("upload", None),
        "v_done": ("live", "completed"),
        "v_live": ("live", "live"),
        "v_soon": ("live", "upcoming"),
        "v_old": ("upload", None),
    }

    collector_main._publish_manifest_if_configured(dynamodb_store.load_videos())

    assert {vid: (e.content_type, e.live_status) for vid, e in _manifest(s3).items()} == classified
    assert not any(is_classification_incomplete(e.content_type, e.live_status) for e in _manifest(s3).values())


def test_a_manifest_only_patch_would_NOT_survive_the_same_republish(s3):
    """Why Video Master is written first: patching just the manifest is erased by the next full publication."""
    _seed(s3, [_video("v1")])
    patch_shard(
        _store(s3),
        shard_for_video("v1"),
        lambda entries: [replace(e, content_type="upload", live_status=None) for e in entries],
    )
    assert _manifest(s3)["v1"].content_type == "upload"

    collector_main._publish_manifest_if_configured(dynamodb_store.load_videos())

    assert _manifest(s3)["v1"].content_type is None  # lost: Video Master never knew


def test_the_nightly_discovery_patch_never_regresses_a_backfilled_entry(s3):
    """run_discovery's incremental patch (setdefault: an existing entry always wins) keeps the classification."""
    _seed(s3, [_video("v1")])
    _run(s3, FakeYouTube({"v1": _item("v1", "completed")}))

    collector_main._patch_manifest_with_new_videos_if_configured([_video("v1")])  # re-"discovered" unclassified

    entry = _manifest(s3)["v1"]
    assert (entry.content_type, entry.live_status) == ("live", "completed")


# --- the command line -------------------------------------------------------------------------------------


@pytest.fixture
def cli(monkeypatch):
    """main() with the backfill itself replaced by a recorder, so no AWS or YouTube is ever reached."""
    calls = []

    def fake_backfill(**kwargs):
        calls.append(kwargs)
        return {key: [] for key in backfill._ID_LIST_KEYS} | {"status": backfill.STATUS_DRY_RUN, "mode": "DRY RUN"}

    monkeypatch.setenv("YOBI_HISTORY_BUCKET", BUCKET)
    monkeypatch.setattr(backfill, "backfill_classification", fake_backfill)
    monkeypatch.setattr(backfill, "S3TrackingManifestStore", lambda bucket: SimpleNamespace(bucket_name=bucket))
    return SimpleNamespace(calls=calls)


def _future_stop_at() -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=3)).isoformat()


def test_no_flags_is_a_dry_run(cli, capsys):
    assert backfill.main([]) == 0

    assert [call["execute"] for call in cli.calls] == [False]
    assert "DRY RUN" in capsys.readouterr().out


def test_execute_without_yes_is_refused_with_zero_writes(cli, capsys):
    assert backfill.main(["--execute", "--stop-at", _future_stop_at()]) == 2

    assert cli.calls == []
    assert "--yes" in capsys.readouterr().out


def test_execute_without_stop_at_is_refused(cli, capsys):
    assert backfill.main(["--execute", "--yes"]) == 2

    assert cli.calls == [] and "--stop-at" in capsys.readouterr().out


@pytest.mark.parametrize("bad", ["2026-10-02T17:30:00", "not-a-time"])
def test_a_naive_or_malformed_stop_at_is_refused(cli, bad):
    assert backfill.main(["--execute", "--yes", "--stop-at", bad]) == 2
    assert cli.calls == []


def test_a_stop_at_in_the_past_is_refused(cli):
    assert backfill.main(["--execute", "--yes", "--stop-at", "2020-01-01T00:00:00+00:00"]) == 2
    assert cli.calls == []


def test_the_manifest_bucket_must_be_configured_explicitly_with_no_default(cli, monkeypatch):
    monkeypatch.delenv("YOBI_HISTORY_BUCKET", raising=False)

    assert backfill.main([]) == 2
    assert cli.calls == []


@pytest.mark.parametrize("abbreviation", ["--exe", "--exec", "--execut", "--ye", "--stop", "--rep"])
def test_flag_abbreviations_are_rejected_and_never_reach_the_backfill(cli, abbreviation):
    with pytest.raises(SystemExit) as exit_info:
        backfill.main([abbreviation, "2026-10-02T17:30:00+09:00"] if abbreviation == "--stop" else [abbreviation])

    assert exit_info.value.code == 2 and cli.calls == []


def test_execute_with_every_required_flag_is_the_only_way_to_write(cli):
    stop_at = _future_stop_at()

    assert backfill.main(["--execute", "--yes", "--stop-at", stop_at]) in (0, 1)

    assert [call["execute"] for call in cli.calls] == [True]
    assert cli.calls[0]["stop_at"] == datetime.fromisoformat(stop_at)


def test_the_report_file_holds_the_full_id_lists(cli, tmp_path, monkeypatch):
    path = tmp_path / "report.json"
    monkeypatch.setattr(
        backfill,
        "backfill_classification",
        lambda **kwargs: {key: [] for key in backfill._ID_LIST_KEYS}
        | {"unavailableVideoIds": ["a", "b"], "status": backfill.STATUS_DRY_RUN, "mode": "DRY RUN"},
    )

    backfill.main(["--report-file", str(path)])

    assert json.loads(path.read_text(encoding="utf-8"))["unavailableVideoIds"] == ["a", "b"]
