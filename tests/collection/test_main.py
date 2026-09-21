from datetime import datetime

import pytest

from collection import main as main_module
from tracking.creator_master import Creator
from tracking.tracking_manifest import TrackingManifestError
from tracking.video_master import Video, VideoMasterError
from collection.youtube_client import QuotaExhaustedError, YouTubeAPIError


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
    """The happy path for a creator that already has known videos: newly discovered videos get upserted and notified."""
    new_videos = [_video("v1"), _video("v2")]
    monkeypatch.setattr(main_module, "load_videos", lambda: [_video("already_known")])
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


def test_discovery_classifies_the_topic_of_each_new_video(monkeypatch):
    creator = Creator(
        creator_id="c1",
        display_name="C1",
        organization="vspo",
        youtube_channel_id="UC1",
        active=True,
        branch="vspo_jp",
        group_key=["NO"],
        channel_type="member",
        lifecycle_stage="active",
    )
    monkeypatch.setattr(main_module, "get_uploads_playlist_id", lambda youtube, channel_id: "UU1")
    monkeypatch.setattr(
        main_module,
        "discover_all_videos",
        lambda youtube, playlist_id: [
            {"videoId": "v1", "title": "【VALORANT】ランク", "publishedAt": "2026-08-20T00:00:00Z"},
            {"videoId": "v2", "title": "お知らせ", "publishedAt": "2026-08-21T00:00:00Z"},
        ],
    )

    _, videos = main_module._discover_creator(None, creator, set(), discovered_at="2026-09-01T00:00:00+09:00")

    assert [(video.video_id, video.topic) for video in videos] == [("v1", "valorant"), ("v2", "other")]


# --- first ingestion of a creator: back catalog is seeded, not notified ------

_RUN_TIME = datetime.fromisoformat("2026-09-22T00:00:00+09:00")


class _FakeVideoMaster:
    def __init__(self):
        self.videos = []

    def load(self):
        return list(self.videos)

    def upsert(self, videos):
        self.videos.extend(videos)


def _wire_ingestion(monkeypatch, playlist, *, creators):
    """Run run_discovery against an in-memory Video Master and a fake uploads playlist (newest first)."""
    store = _FakeVideoMaster()
    notified = []

    def discover_all(youtube, playlist_id):
        return list(playlist[creators[0].creator_id])

    def discover_new(youtube, playlist_id, known_ids):
        return [item for item in playlist[creators[0].creator_id] if item["videoId"] not in known_ids]

    monkeypatch.setattr(main_module, "datetime", _frozen_datetime(_RUN_TIME))
    monkeypatch.setattr(main_module, "get_active_creators", lambda: creators)
    monkeypatch.setattr(main_module, "get_uploads_playlist_id", lambda youtube, channel_id: "UU")
    monkeypatch.setattr(main_module, "discover_all_videos", discover_all)
    monkeypatch.setattr(main_module, "discover_new_videos", discover_new)
    monkeypatch.setattr(main_module, "load_videos", store.load)
    monkeypatch.setattr(main_module, "upsert_videos", store.upsert)
    monkeypatch.setattr(main_module, "record_new_video_events", lambda videos: notified.extend(v.video_id for v in videos))
    return store, notified


def _item(video_id, published_at):
    return {"videoId": video_id, "title": f"Video {video_id}", "publishedAt": published_at}


def test_first_ingestion_seeds_backlog_without_events_then_notifies_future_uploads(monkeypatch):
    creator = _creator(creator_id="new_creator")
    playlist = {"new_creator": [_item("old2", "2026-09-10T00:00:00Z"), _item("old1", "2026-09-01T00:00:00Z")]}
    store, notified = _wire_ingestion(monkeypatch, playlist, creators=[creator])

    assert main_module.run_discovery() == 0
    assert sorted(video.video_id for video in store.videos) == ["old1", "old2"]
    assert notified == []

    assert main_module.run_discovery() == 0
    assert len(store.videos) == 2
    assert notified == []

    playlist["new_creator"].insert(0, _item("fresh", "2026-09-21T10:00:00Z"))
    assert main_module.run_discovery() == 0
    assert sorted(video.video_id for video in store.videos) == ["fresh", "old1", "old2"]
    assert notified == ["fresh"]


def test_first_ingestion_still_notifies_a_video_younger_than_one_discovery_interval(monkeypatch):
    creator = _creator(creator_id="empty_until_now")
    playlist = {"empty_until_now": [_item("just_uploaded", "2026-09-21T10:00:00Z"), _item("old", "2026-08-01T00:00:00Z")]}
    store, notified = _wire_ingestion(monkeypatch, playlist, creators=[creator])

    main_module.run_discovery()

    assert sorted(video.video_id for video in store.videos) == ["just_uploaded", "old"]
    assert notified == ["just_uploaded"]


def test_existing_creator_keeps_notifying_every_new_video_regardless_of_age(monkeypatch):
    creator = _creator(creator_id="established")
    playlist = {"established": [_item("late_found", "2026-06-01T00:00:00Z"), _item("known", "2026-05-01T00:00:00Z")]}
    store, notified = _wire_ingestion(monkeypatch, playlist, creators=[creator])
    store.videos.append(_video("known", creator_id="established"))

    main_module.run_discovery()

    assert notified == ["late_found"]


def test_backlog_suppression_only_applies_to_first_ingestion_creators(monkeypatch):
    old = Video(video_id="old", creator_id="c1", title="t", published_at="2026-01-01T00:00:00Z")
    other = Video(video_id="other", creator_id="c2", title="t", published_at="2026-01-01T00:00:00Z")
    notified = []
    monkeypatch.setattr(main_module, "record_new_video_events", notified.extend)

    main_module._record_new_video_events_best_effort([old, other], {"c1"}, _RUN_TIME)

    assert [video.video_id for video in notified] == ["other"]


@pytest.mark.parametrize(
    ("published_at", "notified_expected"),
    [
        ("2026-09-20T15:00:01Z", True),  # 1s inside the 24h window (run_time is 2026-09-21T15:00:00Z)
        ("2026-09-20T15:00:00Z", True),  # exactly 24h old is still inside
        ("2026-09-21T15:00:00Z", True),  # published exactly at run time
        ("2026-09-21T15:00:01Z", False),  # 1s in the future is not "published within the last 24h"
        ("2026-09-22T00:00:01+09:00", False),  # future, explicit offset
        ("2026-09-20T14:59:59Z", False),  # 1s outside
        ("2026-09-21T00:00:01+09:00", True),  # explicit offset, inside
        ("2026-09-20T23:59:59+09:00", False),  # explicit offset, outside
        ("not-a-date", False),
    ],
)
def test_first_ingestion_notify_window_boundary(monkeypatch, published_at, notified_expected):
    video = Video(video_id="v1", creator_id="c1", title="t", published_at=published_at)
    notified = []
    monkeypatch.setattr(main_module, "record_new_video_events", notified.extend)

    main_module._record_new_video_events_best_effort([video], {"c1"}, _RUN_TIME)

    assert bool(notified) is notified_expected


def _first_ingestion_main_setup(monkeypatch, discover):
    monkeypatch.setattr(main_module, "datetime", _frozen_datetime(_RUN_TIME))
    monkeypatch.setattr(main_module, "select_due_video_ids", lambda candidates, *, as_of: [])
    monkeypatch.setattr(main_module, "get_video_statistics", lambda youtube, video_ids: ([], {}))
    monkeypatch.setattr(main_module, "save_run_summary", lambda *args: ("summary",))
    monkeypatch.setattr(main_module, "_discover_creator", discover)
    upserted, notified = [], []
    monkeypatch.setattr(main_module, "upsert_videos", upserted.extend)
    monkeypatch.setattr(main_module, "record_new_video_events", lambda videos: notified.extend(v.video_id for v in videos))
    return upserted, notified


def _discovered(video_id, creator_id, published_at):
    return Video(video_id=video_id, creator_id=creator_id, title="t", published_at=published_at)


def test_main_seeds_first_ingestion_backlog_without_events_but_notifies_recent_uploads(monkeypatch):
    monkeypatch.setattr(main_module, "get_active_creators", lambda: [_creator(creator_id="c1")])

    def discover(youtube, creator, known_ids, *, discovered_at):
        return (["old", "fresh"], [_discovered("old", "c1", "2026-01-01T00:00:00Z"), _discovered("fresh", "c1", "2026-09-21T10:00:00Z")])

    upserted, notified = _first_ingestion_main_setup(monkeypatch, discover)

    main_module.main()

    assert sorted(video.video_id for video in upserted) == ["fresh", "old"]
    assert notified == ["fresh"]


def test_main_quota_exhaustion_path_also_suppresses_first_ingestion_backlog(monkeypatch):
    monkeypatch.setattr(
        main_module, "get_active_creators", lambda: [_creator(creator_id="c1"), _creator(creator_id="c2")]
    )

    def discover(youtube, creator, known_ids, *, discovered_at):
        if creator.creator_id == "c2":
            raise QuotaExhaustedError("simulated quota exhaustion")
        return (["old"], [_discovered("old", "c1", "2026-01-01T00:00:00Z")])

    upserted, notified = _first_ingestion_main_setup(monkeypatch, discover)

    assert main_module.main() == 1
    assert [video.video_id for video in upserted] == ["old"]
    assert notified == []
