"""Focused tests for scripts/backfill/backfill_graduated_history.py: the one-time graduated-creator catalog/read-model
repair. YouTube and VideoMaster are faked; the manifest and the video-ranking store are the real S3 stores on moto, so
idempotency and "existing entries win" are exercised against the real conditional-write code."""

from __future__ import annotations

import ast
import importlib.util
import sys
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import boto3
import pytest
from moto import mock_aws

_MODULE_PATH = Path(__file__).resolve().parents[3] / "scripts" / "backfill" / "backfill_graduated_history.py"
_spec = importlib.util.spec_from_file_location("backfill_graduated_history", _MODULE_PATH)
script = importlib.util.module_from_spec(_spec)
sys.modules.setdefault("backfill_graduated_history", script)
_spec.loader.exec_module(script)

from collection.youtube_client import YouTubeAPIError  # noqa: E402
from stores.history_store import shard_for_video  # noqa: E402
from stores.video_ranking_store import S3VideoRankingStore  # noqa: E402
from tracking.creator_master import is_content_collection_eligible, is_live_status_polling_eligible, load_creators  # noqa: E402
from tracking.tracking_manifest import ManifestEntry, S3TrackingManifestStore  # noqa: E402
from tracking.video_master import Video  # noqa: E402

BUCKET = "test-history-bucket"
REGION = "ap-northeast-1"
NOW = datetime(2026, 10, 5, 10, 30, tzinfo=ZoneInfo("Asia/Tokyo"))
TODAY = NOW.date()
REAL = {creator.creator_id: creator for creator in load_creators()}


class FakeYouTube:
    """Stands in for the YouTube API: per-creator upload lists plus per-video current stats."""

    def __init__(self):
        self.uploads: dict[str, list[dict] | None] = {}  # channel id -> uploads, None = channel does not exist
        self.missing_playlist: set[str] = set()  # channel ids whose uploads playlist answers 404 (playlistNotFound)
        self.quota_blocked: set[str] = set()  # channel ids whose playlist read fails with a non-404 error
        self.stats: dict[str, dict] = {}  # video id -> stats entry
        self.stat_requests: list[list[str]] = []


class FakeMaster:
    """In-memory VideoMaster with the two operations the script needs."""

    def __init__(self):
        self.videos: dict[str, Video] = {}
        self.upsert_calls: list[list[str]] = []

    def load(self, creator_id: str) -> list[Video]:
        return [video for video in self.videos.values() if video.creator_id == creator_id]

    def upsert(self, videos: list[Video]) -> None:
        self.upsert_calls.append([video.video_id for video in videos])
        for video in videos:
            self.videos[video.video_id] = video


@pytest.fixture
def env(aws_credentials, monkeypatch):
    youtube = FakeYouTube()
    master = FakeMaster()

    def fake_playlist_id(_youtube, channel_id):
        if youtube.uploads.get(channel_id, []) is None:
            raise YouTubeAPIError(f"No channel found for channel ID {channel_id!r}")
        return channel_id

    monkeypatch.setattr(script, "get_uploads_playlist_id", fake_playlist_id)
    def fake_discover(_youtube, playlist_id):
        if playlist_id in youtube.missing_playlist:
            raise YouTubeAPIError(
                "YouTube API request failed (status 404): The playlist identified with the request's "
                "<code>playlistId</code> parameter cannot be found."
            )
        if playlist_id in youtube.quota_blocked:
            raise YouTubeAPIError("YouTube quota exhausted (status 403, reason 'quotaExceeded')")
        return list(youtube.uploads.get(playlist_id) or [])

    monkeypatch.setattr(script, "discover_all_videos", fake_discover)

    def fake_stats(_youtube, ids):
        youtube.stat_requests.append(list(ids))
        found = [youtube.stats[i] for i in ids if i in youtube.stats]
        return found, {i: "no data" for i in ids if i not in youtube.stats}

    monkeypatch.setattr(script, "get_video_statistics", fake_stats)
    with mock_aws():
        client = boto3.client("s3", region_name=REGION)
        client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})
        yield SimpleNamespace(youtube=youtube, master=master, s3=client)


def _item(video_id: str, title: str = "live archive title", published="2021-05-01T00:00:00Z") -> dict:
    return {"videoId": video_id, "title": title, "publishedAt": published, "thumbnailUrl": f"https://i/{video_id}.jpg"}


def _stat(video_id: str, views: int, content_type="live", live_status="completed", title="live archive title") -> dict:
    return {
        "videoId": video_id,
        "title": title,
        "publishedAt": "2021-05-01T00:00:00Z",
        "viewCount": views,
        "contentType": content_type,
        "liveStatus": live_status,
    }


def _manifest(env) -> S3TrackingManifestStore:
    return S3TrackingManifestStore(BUCKET, s3_client=env.s3)


def _ranking(env) -> S3VideoRankingStore:
    return S3VideoRankingStore(BUCKET, s3_client=env.s3)


def _manifest_entries(env) -> dict[str, ManifestEntry]:
    entries: dict[str, ManifestEntry] = {}
    for shard in range(script.HISTORY_SHARD_COUNT):
        shard_entries, _ = _manifest(env).read_shard_for_patch(shard)
        entries.update({entry.video_id: entry for entry in shard_entries})
    return entries


def _run(env, creator_ids: list[str], *, execute: bool):
    return script.run(
        youtube=object(),
        creators=script.graduated_creators(load_creators(), set(creator_ids)),
        load_master_videos=env.master.load,
        upsert_videos=env.master.upsert,
        manifest_store=_manifest(env),
        ranking_store=_ranking(env),
        execute=execute,
        now=NOW,
    )


def _channel(creator_id: str) -> str:
    return REAL[creator_id].youtube_channel_id


# --- scope: explicit graduated creators only --------------------------------------------------------------


def test_the_default_scope_is_exactly_the_13_graduated_individual_creators():
    assert [c.creator_id for c in script.graduated_creators(load_creators())] == sorted(
        [
            "amane_kanata", "ceres_fauna", "gawr_gura", "hiodoshi_ao", "kiryu_coco", "mano_aloe", "minato_aqua",
            "murasaki_shion", "nanashi_mumei", "sakamata_chloe", "uruha_rushia", "watson_amelia", "yozora_mel",
        ]
    )


@pytest.mark.parametrize("creator_id", ["aizawa_ema", "vspo_official", "hololive_official", "does_not_exist"])
def test_anyone_who_is_not_a_graduated_individual_creator_is_refused(creator_id):
    with pytest.raises(script.UnauthorizedCreatorError):
        script.graduated_creators(load_creators(), {creator_id})


def test_main_refuses_to_run_without_an_explicit_production_target(monkeypatch, capsys):
    monkeypatch.delenv("YOBI_STORAGE_BACKEND", raising=False)
    monkeypatch.delenv("YOBI_HISTORY_BUCKET", raising=False)

    assert script.main([]) == 1
    assert "refusing to guess" in capsys.readouterr().out


# --- dry run ------------------------------------------------------------------------------------------------


def test_a_dry_run_plans_the_repair_but_writes_nothing(env):
    env.youtube.uploads[_channel("nanashi_mumei")] = [_item("m1"), _item("m2")]
    env.youtube.stats.update({"m1": _stat("m1", 100), "m2": _stat("m2", 200)})

    (plan,) = _run(env, ["nanashi_mumei"], execute=False)

    assert [v.video_id for v in plan.new_videos] == ["m1", "m2"] and plan.ranking_action == "write-merged"
    assert env.master.videos == {} and env.master.upsert_calls == []
    assert _manifest_entries(env) == {}
    assert _ranking(env).read_result(TODAY, "nanashi_mumei") is None


# --- insertion, baseline and read model --------------------------------------------------------------------


def test_missing_historical_videos_are_inserted_into_master_manifest_and_the_read_model(env):
    env.youtube.uploads[_channel("nanashi_mumei")] = [_item("m1", "【APEX】collab"), _item("m2")]
    env.youtube.stats.update({"m1": _stat("m1", 1234, "upload", None, "【APEX】collab"), "m2": _stat("m2", 99)})

    _run(env, ["nanashi_mumei"], execute=True)

    assert sorted(env.master.videos) == ["m1", "m2"]
    video = env.master.videos["m1"]
    assert video.creator_id == "nanashi_mumei" and video.title == "【APEX】collab" and video.topic == "apex"
    assert (video.content_type, video.live_status) == ("upload", None)
    assert video.activity_state == "Unknown" and video.snapshot_count == 0 and video.last_view_count is None  # bootstrap only
    manifest = _manifest_entries(env)
    assert sorted(manifest) == ["m1", "m2"] and manifest["m1"].topic == "apex" and manifest["m1"].content_type == "upload"
    result = _ranking(env).read_result(TODAY, "nanashi_mumei")
    rows = {row["videoId"]: row for row in result["videos"]}
    assert rows["m1"]["currentViewCount"] == 1234 and rows["m2"]["currentViewCount"] == 99  # current baseline
    assert all(rows["m1"][f"anchor{p}ViewCount"] is None for p in ("1d", "7d", "30d"))  # nothing fabricated


def test_a_video_that_is_no_longer_publicly_available_is_not_tracked(env):
    env.youtube.uploads[_channel("nanashi_mumei")] = [_item("m1"), _item("gone")]
    env.youtube.stats["m1"] = _stat("m1", 10)

    (plan,) = _run(env, ["nanashi_mumei"], execute=True)

    assert sorted(env.master.videos) == ["m1"] and plan.unavailable == 1
    assert sorted(_manifest_entries(env)) == ["m1"]


# --- existing data is preserved, nothing duplicated -----------------------------------------------------------


def test_existing_videos_are_not_duplicated_rewritten_or_stripped_of_history(env):
    old = Video(
        video_id="old", creator_id="gawr_gura", title="old", published_at="2020-09-12T00:00:00Z", activity_state="Cold",
        snapshot_count=7, last_view_count=5000, topic="chatting", content_type="live", live_status="completed",
    )
    env.master.videos["old"] = old
    _manifest(env).write_shard(
        shard_for_video("old"), [ManifestEntry("old", "gawr_gura", True, activity_state="Cold", topic="chatting", title="old")]
    )
    _ranking(env).write_result(
        TODAY,
        "gawr_gura",
        {"reportDate": "2026-10-05", "creatorId": "gawr_gura", "generatedAt": "x",
         "videos": [{"videoId": "old", "creatorId": "gawr_gura", "currentViewCount": 5000, "anchor1dViewCount": 4990}]},
    )
    env.youtube.uploads[_channel("gawr_gura")] = [_item("old"), _item("new")]
    env.youtube.stats["new"] = _stat("new", 42)

    _run(env, ["gawr_gura"], execute=True)

    assert env.master.upsert_calls == [["new"]]  # the existing video is never written again
    assert env.master.videos["old"] is old and old.snapshot_count == 7 and old.last_view_count == 5000
    assert _manifest_entries(env)["old"].activity_state == "Cold"  # existing manifest entry untouched
    rows = {row["videoId"]: row for row in _ranking(env).read_result(TODAY, "gawr_gura")["videos"]}
    assert rows["old"] == {"videoId": "old", "creatorId": "gawr_gura", "currentViewCount": 5000, "anchor1dViewCount": 4990}
    assert rows["new"]["currentViewCount"] == 42
    assert sum(1 for _ in rows) == 2  # one row per video


def test_no_history_snapshot_rows_are_ever_written(env):
    env.youtube.uploads[_channel("nanashi_mumei")] = [_item("m1")]
    env.youtube.stats["m1"] = _stat("m1", 5)

    _run(env, ["nanashi_mumei"], execute=True)

    keys = [o["Key"] for o in env.s3.list_objects_v2(Bucket=BUCKET).get("Contents", [])]
    assert not any(key.startswith(("history/", "rankings/")) for key in keys)
    assert any(key.startswith("video-ranking/") for key in keys) and any(key.startswith("catalog/") for key in keys)


def test_a_video_missing_only_from_the_manifest_is_added_there_not_reinserted_in_master(env):
    env.master.videos["v1"] = Video(video_id="v1", creator_id="kiryu_coco", title="t", published_at="2020-01-01T00:00:00Z")
    env.youtube.uploads[_channel("kiryu_coco")] = [_item("v1")]
    env.youtube.stats["v1"] = _stat("v1", 8)

    _run(env, ["kiryu_coco"], execute=True)

    assert env.master.upsert_calls == []
    assert "v1" in _manifest_entries(env)


def test_the_manifest_patch_never_regresses_an_existing_entry(env):
    _manifest(env).write_shard(shard_for_video("v1"), [ManifestEntry("v1", "c", True, activity_state="Hot")])

    script.patch_manifest(_manifest(env), [Video(video_id="v1", creator_id="c", title="t", published_at="p")])

    assert _manifest_entries(env)["v1"].activity_state == "Hot"


# --- creators with nothing to show -----------------------------------------------------------------------------


@pytest.mark.parametrize("source_state", ["playlist-404", "channel-gone"])
def test_a_creator_whose_official_uploads_source_is_unavailable_is_left_completely_untouched(env, source_state):
    channel = _channel("uruha_rushia")
    if source_state == "playlist-404":
        env.youtube.missing_playlist.add(channel)
    else:
        env.youtube.uploads[channel] = None

    (plan,) = _run(env, ["uruha_rushia"], execute=True)

    assert plan.source_available is False
    assert plan.ranking_action == "none" and plan.ranking_payload is None and not plan.new_videos
    assert _ranking(env).read_result(TODAY, "uruha_rushia") is None  # no empty catalog is invented
    assert env.master.videos == {} and env.master.upsert_calls == [] and _manifest_entries(env) == {}


def test_an_unavailable_source_does_not_stop_the_other_creators_from_being_repaired(env):
    env.youtube.missing_playlist.add(_channel("mano_aloe"))
    env.youtube.uploads[_channel("nanashi_mumei")] = [_item("n1"), _item("n2")]
    env.youtube.stats.update({"n1": _stat("n1", 1), "n2": _stat("n2", 2)})

    plans = _run(env, ["mano_aloe", "nanashi_mumei"], execute=True)

    by_id = {plan.creator_id: plan for plan in plans}
    assert by_id["mano_aloe"].source_available is False and by_id["nanashi_mumei"].source_available is True
    assert sorted(env.master.videos) == ["n1", "n2"]
    assert _ranking(env).read_result(TODAY, "nanashi_mumei") is not None
    assert _ranking(env).read_result(TODAY, "mano_aloe") is None


def test_any_other_api_failure_is_raised_naming_the_creator_and_writes_nothing(env):
    env.youtube.uploads[_channel("nanashi_mumei")] = [_item("n1")]
    env.youtube.stats["n1"] = _stat("n1", 1)
    env.youtube.quota_blocked.add(_channel("uruha_rushia"))

    with pytest.raises(YouTubeAPIError, match="uruha_rushia"):
        _run(env, ["nanashi_mumei", "uruha_rushia"], execute=True)

    assert env.master.videos == {} and _manifest_entries(env) == {}


def test_a_working_playlist_with_nothing_available_writes_nothing(env):
    env.youtube.uploads[_channel("uruha_rushia")] = [_item("x1")]  # listed upstream, but no stats: not available

    (plan,) = _run(env, ["uruha_rushia"], execute=True)

    assert plan.source_available is True and plan.unavailable == 1
    assert plan.ranking_action == "none"
    assert env.master.videos == {} and _manifest_entries(env) == {}
    assert _ranking(env).read_result(TODAY, "uruha_rushia") is None


def test_quota_exhaustion_writes_nothing_because_planning_finishes_before_any_write(env, monkeypatch):
    env.youtube.uploads[_channel("amane_kanata")] = [_item("a1")]
    env.youtube.stats["a1"] = _stat("a1", 1)
    env.youtube.uploads[_channel("nanashi_mumei")] = [_item("m1")]

    def boom(_youtube, ids):
        if ids == ["m1"]:
            raise YouTubeAPIError("quota")
        return [env.youtube.stats[i] for i in ids], {}

    monkeypatch.setattr(script, "get_video_statistics", boom)

    with pytest.raises(YouTubeAPIError):
        _run(env, ["amane_kanata", "nanashi_mumei"], execute=True)

    assert env.master.videos == {} and _manifest_entries(env) == {}
    assert _ranking(env).read_result(TODAY, "amane_kanata") is None


# --- idempotency ------------------------------------------------------------------------------------------------


def test_running_the_repair_twice_changes_nothing_the_second_time(env):
    env.youtube.uploads[_channel("nanashi_mumei")] = [_item("m1"), _item("m2")]
    env.youtube.stats.update({"m1": _stat("m1", 1), "m2": _stat("m2", 2)})
    env.youtube.missing_playlist.add(_channel("uruha_rushia"))

    _run(env, ["nanashi_mumei", "uruha_rushia"], execute=True)
    manifest_after_first = _manifest_entries(env)
    ranking_after_first = {c: _ranking(env).read_result(TODAY, c) for c in ("nanashi_mumei", "uruha_rushia")}
    calls_after_first = list(env.master.upsert_calls)

    second = _run(env, ["nanashi_mumei", "uruha_rushia"], execute=True)

    assert all(not p.new_videos and not p.manifest_missing_videos and p.ranking_action == "none" for p in second)
    assert env.master.upsert_calls == calls_after_first  # no second VideoMaster write
    assert _manifest_entries(env) == manifest_after_first
    assert {c: _ranking(env).read_result(TODAY, c) for c in ("nanashi_mumei", "uruha_rushia")} == ranking_after_first
    assert sorted(env.master.videos) == ["m1", "m2"]  # still exactly one record per video


# --- policy: notifications and the graduated switches ------------------------------------------------------------


def test_the_script_never_imports_or_calls_anything_that_sends_a_notification():
    tree = ast.parse(_MODULE_PATH.read_text(encoding="utf-8"))
    imported: set[str] = set()
    called: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module)
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.Call):
            func = node.func
            called.add(func.id if isinstance(func, ast.Name) else getattr(func, "attr", ""))

    assert not [name for name in imported if "notification" in name or "push" in name]
    assert "record_new_video_events" not in imported | called


def test_a_full_run_leaves_every_graduated_creator_undiscoverable_unpollable_and_uncollected(env):
    env.youtube.uploads[_channel("nanashi_mumei")] = [_item("m1")]
    env.youtube.stats["m1"] = _stat("m1", 1)

    _run(env, ["nanashi_mumei"], execute=True)

    for creator in (c for c in load_creators() if c.lifecycle_stage == "graduated"):
        assert creator.discovery_enabled is False, creator.creator_id
        assert is_content_collection_eligible(creator) is False, creator.creator_id
        assert is_live_status_polling_eligible(creator) is False, creator.creator_id


def test_the_report_lists_exactly_what_a_run_touched(env):
    env.youtube.uploads[_channel("nanashi_mumei")] = [_item("m1"), _item("m2")]
    env.youtube.stats.update({"m1": _stat("m1", 1), "m2": _stat("m2", 2)})
    env.youtube.missing_playlist.add(_channel("uruha_rushia"))

    plans = _run(env, ["nanashi_mumei", "uruha_rushia"], execute=True)
    report = script.plan_report(plans, execute=True, generated_at="t")

    by_creator = {entry["creatorId"]: entry for entry in report["creators"]}
    assert report["executed"] is True
    assert by_creator["nanashi_mumei"]["videoMasterInserted"] == ["m1", "m2"] and by_creator["nanashi_mumei"]["rankingVideosWritten"] == 2
    assert by_creator["nanashi_mumei"]["manifestAdded"] == ["m1", "m2"]
    assert by_creator["uruha_rushia"]["sourceAvailable"] is False and by_creator["uruha_rushia"]["rankingAction"] == "none"
    assert by_creator["uruha_rushia"]["videoMasterInserted"] == [] and by_creator["uruha_rushia"]["manifestAdded"] == []
