"""Regression coverage for scripts/backfill_video_master.py.

Guards the specific safety properties this one-time targeted backfill was
designed around: it may only ever touch the two audited creators, it must
never create a notification event, and re-running it must not duplicate
VideoMaster rows. See the script's own module docstring for the full
incident this exists to fix (a wrong youtubeChannelId for two creators,
found via a channel-identity audit).
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from unittest.mock import MagicMock

import boto3
import pytest
from moto import mock_aws

_MODULE_PATH = Path(__file__).resolve().parent.parent / "scripts" / "backfill_video_master.py"
_spec = importlib.util.spec_from_file_location("backfill_video_master", _MODULE_PATH)
backfill_video_master = importlib.util.module_from_spec(_spec)
sys.modules.setdefault("backfill_video_master", backfill_video_master)
_spec.loader.exec_module(backfill_video_master)

from dynamodb_store import CREATOR_ID_INDEX, VIDEO_MASTER_TABLE  # noqa: E402
from notification_events_store import NOTIFICATION_EVENTS_TABLE  # noqa: E402

AWS_REGION = "ap-northeast-1"

CORRECT_ELIZABETH_CHANNEL = "UCW5uhrG1eCBYditmhL0Ykjw"
CORRECT_GIGI_CHANNEL = "UCDHABijvPBnJm7F-KlNME3w"


@pytest.fixture
def dynamodb_tables(aws_credentials, monkeypatch):
    """VideoMaster (with its creatorId-index GSI) + NotificationEvents, inside moto."""
    monkeypatch.setenv("YOBI_STORAGE_BACKEND", "dynamodb")
    with mock_aws():
        client = boto3.client("dynamodb", region_name=AWS_REGION)
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
            TableName=NOTIFICATION_EVENTS_TABLE,
            AttributeDefinitions=[
                {"AttributeName": "eventDate", "AttributeType": "S"},
                {"AttributeName": "videoId", "AttributeType": "S"},
            ],
            KeySchema=[
                {"AttributeName": "eventDate", "KeyType": "HASH"},
                {"AttributeName": "videoId", "KeyType": "RANGE"},
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        yield client


def _channels_response(uploads_playlist_id):
    return {"items": [{"contentDetails": {"relatedPlaylists": {"uploads": uploads_playlist_id}}}]}


def _playlist_item(video_id, title, published_at):
    return {
        "snippet": {
            "resourceId": {"videoId": video_id},
            "title": title,
            "publishedAt": published_at,
        }
    }


def _fake_youtube(videos: list[tuple[str, str, str]]):
    """A MagicMock youtube client resolving to one playlist page of the given (id, title, publishedAt) tuples."""
    youtube = MagicMock()
    youtube.channels.return_value.list.return_value.execute.return_value = _channels_response("UU_TEST_UPLOADS")
    youtube.playlistItems.return_value.list.return_value.execute.return_value = {
        "items": [_playlist_item(*v) for v in videos]
    }
    return youtube


def _notification_events_count(client) -> int:
    return client.scan(TableName=NOTIFICATION_EVENTS_TABLE)["Count"]


def _video_master_count(client) -> int:
    return client.scan(TableName=VIDEO_MASTER_TABLE)["Count"]


def test_rejects_a_creator_id_outside_the_authorized_two(dynamodb_tables):
    youtube = _fake_youtube([])
    with pytest.raises(backfill_video_master.UnauthorizedCreatorError):
        backfill_video_master.backfill_creator(
            youtube, "sakura_miko", "UC-hM6YJuNYVAmUWxeIr9FeA", execute=False
        )


def test_rejects_a_channel_id_that_does_not_match_the_confirmed_correct_one(dynamodb_tables):
    youtube = _fake_youtube([])
    with pytest.raises(backfill_video_master.UnauthorizedCreatorError):
        backfill_video_master.backfill_creator(
            youtube, "elizabeth_rose_bloodflame", "UC--YolkGxqTiZtZss9ug3uQ", execute=False
        )


def test_dry_run_reports_without_writing_anything(dynamodb_tables):
    youtube = _fake_youtube(
        [
            ("vid1", "Video 1", "2026-01-01T00:00:00Z"),
            ("vid2", "Video 2", "2026-06-15T00:00:00Z"),
        ]
    )

    summary = backfill_video_master.backfill_creator(
        youtube, "elizabeth_rose_bloodflame", CORRECT_ELIZABETH_CHANNEL, execute=False
    )

    assert summary == {
        "creatorId": "elizabeth_rose_bloodflame",
        "videosFound": 2,
        "alreadyExisting": 0,
        "toInsert": 2,
        "oldestPublishedAt": "2026-01-01T00:00:00Z",
        "newestPublishedAt": "2026-06-15T00:00:00Z",
    }
    assert _video_master_count(dynamodb_tables) == 0


def test_execute_writes_expected_video_master_rows_with_correct_creator_id(dynamodb_tables):
    youtube = _fake_youtube([("vid1", "Video 1", "2026-01-01T00:00:00Z")])

    backfill_video_master.backfill_creator(
        youtube, "gigi_murin", CORRECT_GIGI_CHANNEL, execute=True
    )

    from dynamodb_store import get_videos_by_creator

    videos = get_videos_by_creator("gigi_murin")
    assert len(videos) == 1
    assert videos[0].video_id == "vid1"
    assert videos[0].creator_id == "gigi_murin"
    assert videos[0].title == "Video 1"
    assert videos[0].published_at == "2026-01-01T00:00:00Z"
    # Bootstrap defaults only -- no fabricated statistics.
    assert videos[0].last_view_count is None
    assert videos[0].snapshot_count == 0
    assert videos[0].activity_state == "Unknown"


def test_never_creates_a_notification_event(dynamodb_tables):
    youtube = _fake_youtube(
        [
            ("vid1", "Video 1", "2026-01-01T00:00:00Z"),
            ("vid2", "Video 2", "2026-06-15T00:00:00Z"),
        ]
    )

    backfill_video_master.backfill_creator(
        youtube, "elizabeth_rose_bloodflame", CORRECT_ELIZABETH_CHANNEL, execute=True
    )

    assert _notification_events_count(dynamodb_tables) == 0


def test_rerunning_is_idempotent(dynamodb_tables):
    youtube = _fake_youtube(
        [
            ("vid1", "Video 1", "2026-01-01T00:00:00Z"),
            ("vid2", "Video 2", "2026-06-15T00:00:00Z"),
        ]
    )

    first = backfill_video_master.backfill_creator(
        youtube, "gigi_murin", CORRECT_GIGI_CHANNEL, execute=True
    )
    assert first["toInsert"] == 2
    assert _video_master_count(dynamodb_tables) == 2

    second = backfill_video_master.backfill_creator(
        youtube, "gigi_murin", CORRECT_GIGI_CHANNEL, execute=True
    )
    assert second["toInsert"] == 0
    assert second["alreadyExisting"] == 2
    # No duplicate rows -- still exactly 2.
    assert _video_master_count(dynamodb_tables) == 2


def test_module_never_imports_notification_or_trending_cache_modules():
    """Static guard alongside the behavioral one above: this script has no
    code path that could reach notification dispatch or TrendingCache.

    Checked against actual `import`/`from ... import` lines only (not the
    module's own docstring prose, which names these modules to explain what
    it deliberately does NOT do)."""
    import_lines = [
        line.strip()
        for line in _MODULE_PATH.read_text(encoding="utf-8").splitlines()
        if line.strip().startswith(("import ", "from "))
    ]
    forbidden = ("notification_events_store", "notification_dispatch", "trending_cache", "tracking_manifest")
    for line in import_lines:
        for name in forbidden:
            assert name not in line, f"backfill_video_master.py must never import {name!r} (found: {line!r})"
