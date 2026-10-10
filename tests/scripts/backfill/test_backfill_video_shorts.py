"""Focused tests for scripts/backfill/backfill_video_shorts.py (B18): marking already-stored Shorts.

The real conditional Video Master write, the real manifest patch and the real stores run on moto; only the YouTube
Shorts-shelf lookup is faked. The script is never run against production."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

_MODULE_PATH = Path(__file__).resolve().parents[3] / "scripts" / "backfill" / "backfill_video_shorts.py"
_spec = importlib.util.spec_from_file_location("backfill_video_shorts", _MODULE_PATH)
backfill = importlib.util.module_from_spec(_spec)
sys.modules.setdefault("backfill_video_shorts", backfill)
_spec.loader.exec_module(backfill)

from collection.youtube_client import QuotaExhaustedError, YouTubeAPIError  # noqa: E402
from stores import dynamodb_store  # noqa: E402
from stores.dynamodb_store import CREATOR_ID_INDEX, VIDEO_MASTER_TABLE, get_video, set_video_short, upsert_videos  # noqa: E402
from stores.history_store import shard_for_video  # noqa: E402
from tracking.creator_master import Creator  # noqa: E402
from tracking.tracking_manifest import S3TrackingManifestStore, publish_tracking_manifest  # noqa: E402
from tracking.video_master import Video  # noqa: E402

AWS_REGION = "ap-northeast-1"
BUCKET = "test-history-bucket"


def _creator(creator_id="c1", channel_id="UCc1") -> Creator:
    return Creator(
        creator_id=creator_id, display_name=creator_id, organization="vspo", youtube_channel_id=channel_id, active=True,
        branch="vspo_jp", group_key=["NO"], channel_type="member", lifecycle_stage="active", display_order=0,
    )


@pytest.fixture
def s3(aws_credentials, monkeypatch):
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
                {"IndexName": CREATOR_ID_INDEX, "KeySchema": [{"AttributeName": "creatorId", "KeyType": "HASH"}], "Projection": {"ProjectionType": "ALL"}}
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        client = boto3.client("s3", region_name=AWS_REGION)
        client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": AWS_REGION})
        yield client


def _video(video_id, *, content_type=None, live_status=None, creator_id="c1") -> Video:
    return Video(
        video_id=video_id, creator_id=creator_id, title=f"title {video_id}", published_at="2026-09-01T00:00:00Z",
        activity_state="Hot", last_view_count=1234, snapshot_count=7, topic="mv", content_type=content_type, live_status=live_status,
    )


def _seed(client, videos):
    upsert_videos(videos)
    publish_tracking_manifest(videos, S3TrackingManifestStore(BUCKET, s3_client=client))


def _manifest(client, video_id):
    return next(entry for entry in S3TrackingManifestStore(BUCKET, s3_client=client).read_shard(shard_for_video(video_id)) if entry.video_id == video_id)


def _shelf(monkeypatch, shelves: dict[str, set[str]] | Exception):
    """The Shorts-shelf lookup: playlist id -> the video ids on it (or an error for every creator)."""

    def lookup(youtube, playlist_id, known=None):
        if isinstance(shelves, Exception):
            raise shelves
        value = shelves.get(playlist_id, set())
        if isinstance(value, Exception):
            raise value
        return set(value)

    monkeypatch.setattr(backfill, "discover_short_video_ids", lookup)


def _run(client, *, execute, creators=None, manifest=True):
    return backfill.backfill_shorts(
        youtube=object(),
        creators=creators or [_creator()],
        execute=execute,
        manifest_store=S3TrackingManifestStore(BUCKET, s3_client=client) if manifest else None,
    )


def _stored(video_id):
    return get_video(video_id)


@pytest.fixture
def catalog(s3):
    """Shelf = short-up, short-none, short-live (anomaly), short-gone (not stored); not on the shelf: normal, normal-live."""
    _seed(
        s3,
        [
            _video("short-up", content_type="upload"),
            _video("short-none"),
            _video("short-live", content_type="live", live_status="completed"),
            _video("normal", content_type="upload"),
            _video("normal-live", content_type="live", live_status="completed"),
        ],
    )
    return s3


def test_a_dry_run_plans_the_writes_and_changes_nothing(catalog, monkeypatch):
    _shelf(monkeypatch, {"UUSHc1": {"short-up", "short-none", "short-live", "short-gone"}})

    summary = _run(catalog, execute=False)

    assert summary["status"] == backfill.STATUS_DRY_RUN
    assert (summary["shortsOnShelves"], summary["wouldUpdate"], summary["attempted"], summary["updated"]) == (4, 2, 0, 0)
    assert summary["unexpectedLive"] == 1 and summary["shelfVideosNotInVideoMaster"] == 1
    assert summary["manifestEntriesPatchable"] == 2
    assert _stored("short-up").content_type == "upload" and _stored("short-none").content_type is None
    assert _manifest(catalog, "short-up").content_type == "upload"


def test_execute_marks_only_stored_uploads_and_unclassified_shorts_in_video_master_and_the_manifest(catalog, monkeypatch):
    _shelf(monkeypatch, {"UUSHc1": {"short-up", "short-none", "short-live", "short-gone"}})

    summary = _run(catalog, execute=True)

    assert summary["status"] == backfill.STATUS_COMPLETE
    assert (summary["attempted"], summary["updated"], summary["manifestEntriesPatched"]) == (2, 2, 2)
    for video_id in ("short-up", "short-none"):
        video = _stored(video_id)
        assert (video.content_type, video.live_status) == ("short", None)
        assert (video.topic, video.snapshot_count, video.last_view_count, video.activity_state) == ("mv", 7, 1234, "Hot")
        entry = _manifest(catalog, video_id)
        assert (entry.content_type, entry.live_status) == ("short", None)
    # a livestream on the shelf (anomaly), a video off the shelf and a livestream off the shelf are left exactly alone
    assert (_stored("short-live").content_type, _stored("short-live").live_status) == ("live", "completed")
    assert _stored("normal").content_type == "upload" and _manifest(catalog, "normal").content_type == "upload"
    assert (_manifest(catalog, "normal-live").content_type, _manifest(catalog, "normal-live").live_status) == ("live", "completed")


def test_a_rerun_is_idempotent(catalog, monkeypatch):
    _shelf(monkeypatch, {"UUSHc1": {"short-up", "short-none"}})
    _run(catalog, execute=True)

    again = _run(catalog, execute=True)

    assert again["status"] == backfill.STATUS_COMPLETE
    assert (again["wouldUpdate"], again["attempted"], again["alreadyShort"], again["manifestEntriesPatchable"]) == (0, 0, 2, 0)


def test_an_interrupted_run_is_finished_by_aligning_the_manifest_of_an_already_short_record(catalog, monkeypatch):
    _shelf(monkeypatch, {"UUSHc1": {"short-up"}})
    assert set_video_short("short-up") is True  # Video Master written, manifest not yet patched

    summary = _run(catalog, execute=True)

    assert summary["alreadyShort"] == 1 and summary["manifestEntriesPatched"] == 1
    assert _manifest(catalog, "short-up").content_type == "short"
    assert summary["status"] == backfill.STATUS_COMPLETE


def test_an_unreadable_or_empty_manifest_aborts_before_any_write(s3, monkeypatch):
    upsert_videos([_video("short-up", content_type="upload")])  # Video Master only: the manifest is empty
    _shelf(monkeypatch, {"UUSHc1": {"short-up"}})

    summary = _run(s3, execute=True)

    assert summary["preflightFailed"] is True and summary["status"] == backfill.STATUS_FAILED
    assert _stored("short-up").content_type == "upload"
    assert backfill._exit_code(summary) == 2


def test_one_creators_failed_lookup_is_isolated_and_the_run_is_reported_partial(s3, monkeypatch):
    _seed(s3, [_video("a-short", content_type="upload", creator_id="a"), _video("b-short", content_type="upload", creator_id="b")])
    _shelf(monkeypatch, {"UUSHa": YouTubeAPIError("YouTube API request failed (status 500): backend error"), "UUSHb": {"b-short"}})

    summary = _run(s3, execute=True, creators=[_creator("a", "UCa"), _creator("b", "UCb")])

    assert summary["creatorErrors"] == 1 and summary["status"].startswith("PARTIAL")
    assert _stored("a-short").content_type == "upload" and _stored("b-short").content_type == "short"


def test_exhausted_quota_aborts_the_run(s3, monkeypatch):
    _seed(s3, [_video("a-short", content_type="upload", creator_id="a")])
    _shelf(monkeypatch, {"UUSHa": QuotaExhaustedError("quota")})

    summary = _run(s3, execute=True, creators=[_creator("a", "UCa")])

    assert summary["status"] == backfill.STATUS_FAILED and "quota" in summary["abortedReason"]


def test_a_write_rejected_by_the_condition_is_counted_not_hidden(catalog, monkeypatch):
    _shelf(monkeypatch, {"UUSHc1": {"short-up"}})
    monkeypatch.setattr(backfill, "set_video_short", lambda video_id: False)  # e.g. another writer got there first

    summary = _run(catalog, execute=True)

    assert summary["skippedConcurrent"] == 1 and summary["updated"] == 0 and summary["status"].startswith("PARTIAL")


def test_a_creator_without_a_uc_channel_id_has_no_shelf_and_is_skipped(s3, monkeypatch):
    _seed(s3, [_video("x", content_type="upload")])
    _shelf(monkeypatch, {})

    summary = _run(s3, execute=False, creators=[_creator("c1", "not-a-uc-id")])

    assert summary["creatorsWithoutShortsPlaylist"] == 1 and summary["shortsOnShelves"] == 0


def test_the_cli_refuses_to_write_without_yes_and_never_builds_a_youtube_client(monkeypatch, capsys):
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", BUCKET)

    assert backfill.main(["--execute"]) == 2
    assert "Refusing to write without --yes" in capsys.readouterr().out


def test_the_cli_refuses_a_report_file_inside_the_repository(monkeypatch, capsys):
    assert backfill.main(["--report-file", str(backfill.REPO_ROOT / "report.json")]) == 2
    assert "outside the repository" in capsys.readouterr().out
