from datetime import datetime

import pytest

import main as main_module
from creator_master import Creator
from tracking_manifest import TrackingManifestError
from video_master import Video, VideoMasterError
from youtube_client import QuotaExhaustedError, YouTubeAPIError


def _frozen_datetime(fixed_now: datetime) -> type[datetime]:
    """Build a datetime subclass whose now() always returns fixed_now, for monkeypatching module-level `datetime`."""

    class _Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return fixed_now.astimezone(tz) if tz else fixed_now

    return _Frozen


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


def test_run_discovery_returns_1_when_the_initial_video_master_read_fails(monkeypatch):
    """load_videos() raising VideoMasterError (e.g. a DynamoDB scan failure) must return 1,
    not propagate — the outer handler only caught YouTubeAPIError before this regression test."""
    monkeypatch.setattr(main_module, "get_active_creators", lambda: [_creator()])

    def _boom():
        raise VideoMasterError("simulated DynamoDB scan failure")

    monkeypatch.setattr(main_module, "load_videos", _boom)

    assert main_module.run_discovery() == 1


def test_run_discovery_continues_when_manifest_publishing_fails(monkeypatch):
    """A TrackingManifestError from the new history-manifest publish must not turn an
    otherwise-successful discovery_only run into a failure (best-effort, like notification events)."""
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", "fake-history-bucket")
    monkeypatch.setattr(main_module, "get_active_creators", lambda: [_creator()])
    monkeypatch.setattr(main_module, "_discover_creator", lambda *a, **k: (["v1"], [_video("v1")]))
    monkeypatch.setattr(main_module, "upsert_videos", lambda videos: None)

    def _boom(videos, store):
        raise TrackingManifestError("simulated S3 write failure")

    monkeypatch.setattr(main_module, "publish_tracking_manifest", _boom)

    assert main_module.run_discovery() == 0


def test_main_continues_when_manifest_publishing_fails(monkeypatch):
    """The daily collection path must still fetch statistics and save a snapshot even
    when the new history-manifest publish fails — it must never gate the existing
    YouTube statistics collection this function is actually responsible for."""
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", "fake-history-bucket")
    tracked = [_video("v1")]
    monkeypatch.setattr(main_module, "get_active_creators", lambda: [_creator(discovery_enabled=False)])
    monkeypatch.setattr(main_module, "load_videos", lambda: tracked)

    requested = []

    def fake_statistics(youtube, video_ids):
        requested.append(video_ids)
        return ([{"videoId": "v1", "title": "Video v1", "publishedAt": tracked[0].published_at, "viewCount": 100}], {})

    monkeypatch.setattr(main_module, "get_video_statistics", fake_statistics)
    monkeypatch.setattr(main_module, "save_daily_collection", lambda *args: ("history", "summary"))
    monkeypatch.setattr(main_module, "upsert_videos", lambda videos: None)

    def _boom(videos, store):
        raise TrackingManifestError("simulated S3 write failure")

    monkeypatch.setattr(main_module, "publish_tracking_manifest", _boom)

    assert main_module.main() == 0
    assert requested == [["v1"]]


def test_run_discovery_continues_when_manifest_publishing_raises_an_unexpected_error(monkeypatch):
    """Not just TrackingManifestError: an unwrapped exception from pyarrow's own
    serialization/write path (pa.table, parquet.write_table, the S3 upload itself)
    must be just as best-effort, since none of those are wrapped as
    TrackingManifestError before reaching _publish_manifest_if_configured."""
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", "fake-history-bucket")
    monkeypatch.setattr(main_module, "get_active_creators", lambda: [_creator()])
    monkeypatch.setattr(main_module, "_discover_creator", lambda *a, **k: (["v1"], [_video("v1")]))
    monkeypatch.setattr(main_module, "upsert_videos", lambda videos: None)

    def _boom(videos, store):
        raise RuntimeError("simulated pyarrow runtime failure")

    monkeypatch.setattr(main_module, "publish_tracking_manifest", _boom)

    assert main_module.run_discovery() == 0


def test_main_continues_when_manifest_publishing_raises_an_unexpected_error(monkeypatch):
    """Same as above for the daily collection path: an unwrapped RuntimeError from
    manifest serialization must not block the existing YouTube statistics collection."""
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", "fake-history-bucket")
    tracked = [_video("v1")]
    monkeypatch.setattr(main_module, "get_active_creators", lambda: [_creator(discovery_enabled=False)])
    monkeypatch.setattr(main_module, "load_videos", lambda: tracked)

    requested = []

    def fake_statistics(youtube, video_ids):
        requested.append(video_ids)
        return ([{"videoId": "v1", "title": "Video v1", "publishedAt": tracked[0].published_at, "viewCount": 100}], {})

    monkeypatch.setattr(main_module, "get_video_statistics", fake_statistics)
    monkeypatch.setattr(main_module, "save_daily_collection", lambda *args: ("history", "summary"))
    monkeypatch.setattr(main_module, "upsert_videos", lambda videos: None)

    def _boom(videos, store):
        raise RuntimeError("simulated pyarrow runtime failure")

    monkeypatch.setattr(main_module, "publish_tracking_manifest", _boom)

    assert main_module.main() == 0
    assert requested == [["v1"]]


def test_manifest_publishing_succeeds_when_configured(monkeypatch):
    """The happy path: with YOBI_HISTORY_BUCKET set and no failure, the manifest is
    actually published (not silently skipped by the same best-effort handling)."""
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", "fake-history-bucket")
    monkeypatch.setattr(main_module, "get_active_creators", lambda: [_creator()])
    monkeypatch.setattr(main_module, "_discover_creator", lambda *a, **k: (["v1"], [_video("v1")]))
    monkeypatch.setattr(main_module, "upsert_videos", lambda videos: None)

    published = []
    monkeypatch.setattr(main_module, "publish_tracking_manifest", lambda videos, store: published.append(videos))

    assert main_module.run_discovery() == 0
    assert len(published) == 1
    assert {video.video_id for video in published[0]} == {"v1"}


def test_collection_only_requests_videos_selected_by_tiered_due_selection(monkeypatch):
    """main() delegates due-selection to tracking_schedule.select_due_video_ids, passing each
    tracked video's published_at/activity_state plus today's JST date, and only requests
    statistics for the ids that selection returns (Roadmap 1.5 tiered refresh)."""
    tracked = [
        Video(
            video_id="due-video",
            creator_id="aizawa_ema",
            title="Due",
            published_at="2020-01-01T00:00:00Z",
            activity_state="Cold",
        ),
        Video(
            video_id="not-due-video",
            creator_id="aizawa_ema",
            title="Not due",
            published_at="2020-01-01T00:00:00Z",
            activity_state="Cold",
        ),
    ]
    monkeypatch.setattr(main_module, "get_active_creators", lambda: [_creator(discovery_enabled=False)])
    monkeypatch.setattr(main_module, "load_videos", lambda: tracked)

    fixed_now = datetime(2026, 9, 15, 18, 0, 0, tzinfo=main_module.COLLECTION_TIMEZONE)
    monkeypatch.setattr(main_module, "datetime", _frozen_datetime(fixed_now))

    received = {}

    def fake_select_due_video_ids(candidates, *, as_of):
        received["candidates"] = sorted(candidates)
        received["as_of"] = as_of
        return ["due-video"]

    monkeypatch.setattr(main_module, "select_due_video_ids", fake_select_due_video_ids)

    requested = []

    def fake_statistics(youtube, video_ids):
        requested.append(video_ids)
        return (
            [
                {
                    "videoId": "due-video",
                    "title": "Due",
                    "publishedAt": "2020-01-01T00:00:00Z",
                    "viewCount": 100,
                }
            ],
            {},
        )

    monkeypatch.setattr(main_module, "get_video_statistics", fake_statistics)
    monkeypatch.setattr(main_module, "save_daily_collection", lambda *args: ("history", "summary"))
    monkeypatch.setattr(
        main_module,
        "upsert_videos",
        lambda videos: (_ for _ in ()).throw(AssertionError("daily collection must not rewrite VideoMaster")),
    )

    assert main_module.main() == 0
    assert requested == [["due-video"]]
    assert received["as_of"] == fixed_now.date()
    assert received["candidates"] == [
        ("due-video", "2020-01-01T00:00:00Z", "Cold"),
        ("not-due-video", "2020-01-01T00:00:00Z", "Cold"),
    ]


def test_collection_includes_tracked_ids_missing_a_video_master_record(monkeypatch):
    """A tracked video_id absent from Video Master (a malformed catalog) is still requested
    today unconditionally, matching is_due_today's own can't-tell-so-check-it-today fallback,
    even when tiered selection is not asked to select it."""
    known = [_video("known-video")]
    monkeypatch.setattr(main_module, "get_active_creators", lambda: [_creator(discovery_enabled=False)])
    monkeypatch.setattr(main_module, "load_videos", lambda: known)
    monkeypatch.setattr(
        main_module,
        "load_video_ids_for_creator",
        lambda creator_id, videos=None: {"known-video", "missing-video"},
    )
    monkeypatch.setattr(main_module, "select_due_video_ids", lambda candidates, *, as_of: [])

    requested = []

    def fake_statistics(youtube, video_ids):
        requested.append(video_ids)
        return ([], {})

    monkeypatch.setattr(main_module, "get_video_statistics", fake_statistics)
    monkeypatch.setattr(main_module, "save_run_summary", lambda *args: ("summary",))
    monkeypatch.setattr(main_module, "upsert_videos", lambda videos: None)

    # No usable statistics came back for the sole due video, so main() reports
    # the run as failed (Roadmap 1.6) -- this test only cares that the missing
    # -record id was actually requested, which it can only be if it was
    # correctly folded into `due_today` despite tiered selection excluding it.
    assert main_module.main() == 1
    assert requested == [["missing-video"]]


def test_successful_collection_does_not_rewrite_video_master_scheduler_state(monkeypatch):
    tracked = [_video("v1")]
    monkeypatch.setattr(main_module, "get_active_creators", lambda: [_creator(discovery_enabled=False)])
    monkeypatch.setattr(main_module, "load_videos", lambda: tracked)
    monkeypatch.setattr(
        main_module,
        "get_video_statistics",
        lambda youtube, video_ids: (
            [
                {
                    "videoId": "v1",
                    "title": "Video v1",
                    "publishedAt": tracked[0].published_at,
                    "viewCount": 100,
                }
            ],
            {},
        ),
    )
    monkeypatch.setattr(main_module, "save_daily_collection", lambda *args: ("history", "summary"))
    writes = []
    monkeypatch.setattr(main_module, "upsert_videos", writes.append)

    assert main_module.main() == 0
    assert writes == []
