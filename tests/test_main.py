import pytest

import main as main_module
from creator_master import Creator
from video_master import Video, VideoMasterError
from youtube_client import QuotaExhaustedError, YouTubeAPIError


def _creator(**overrides) -> Creator:
    """Build a minimal Creator for a test, overriding only the given fields."""
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
    }
    fields.update(overrides)
    return Creator(**fields)


def _video(video_id: str, creator_id: str = "aizawa_ema") -> Video:
    return Video(video_id=video_id, creator_id=creator_id, title=f"Video {video_id}", published_at="2026-08-20T00:00:00Z")


@pytest.fixture(autouse=True)
def _stub_common(monkeypatch):
    """Every run_discovery test needs an API key and a YouTube client stub; neither's
    real value matters since _discover_creator itself is monkeypatched per test."""
    monkeypatch.setattr(main_module, "get_api_key", lambda: "fake-key")
    monkeypatch.setattr(main_module, "build_youtube_client", lambda api_key: object())
    monkeypatch.setattr(main_module, "load_videos", lambda: [])


def test_run_discovery_returns_0_and_skips_api_calls_when_no_active_creators(monkeypatch):
    monkeypatch.setattr(main_module, "get_active_creators", lambda: [])

    assert main_module.run_discovery() == 0


def test_run_discovery_persists_and_notifies_newly_discovered_videos(monkeypatch):
    """The happy path: discovery finds new videos, they get upserted and their notification events recorded."""
    new_videos = [_video("v1"), _video("v2")]
    monkeypatch.setattr(main_module, "get_active_creators", lambda: [_creator()])
    monkeypatch.setattr(main_module, "_discover_creator", lambda *a, **k: (["v1", "v2"], new_videos))

    upserted = []
    notified = []
    monkeypatch.setattr(main_module, "upsert_videos", upserted.append)
    monkeypatch.setattr(main_module, "record_new_video_events", notified.append)

    result = main_module.run_discovery()

    assert result == 0
    assert upserted == [new_videos]
    assert notified == [new_videos]


def test_run_discovery_skips_creators_with_discovery_disabled(monkeypatch):
    """A discovery-disabled creator is never passed to _discover_creator at all."""
    monkeypatch.setattr(main_module, "get_active_creators", lambda: [_creator(discovery_enabled=False)])

    def _boom(*args, **kwargs):
        raise AssertionError("_discover_creator should not be called for a discovery-disabled creator")

    monkeypatch.setattr(main_module, "_discover_creator", _boom)

    assert main_module.run_discovery() == 0


def test_run_discovery_continues_past_one_creators_youtube_error(monkeypatch):
    """One creator's transient YouTube API failure must not stop discovery for the rest."""
    monkeypatch.setattr(
        main_module,
        "get_active_creators",
        lambda: [_creator(creator_id="c1"), _creator(creator_id="c2")],
    )

    def _discover(youtube, creator, known_ids, *, discovered_at):
        if creator.creator_id == "c1":
            raise YouTubeAPIError("simulated transient failure")
        return (["v_c2"], [_video("v_c2", creator_id="c2")])

    monkeypatch.setattr(main_module, "_discover_creator", _discover)
    upserted = []
    monkeypatch.setattr(main_module, "upsert_videos", upserted.append)
    monkeypatch.setattr(main_module, "record_new_video_events", lambda videos: None)

    result = main_module.run_discovery()

    assert result == 0
    assert [video.video_id for video in upserted[0]] == ["v_c2"]


def test_run_discovery_persists_partial_results_and_fails_on_quota_exhaustion(monkeypatch):
    """Quota exhaustion stops further discovery calls but still persists what earlier creators found,
    and is reported as a failed run (matching main()'s own Roadmap 2.5 handling)."""
    monkeypatch.setattr(
        main_module,
        "get_active_creators",
        lambda: [_creator(creator_id="c1"), _creator(creator_id="c2")],
    )

    def _discover(youtube, creator, known_ids, *, discovered_at):
        if creator.creator_id == "c1":
            return (["v_c1"], [_video("v_c1", creator_id="c1")])
        raise QuotaExhaustedError("simulated quota exhaustion")

    monkeypatch.setattr(main_module, "_discover_creator", _discover)
    upserted = []
    monkeypatch.setattr(main_module, "upsert_videos", upserted.append)
    monkeypatch.setattr(main_module, "record_new_video_events", lambda videos: None)

    result = main_module.run_discovery()

    assert result == 1
    assert [video.video_id for video in upserted[0]] == ["v_c1"]


def test_run_discovery_returns_1_when_persisting_fails(monkeypatch):
    monkeypatch.setattr(main_module, "get_active_creators", lambda: [_creator()])
    monkeypatch.setattr(main_module, "_discover_creator", lambda *a, **k: (["v1"], [_video("v1")]))

    def _boom(videos):
        raise VideoMasterError("simulated write failure")

    monkeypatch.setattr(main_module, "upsert_videos", _boom)

    assert main_module.run_discovery() == 1


def test_run_discovery_returns_1_when_api_key_is_missing(monkeypatch):
    def _boom():
        raise main_module.MissingAPIKeyError("no key configured")

    monkeypatch.setattr(main_module, "get_api_key", _boom)

    assert main_module.run_discovery() == 1
