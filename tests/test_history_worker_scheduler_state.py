from datetime import date

import pytest

from collection import history_worker
from stores.history_store import HistoryRow
from collection.history_worker import collect_history_shard
from tracking.tracking_manifest import ManifestEntry
from tracking.video_master import Video


class _FakeManifest:
    """A tracking-manifest store stub returning one fixed set of active entries,
    with real optimistic-concurrency semantics (an integer version counter,
    standing in for S3's own ETag) for read_shard_for_patch/
    write_shard_if_version -- AWS Cost Recovery (third pass): patch_shard
    relies on a genuine conflict/no-conflict distinction, not a stub that
    always succeeds, so a test using this fake to prove idempotent/no-op
    patch behavior (e.g. no scheduler updates -> no write at all) is exercising
    the same contract the real S3TrackingManifestStore does."""

    def __init__(self, entries):
        self._entries = entries
        self._version = 1
        self.patch_write_count = 0

    def read_shard(self, shard):
        return self._entries

    def read_shard_for_patch(self, shard):
        return list(self._entries), self._version

    def write_shard_if_version(self, shard, entries, *, version):
        from tracking.tracking_manifest import ManifestConflictError

        if version != self._version:
            raise ManifestConflictError(f"stub conflict on shard {shard}")
        self._entries = list(entries)
        self._version += 1
        self.patch_write_count += 1
        return f"stub-shard-{shard:02d}"


class _FakeHistory:
    """A history store stub with in-memory shard storage, matching the real
    idempotency contract (shard_exists gates whether YouTube gets called again)."""

    def __init__(self):
        self.objects = {}

    def write_daily_shard(self, collection_date, shard, rows):
        self.objects[(collection_date, shard)] = list(rows)
        from stores.history_store import daily_history_key

        return daily_history_key(collection_date, shard)

    def read_daily_shard(self, collection_date, shard):
        return self.objects.get((collection_date, shard), [])

    def shard_exists(self, collection_date, shard):
        return (collection_date, shard) in self.objects


class _FakeVideoMaster:
    """A Video Master store stub: an in-memory dict of authoritative Video rows,
    matching video_master.VideoMasterStore's shape (get_video/upsert_videos).

    Deliberately does NOT implement get_videos -- proves
    _carry_forward_non_due_rows' fallback per-id loop still works unchanged
    for a store that only satisfies the original two-method Protocol (AWS
    Cost Recovery third pass, Scope H: get_videos is optional, duck-typed).
    """

    def __init__(self, videos: list[Video]):
        self.videos = {video.video_id: video for video in videos}
        self.upsert_calls: list[list[Video]] = []

    def get_video(self, video_id):
        return self.videos.get(video_id)

    def upsert_videos(self, videos):
        self.upsert_calls.append(list(videos))
        for video in videos:
            self.videos[video.video_id] = video


class _FakeVideoMasterWithBatchGet(_FakeVideoMaster):
    """Same as _FakeVideoMaster, plus a batched get_videos -- proves
    _carry_forward_non_due_rows actually calls it (once, with every missing
    id at once) instead of get_video per video, when a store provides it."""

    def __init__(self, videos: list[Video]):
        super().__init__(videos)
        self.get_videos_calls: list[list[str]] = []

    def get_videos(self, video_ids):
        self.get_videos_calls.append(list(video_ids))
        return {video_id: self.videos[video_id] for video_id in video_ids if video_id in self.videos}


def _kwargs(*, manifest, history, video_master=None):
    return {
        "youtube": object(),
        "manifest_store": manifest,
        "history_store": history,
        "video_master_store": video_master,
        "collection_date": date(2026, 9, 15),
        "observed_at": "2026-09-15T18:00:00+09:00",
    }


def test_successful_observation_invokes_canonical_classification_and_persists_it(monkeypatch):
    """A successfully-observed video is classified via tracking_schedule.classify_after_
    observation and the resulting scheduler state is persisted to Video Master."""
    existing = Video(
        video_id="v1",
        creator_id="c1",
        title="Existing title",
        published_at="2026-01-01T00:00:00Z",
        activity_state="Unknown",
        last_checked_at="2026-09-14T18:00:00+09:00",
        last_view_count=1000,
        snapshot_count=1,
    )
    video_master = _FakeVideoMaster([existing])

    monkeypatch.setattr(
        history_worker,
        "get_video_statistics",
        lambda youtube, video_ids: (
            [{"videoId": "v1", "title": "Existing title", "publishedAt": "2026-01-01T00:00:00Z", "viewCount": 2000}],
            {},
        ),
    )

    collect_history_shard(
        shard=history_worker.shard_for_video("v1"),
        **_kwargs(
            manifest=_FakeManifest([ManifestEntry("v1", "c1", True)]),
            history=_FakeHistory(),
            video_master=video_master,
        ),
    )

    assert len(video_master.upsert_calls) == 1
    [updated] = video_master.upsert_calls[0]
    assert updated.video_id == "v1"
    assert updated.last_view_count == 2000
    assert updated.last_checked_at == "2026-09-15T18:00:00+09:00"
    assert updated.snapshot_count == 2
    # +1000 views in a day from a 1000-view baseline is well past the Hot threshold.
    assert updated.activity_state == "Hot"
    assert updated.last_classification_reason == "strong_growth"


def test_classifier_input_comes_from_existing_video_master_state(monkeypatch):
    """classify_after_observation's `current_state`/`snapshot_count`/`quiet_streak`/
    `previous_view_count`/`previous_checked_at` inputs are the video's existing,
    authoritative Video Master row -- not any manifest or worker-local guess."""
    existing = Video(
        video_id="v1",
        creator_id="c1",
        title="Existing title",
        published_at="2026-01-01T00:00:00Z",
        activity_state="Warm",
        last_checked_at="2026-09-12T18:00:00+09:00",
        last_view_count=10_000,
        snapshot_count=5,
        quiet_streak=1,
    )
    video_master = _FakeVideoMaster([existing])

    calls = []
    original = history_worker.classify_after_observation

    def spy(**kwargs):
        calls.append(kwargs)
        return original(**kwargs)

    monkeypatch.setattr(history_worker, "classify_after_observation", spy)
    monkeypatch.setattr(
        history_worker,
        "get_video_statistics",
        lambda youtube, video_ids: (
            [{"videoId": "v1", "title": "Existing title", "publishedAt": "2026-01-01T00:00:00Z", "viewCount": 10_010}],
            {},
        ),
    )

    collect_history_shard(
        shard=history_worker.shard_for_video("v1"),
        **_kwargs(
            manifest=_FakeManifest([ManifestEntry("v1", "c1", True)]),
            history=_FakeHistory(),
            video_master=video_master,
        ),
    )

    assert len(calls) == 1
    assert calls[0]["current_state"] == "Warm"
    assert calls[0]["snapshot_count"] == 5
    assert calls[0]["quiet_streak"] == 1
    assert calls[0]["previous_view_count"] == 10_000
    assert calls[0]["previous_checked_at"] == "2026-09-12T18:00:00+09:00"


def test_unrelated_video_master_metadata_is_preserved(monkeypatch):
    """Fields the classifier never touches (title, published_at, creator_id,
    discovered_at) survive a scheduler-state update unchanged -- the pre-reset
    collector's own equivalent code silently dropped discovered_at back to None
    on every successful observation; merging onto the existing row must not."""
    existing = Video(
        video_id="v1",
        creator_id="c1",
        title="Real Title",
        published_at="2020-05-01T00:00:00Z",
        activity_state="Unknown",
        discovered_at="2026-01-01T00:00:00Z",
    )
    video_master = _FakeVideoMaster([existing])

    monkeypatch.setattr(
        history_worker,
        "get_video_statistics",
        lambda youtube, video_ids: (
            [{"videoId": "v1", "title": "Real Title", "publishedAt": "2020-05-01T00:00:00Z", "viewCount": 500}],
            {},
        ),
    )

    collect_history_shard(
        shard=history_worker.shard_for_video("v1"),
        **_kwargs(
            manifest=_FakeManifest([ManifestEntry("v1", "c1", True)]),
            history=_FakeHistory(),
            video_master=video_master,
        ),
    )

    [updated] = video_master.upsert_calls[0]
    assert updated.title == "Real Title"
    assert updated.published_at == "2020-05-01T00:00:00Z"
    assert updated.creator_id == "c1"
    assert updated.discovered_at == "2026-01-01T00:00:00Z"


def test_existing_topic_survives_a_scheduler_state_update(monkeypatch):
    existing = Video(
        video_id="v1", creator_id="c1", title="A", published_at="2020-05-01T00:00:00Z", topic="valorant"
    )
    video_master = _FakeVideoMaster([existing])
    monkeypatch.setattr(
        history_worker,
        "get_video_statistics",
        lambda youtube, video_ids: (
            [{"videoId": "v1", "title": "A", "publishedAt": "2020-05-01T00:00:00Z", "viewCount": 500}],
            {},
        ),
    )

    collect_history_shard(
        shard=history_worker.shard_for_video("v1"),
        **_kwargs(
            manifest=_FakeManifest([ManifestEntry("v1", "c1", True)]),
            history=_FakeHistory(),
            video_master=video_master,
        ),
    )

    [updated] = video_master.upsert_calls[0]
    assert updated.topic == "valorant"


def test_failed_statistics_observation_does_not_update_scheduler_state(monkeypatch):
    """A video that was due but got no usable statistics this run (a skipped/failed
    fetch) is not classified and its Video Master row is left completely untouched."""
    existing = Video(
        video_id="v1",
        creator_id="c1",
        title="Existing title",
        published_at="2026-01-01T00:00:00Z",
        activity_state="Warm",
        last_view_count=100,
        snapshot_count=3,
    )
    video_master = _FakeVideoMaster([existing])

    monkeypatch.setattr(
        history_worker,
        "get_video_statistics",
        lambda youtube, video_ids: ([], {"v1": "member-only video"}),
    )

    collect_history_shard(
        shard=history_worker.shard_for_video("v1"),
        **_kwargs(
            manifest=_FakeManifest([ManifestEntry("v1", "c1", True)]),
            history=_FakeHistory(),
            video_master=video_master,
        ),
    )

    assert video_master.upsert_calls == []
    assert video_master.videos["v1"] == existing


def test_multiple_successfully_observed_videos_are_persisted_correctly(monkeypatch):
    """Every successfully-observed video gets its own correctly classified update,
    each delivered to Video Master via its own upsert call (one per real shard,
    since two arbitrary video_ids are not guaranteed to share a deterministic shard)."""
    for video_id, initial_state, new_view_count, expected_next_state in [
        ("v1", "Unknown", 50, "Unknown"),
        ("v2", "Cold", 100_000, "Hot"),
    ]:
        existing = Video(
            video_id=video_id,
            creator_id="c1",
            title=f"Title {video_id}",
            published_at="2026-01-01T00:00:00Z",
            activity_state=initial_state,
            last_view_count=100 if initial_state != "Unknown" else None,
            last_checked_at="2026-09-14T18:00:00+09:00" if initial_state != "Unknown" else None,
            snapshot_count=1 if initial_state != "Unknown" else 0,
        )
        video_master = _FakeVideoMaster([existing])
        monkeypatch.setattr(
            history_worker,
            "get_video_statistics",
            lambda youtube, video_ids, video_id=video_id, new_view_count=new_view_count: (
                [
                    {
                        "videoId": video_id,
                        "title": f"Title {video_id}",
                        "publishedAt": "2026-01-01T00:00:00Z",
                        "viewCount": new_view_count,
                    }
                ],
                {},
            ),
        )

        collect_history_shard(
            shard=history_worker.shard_for_video(video_id),
            **_kwargs(
                manifest=_FakeManifest([ManifestEntry(video_id, "c1", True)]),
                history=_FakeHistory(),
                video_master=video_master,
            ),
        )

        assert len(video_master.upsert_calls) == 1
        [updated] = video_master.upsert_calls[0]
        assert updated.video_id == video_id
        assert updated.activity_state == expected_next_state


def _ids_in_same_shard(target_shard: int, count: int, *, prefix: str = "video") -> list[str]:
    """Find `count` video ids that all hash to `target_shard` -- collect_history_shard's
    own _reject_wrong_shard_entries requires every manifest entry handed to one call to
    genuinely belong to the shard number passed in, so a multi-entry fixture can't use
    arbitrary literal ids."""
    found = []
    candidate = 0
    while len(found) < count:
        video_id = f"{prefix}-{candidate}"
        if history_worker.shard_for_video(video_id) == target_shard:
            found.append(video_id)
        candidate += 1
    return found


def test_active_does_not_imply_due(monkeypatch):
    """AWS Cost Recovery regression test: an active tracked video must not automatically
    mean 'collect today' -- only videos tracking_schedule.select_due_video_ids considers
    due may ever reach YouTube. This is the exact architectural regression the task fixes
    and must never silently return: a manifest entry with no recorded published_at/
    activity_state at all (a manifest predating those fields) is the one case is_due_today
    can't tell about and must default to due; a well-established old Cold video with a
    real publishedAt/activityState (and no matching prior-day carry-forward source) is
    forced due too, since it has nothing to carry forward -- but neither case is requested
    because it is merely 'active'."""
    target_shard = 0
    stale_id, cold_id, inactive_id = _ids_in_same_shard(target_shard, 3)

    requested = []

    def fake_statistics(youtube, video_ids):
        requested.append(sorted(video_ids))
        return (
            [
                {"videoId": vid, "title": "t", "publishedAt": "2020-01-01T00:00:00Z", "viewCount": 1}
                for vid in video_ids
            ],
            {},
        )

    monkeypatch.setattr(history_worker, "get_video_statistics", fake_statistics)

    entries = [
        ManifestEntry(stale_id, "c1", True, published_at=None, activity_state=None),
        ManifestEntry(cold_id, "c1", True, published_at="2020-01-01T00:00:00Z", activity_state="Cold"),
        ManifestEntry(inactive_id, "c1", False, published_at="2020-01-01T00:00:00Z", activity_state="Hot"),
    ]
    video_master = _FakeVideoMaster(
        [
            Video(video_id=stale_id, creator_id="c1", title="t", published_at="2020-01-01T00:00:00Z"),
            Video(video_id=cold_id, creator_id="c1", title="t", published_at="2020-01-01T00:00:00Z"),
        ]
    )

    collect_history_shard(
        shard=target_shard,
        youtube=object(),
        manifest_store=_FakeManifest(entries),
        history_store=_FakeHistory(),
        video_master_store=video_master,
        collection_date=date(2026, 9, 15),
        observed_at="2026-09-15T18:00:00+09:00",
    )

    # Both stale_id (unrecognizable scheduler input) and cold_id (real Cold state,
    # no prior state anywhere to carry forward) are FORCED due for lack of any
    # carry-forward source -- never because they are merely "active". inactive_id
    # is excluded entirely, exactly as before this change.
    assert requested == [sorted([stale_id, cold_id])]


# --- AWS Cost Recovery: due-scheduling + carry-forward (Steps 1-4, 9) -------


def _due_and_cold_entries(shard: int):
    """One id whose is_due_today is always True (age <= RECENT_MAX_AGE_DAYS=7) and one whose
    Cold rotation slot on 2026-09-15 is guaranteed non-due (COLD_CYCLE_DAYS=15,
    so at most 1-in-15 stable slots is due on any given date -- searching a
    handful of candidate ids for one that lands off-slot is deterministic and
    fast, never a flaky retry)."""
    from tracking.tracking_schedule import is_due_today

    recent_id = _ids_in_same_shard(shard, 1, prefix="recent")[0]
    candidate = 0
    while True:
        cold_id = f"cold-{candidate}"
        if history_worker.shard_for_video(cold_id) == shard and not is_due_today(
            cold_id, "2020-01-01T00:00:00Z", "Cold", date(2026, 9, 15)
        ):
            break
        candidate += 1
    return recent_id, cold_id


def test_mixed_due_and_non_due_shard_only_requests_due_ids(monkeypatch):
    """Only due video ids are handed to YouTube; a non-due id with a usable
    prior-day carry-forward source is never requested."""
    shard = 0
    recent_id, cold_id = _due_and_cold_entries(shard)

    requested = []

    def fake_statistics(youtube, video_ids):
        requested.append(sorted(video_ids))
        return (
            [{"videoId": recent_id, "title": "t", "publishedAt": "2026-09-10T00:00:00Z", "viewCount": 999}],
            {},
        )

    monkeypatch.setattr(history_worker, "get_video_statistics", fake_statistics)

    history = _FakeHistory()
    history.objects[(date(2026, 9, 14), shard)] = [
        HistoryRow(video_id=cold_id, creator_id="c1", view_count=500, observed_at="2026-09-10T18:00:00+09:00", availability_status="available")
    ]
    video_master = _FakeVideoMaster(
        [
            Video(video_id=recent_id, creator_id="c1", title="t", published_at="2026-09-10T00:00:00Z"),
            Video(video_id=cold_id, creator_id="c1", title="t", published_at="2020-01-01T00:00:00Z", activity_state="Cold"),
        ]
    )

    result = collect_history_shard(
        shard=shard,
        youtube=object(),
        manifest_store=_FakeManifest(
            [
                ManifestEntry(recent_id, "c1", True, published_at="2026-09-10T00:00:00Z", activity_state="Unknown"),
                ManifestEntry(cold_id, "c1", True, published_at="2020-01-01T00:00:00Z", activity_state="Cold"),
            ]
        ),
        history_store=history,
        video_master_store=video_master,
        collection_date=date(2026, 9, 15),
        observed_at="2026-09-15T18:00:00+09:00",
    )

    assert requested == [[recent_id]]
    row_by_id = {row.video_id: row for row in result.rows}
    assert set(row_by_id) == {recent_id, cold_id}


def test_non_due_video_scheduler_state_is_untouched(monkeypatch):
    """A carried-forward video's Video Master row (snapshot_count, last_checked_at,
    quiet_streak, activity_state, classification fields) must not change at all."""
    shard = 0
    recent_id, cold_id = _due_and_cold_entries(shard)

    monkeypatch.setattr(
        history_worker,
        "get_video_statistics",
        lambda youtube, video_ids: (
            [{"videoId": recent_id, "title": "t", "publishedAt": "2026-09-10T00:00:00Z", "viewCount": 999}],
            {},
        ),
    )

    history = _FakeHistory()
    history.objects[(date(2026, 9, 14), shard)] = [
        HistoryRow(video_id=cold_id, creator_id="c1", view_count=500, observed_at="2026-09-01T18:00:00+09:00", availability_status="available")
    ]
    cold_before = Video(
        video_id=cold_id, creator_id="c1", title="t", published_at="2020-01-01T00:00:00Z",
        activity_state="Cold", last_checked_at="2026-09-01T18:00:00+09:00", last_view_count=500,
        snapshot_count=9, quiet_streak=3, last_classification_reason="demoted_after_quiet_streak",
    )
    video_master = _FakeVideoMaster(
        [
            Video(video_id=recent_id, creator_id="c1", title="t", published_at="2026-09-10T00:00:00Z"),
            cold_before,
        ]
    )

    collect_history_shard(
        shard=shard,
        youtube=object(),
        manifest_store=_FakeManifest(
            [
                ManifestEntry(recent_id, "c1", True, published_at="2026-09-10T00:00:00Z", activity_state="Unknown"),
                ManifestEntry(cold_id, "c1", True, published_at="2020-01-01T00:00:00Z", activity_state="Cold"),
            ]
        ),
        history_store=history,
        video_master_store=video_master,
        collection_date=date(2026, 9, 15),
        observed_at="2026-09-15T18:00:00+09:00",
    )

    assert video_master.videos[cold_id] == cold_before
    updated_ids = {video.video_id for call in video_master.upsert_calls for video in call}
    assert cold_id not in updated_ids


def test_carried_forward_row_preserves_real_previous_observed_at_and_view_count():
    """A carried-forward row must keep the video's actual previous observed_at/
    view_count -- never today's timestamp -- and still appear in the daily shard
    (full ranking/history coverage, Step 2/5)."""
    shard = 0
    recent_id, cold_id = _due_and_cold_entries(shard)
    import collection.history_worker as hw

    history = _FakeHistory()
    real_previous_observed_at = "2026-09-03T18:00:00+09:00"
    history.objects[(date(2026, 9, 14), shard)] = [
        HistoryRow(video_id=cold_id, creator_id="c1", view_count=4242, observed_at=real_previous_observed_at, availability_status="available")
    ]

    def fake_statistics(youtube, video_ids):
        return (
            [{"videoId": vid, "title": "t", "publishedAt": "2026-09-10T00:00:00Z", "viewCount": 1} for vid in video_ids],
            {},
        )

    import pytest

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(hw, "get_video_statistics", fake_statistics)
        result = hw.collect_history_shard(
            shard=shard,
            youtube=object(),
            manifest_store=_FakeManifest(
                [
                    ManifestEntry(recent_id, "c1", True, published_at="2026-09-10T00:00:00Z", activity_state="Unknown"),
                    ManifestEntry(cold_id, "c1", True, published_at="2020-01-01T00:00:00Z", activity_state="Cold"),
                ]
            ),
            history_store=history,
            video_master_store=None,
            collection_date=date(2026, 9, 15),
            observed_at="2026-09-15T18:00:00+09:00",
        )

    [carried] = [row for row in result.rows if row.video_id == cold_id]
    assert carried.observed_at == real_previous_observed_at
    assert carried.view_count == 4242
    assert carried.carried_forward is True


def test_new_video_with_no_usable_prior_state_is_collected_not_omitted():
    """A non-due video (by rotation) with nothing to carry forward -- absent from
    yesterday's shard and no last_view_count/last_checked_at on Video Master --
    must still be collected this run rather than silently dropped."""
    shard = 0
    _, cold_id = _due_and_cold_entries(shard)

    requested = []

    def fake_statistics(youtube, video_ids):
        requested.append(list(video_ids))
        return (
            [{"videoId": cold_id, "title": "t", "publishedAt": "2020-01-01T00:00:00Z", "viewCount": 7}],
            {},
        )

    import pytest
    import collection.history_worker as hw

    video_master = _FakeVideoMaster(
        [Video(video_id=cold_id, creator_id="c1", title="t", published_at="2020-01-01T00:00:00Z", activity_state="Cold")]
    )

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(hw, "get_video_statistics", fake_statistics)
        result = hw.collect_history_shard(
            shard=shard,
            youtube=object(),
            manifest_store=_FakeManifest(
                [ManifestEntry(cold_id, "c1", True, published_at="2020-01-01T00:00:00Z", activity_state="Cold")]
            ),
            history_store=_FakeHistory(),
            video_master_store=video_master,
            collection_date=date(2026, 9, 15),
            observed_at="2026-09-15T18:00:00+09:00",
        )

    assert requested == [[cold_id]]
    [row] = result.rows
    assert row.video_id == cold_id
    assert row.carried_forward is False


def test_carry_forward_falls_back_to_video_master_when_previous_shard_is_missing():
    """When yesterday's shard is entirely absent (a gap day) but Video Master
    already has a usable prior observation, that becomes the carry-forward
    source instead of forcing a needless YouTube re-fetch."""
    shard = 0
    recent_id, cold_id = _due_and_cold_entries(shard)
    import collection.history_worker as hw

    fallback_video = Video(
        video_id=cold_id, creator_id="c1", title="t", published_at="2020-01-01T00:00:00Z",
        activity_state="Cold", last_checked_at="2026-09-05T18:00:00+09:00", last_view_count=8080,
    )
    video_master = _FakeVideoMaster(
        [Video(video_id=recent_id, creator_id="c1", title="t", published_at="2026-09-10T00:00:00Z"), fallback_video]
    )

    def fake_statistics(youtube, video_ids):
        return (
            [{"videoId": vid, "title": "t", "publishedAt": "2026-09-10T00:00:00Z", "viewCount": 1} for vid in video_ids],
            {},
        )

    import pytest

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(hw, "get_video_statistics", fake_statistics)
        result = hw.collect_history_shard(
            shard=shard,
            youtube=object(),
            manifest_store=_FakeManifest(
                [
                    ManifestEntry(recent_id, "c1", True, published_at="2026-09-10T00:00:00Z", activity_state="Unknown"),
                    ManifestEntry(cold_id, "c1", True, published_at="2020-01-01T00:00:00Z", activity_state="Cold"),
                ]
            ),
            history_store=_FakeHistory(),  # no shard for any date at all -- a real gap
            video_master_store=video_master,
            collection_date=date(2026, 9, 15),
            observed_at="2026-09-15T18:00:00+09:00",
        )

    [carried] = [row for row in result.rows if row.video_id == cold_id]
    assert carried.observed_at == "2026-09-05T18:00:00+09:00"


def test_carry_forward_batches_video_master_fallback_lookups_into_one_call():
    """AWS Cost Recovery (third pass, Scope H): every video missing from
    yesterday's shard must be looked up in exactly one batched get_videos
    call, never one get_video call per video -- the worst-case quantified
    in the third-pass report (an entire missing previous shard) is exactly
    when this matters most."""
    from collection.history_worker import _carry_forward_non_due_rows

    non_due_ids = ["v1", "v2", "v3"]
    creator_by_video = {vid: "c1" for vid in non_due_ids}
    video_master = _FakeVideoMasterWithBatchGet(
        [
            Video(
                video_id="v1", creator_id="c1", title="t", published_at="2020-01-01T00:00:00Z",
                last_checked_at="2026-09-05T18:00:00+09:00", last_view_count=100,
            ),
            Video(
                video_id="v2", creator_id="c1", title="t", published_at="2020-01-01T00:00:00Z",
                last_checked_at="2026-09-06T18:00:00+09:00", last_view_count=200,
            ),
            # v3 intentionally has no Video Master row at all -- no usable prior state anywhere.
        ]
    )

    carried_rows, forced_due_ids = _carry_forward_non_due_rows(
        non_due_ids,
        creator_by_video=creator_by_video,
        collection_date=date(2026, 9, 15),
        shard=0,
        history_store=_FakeHistory(),  # empty -- every video is missing from "yesterday"
        video_master_store=video_master,
    )

    assert video_master.get_videos_calls == [["v1", "v2", "v3"]]
    assert {row.video_id for row in carried_rows} == {"v1", "v2"}
    assert forced_due_ids == {"v3"}


def test_carry_forward_never_calls_video_master_when_the_previous_shard_is_fully_healthy():
    """The other half of the same worst-case analysis: on an ordinary day
    where yesterday's shard has every non-due video, video_master_store must
    never be touched at all -- zero get_video/get_videos calls, batched or
    not."""
    from collection.history_worker import _carry_forward_non_due_rows

    non_due_ids = ["v1", "v2"]
    creator_by_video = {vid: "c1" for vid in non_due_ids}
    history_store = _FakeHistory()
    history_store.objects[(date(2026, 9, 14), 0)] = [
        HistoryRow(video_id="v1", creator_id="c1", view_count=10, observed_at="2026-09-14T18:00:00+09:00", availability_status="available"),
        HistoryRow(video_id="v2", creator_id="c1", view_count=20, observed_at="2026-09-14T18:00:00+09:00", availability_status="available"),
    ]
    video_master = _FakeVideoMasterWithBatchGet([])

    carried_rows, forced_due_ids = _carry_forward_non_due_rows(
        non_due_ids,
        creator_by_video=creator_by_video,
        collection_date=date(2026, 9, 15),
        shard=0,
        history_store=history_store,
        video_master_store=video_master,
    )

    assert video_master.get_videos_calls == []
    assert {row.video_id for row in carried_rows} == {"v1", "v2"}
    assert forced_due_ids == set()


def test_shard_exists_retry_recomputes_scheduler_updates_only_for_fresh_rows_not_carried_forward():
    """A shard_exists retry must recover exactly which rows were this run's own
    genuine observations (HistoryRow.carried_forward=False) versus carried
    forward -- a carried-forward row read back from the persisted combined
    shard must never reach _build_scheduler_updates, even on a retry whose own
    `observed_at` (always freshly computed from wall-clock time) does not match
    any timestamp already persisted in the shard."""
    shard = 0
    recent_id, cold_id = _due_and_cold_entries(shard)
    history = _FakeHistory()
    history.objects[(date(2026, 9, 15), shard)] = [
        HistoryRow(video_id=recent_id, creator_id="c1", view_count=999, observed_at="2026-09-15T18:00:00+09:00", availability_status="available", carried_forward=False),
        HistoryRow(video_id=cold_id, creator_id="c1", view_count=500, observed_at="2026-09-01T18:00:00+09:00", availability_status="available", carried_forward=True),
    ]
    existing_recent = Video(video_id=recent_id, creator_id="c1", title="t", published_at="2026-09-10T00:00:00Z")
    existing_cold = Video(
        video_id=cold_id, creator_id="c1", title="t", published_at="2020-01-01T00:00:00Z",
        activity_state="Cold", last_checked_at="2026-09-01T18:00:00+09:00", last_view_count=500,
    )
    video_master = _FakeVideoMaster([existing_recent, existing_cold])

    # Deliberately NOT the persisted rows' own observed_at: a real retry always
    # computes its own fresh wall-clock `observed_at` (history_worker_handler.
    # lambda_handler calls datetime.now() on every invocation, including a
    # retry), so it essentially never matches what an earlier, already-
    # succeeded invocation persisted. Proves recovery does not depend on that
    # coincidence -- only HistoryRow.carried_forward does.
    collect_history_shard(
        shard=shard,
        youtube=object(),
        manifest_store=_FakeManifest(
            [ManifestEntry(recent_id, "c1", True), ManifestEntry(cold_id, "c1", True)]
        ),
        history_store=history,
        video_master_store=video_master,
        collection_date=date(2026, 9, 15),
        observed_at="2026-09-15T18:05:33+09:00",
    )

    updated_ids = {video.video_id for call in video_master.upsert_calls for video in call}
    assert updated_ids == {recent_id}
    assert video_master.videos[cold_id] == existing_cold


# --- Micro-task 3: retry-safe scheduler-state write-back ---------------------


def _raise_if_called(youtube, video_ids):
    raise AssertionError("get_video_statistics must not be called on a shard_exists retry")


def test_fresh_shard_applies_scheduler_updates_exactly_once(monkeypatch):
    """A first-time (not shard_exists) run classifies and persists every successfully
    observed video's scheduler state exactly once."""
    existing = Video(video_id="v1", creator_id="c1", title="t", published_at="2026-01-01T00:00:00Z")
    video_master = _FakeVideoMaster([existing])
    monkeypatch.setattr(
        history_worker,
        "get_video_statistics",
        lambda youtube, video_ids: (
            [{"videoId": "v1", "title": "t", "publishedAt": "2026-01-01T00:00:00Z", "viewCount": 100}],
            {},
        ),
    )

    collect_history_shard(
        shard=history_worker.shard_for_video("v1"),
        **_kwargs(
            manifest=_FakeManifest([ManifestEntry("v1", "c1", True)]),
            history=_FakeHistory(),
            video_master=video_master,
        ),
    )

    assert len(video_master.upsert_calls) == 1
    assert video_master.videos["v1"].snapshot_count == 1
    assert video_master.videos["v1"].last_checked_at == "2026-09-15T18:00:00+09:00"


def test_shard_exists_with_no_prior_scheduler_updates_recovers_them(monkeypatch):
    """Simulates the exact failure window this task fixes: write_daily_shard already
    succeeded (shard_exists is True) but the previous invocation was interrupted before
    any Video Master write-back happened. A retry must complete the write-back by
    reading the already-persisted rows back, without calling YouTube again."""
    shard = history_worker.shard_for_video("v1")
    history = _FakeHistory()
    row = HistoryRow(
        video_id="v1", creator_id="c1", view_count=100, observed_at="2026-09-15T18:00:00+09:00",
        availability_status="available",
    )
    history.objects[(date(2026, 9, 15), shard)] = [row]

    existing = Video(video_id="v1", creator_id="c1", title="t", published_at="2026-01-01T00:00:00Z")
    video_master = _FakeVideoMaster([existing])
    monkeypatch.setattr(history_worker, "get_video_statistics", _raise_if_called)

    collect_history_shard(
        shard=shard,
        **_kwargs(
            manifest=_FakeManifest([ManifestEntry("v1", "c1", True)]),
            history=history,
            video_master=video_master,
        ),
    )

    assert len(video_master.upsert_calls) == 1
    [updated] = video_master.upsert_calls[0]
    assert updated.last_checked_at == "2026-09-15T18:00:00+09:00"
    assert updated.last_view_count == 100
    assert updated.snapshot_count == 1


def test_shard_exists_with_all_updates_already_applied_is_a_no_op(monkeypatch):
    """A retry where every video's Video Master row already reflects this exact
    observation (last_checked_at == the persisted row's observed_at) must not
    reclassify or re-upsert anything."""
    shard = history_worker.shard_for_video("v1")
    history = _FakeHistory()
    row = HistoryRow(
        video_id="v1", creator_id="c1", view_count=100, observed_at="2026-09-15T18:00:00+09:00",
        availability_status="available",
    )
    history.objects[(date(2026, 9, 15), shard)] = [row]

    already_applied = Video(
        video_id="v1",
        creator_id="c1",
        title="t",
        published_at="2026-01-01T00:00:00Z",
        activity_state="Unknown",
        last_checked_at="2026-09-15T18:00:00+09:00",
        last_view_count=100,
        snapshot_count=1,
    )
    video_master = _FakeVideoMaster([already_applied])
    monkeypatch.setattr(history_worker, "get_video_statistics", _raise_if_called)

    collect_history_shard(
        shard=shard,
        **_kwargs(
            manifest=_FakeManifest([ManifestEntry("v1", "c1", True)]),
            history=history,
            video_master=video_master,
        ),
    )

    assert video_master.upsert_calls == []
    assert video_master.videos["v1"] == already_applied


def test_shard_exists_with_partially_applied_updates_completes_only_the_missing_ones(monkeypatch):
    """The exact integrity example from the task: of several videos in one shard, some
    already got their Video Master write-back from a prior, interrupted invocation and
    some did not. A retry must not touch the already-applied ones and must complete
    exactly the remainder -- the end state is equivalent to one successful application."""
    applied_id, pending_id = _ids_in_same_shard(0, 2, prefix="partial")
    shard = 0
    history = _FakeHistory()
    observed_at = "2026-09-15T18:00:00+09:00"
    rows = [
        HistoryRow(video_id=applied_id, creator_id="c1", view_count=100, observed_at=observed_at, availability_status="available"),
        HistoryRow(video_id=pending_id, creator_id="c1", view_count=200, observed_at=observed_at, availability_status="available"),
    ]
    history.objects[(date(2026, 9, 15), shard)] = rows

    already_applied = Video(
        video_id=applied_id,
        creator_id="c1",
        title="t",
        published_at="2026-01-01T00:00:00Z",
        last_checked_at=observed_at,
        last_view_count=100,
        snapshot_count=1,
    )
    not_yet_applied = Video(
        video_id=pending_id,
        creator_id="c1",
        title="t",
        published_at="2026-01-01T00:00:00Z",
        last_checked_at="2026-09-14T18:00:00+09:00",
        last_view_count=50,
        snapshot_count=1,
    )
    video_master = _FakeVideoMaster([already_applied, not_yet_applied])
    monkeypatch.setattr(history_worker, "get_video_statistics", _raise_if_called)

    collect_history_shard(
        shard=shard,
        **_kwargs(
            manifest=_FakeManifest([ManifestEntry(applied_id, "c1", True), ManifestEntry(pending_id, "c1", True)]),
            history=history,
            video_master=video_master,
        ),
    )

    assert len(video_master.upsert_calls) == 1
    updated_ids = {video.video_id for video in video_master.upsert_calls[0]}
    assert updated_ids == {pending_id}
    assert video_master.videos[applied_id] == already_applied
    assert video_master.videos[pending_id].last_checked_at == observed_at
    assert video_master.videos[pending_id].last_view_count == 200
    assert video_master.videos[pending_id].snapshot_count == 2


def test_same_observation_across_fresh_run_and_retry_never_double_increments_snapshot_count(monkeypatch):
    """Calling collect_history_shard twice for the same day -- once fresh, once as a
    shard_exists retry -- must leave snapshot_count advanced by exactly 1, not 2."""
    shard = history_worker.shard_for_video("v1")
    history = _FakeHistory()
    existing = Video(video_id="v1", creator_id="c1", title="t", published_at="2026-01-01T00:00:00Z", snapshot_count=5)
    video_master = _FakeVideoMaster([existing])

    monkeypatch.setattr(
        history_worker,
        "get_video_statistics",
        lambda youtube, video_ids: (
            [{"videoId": "v1", "title": "t", "publishedAt": "2026-01-01T00:00:00Z", "viewCount": 100}],
            {},
        ),
    )
    kwargs = _kwargs(
        manifest=_FakeManifest([ManifestEntry("v1", "c1", True)]), history=history, video_master=video_master
    )

    collect_history_shard(shard=shard, **kwargs)
    assert video_master.videos["v1"].snapshot_count == 6

    # Second call: shard_exists is now True, and must not call YouTube again.
    monkeypatch.setattr(history_worker, "get_video_statistics", _raise_if_called)
    collect_history_shard(shard=shard, **kwargs)

    assert video_master.videos["v1"].snapshot_count == 6
    assert len(video_master.upsert_calls) == 1


def test_shard_exists_retry_recovery_preserves_unrelated_video_master_metadata(monkeypatch):
    """Recovery-path updates go through the same dataclasses.replace(existing, ...) merge
    as a fresh run -- title/published_at/creator_id/discovered_at survive untouched."""
    shard = history_worker.shard_for_video("v1")
    history = _FakeHistory()
    observed_at = "2026-09-15T18:00:00+09:00"
    history.objects[(date(2026, 9, 15), shard)] = [
        HistoryRow(video_id="v1", creator_id="c1", view_count=100, observed_at=observed_at, availability_status="available")
    ]
    existing = Video(
        video_id="v1",
        creator_id="c1",
        title="Real Title",
        published_at="2020-05-01T00:00:00Z",
        discovered_at="2026-01-01T00:00:00Z",
    )
    video_master = _FakeVideoMaster([existing])
    monkeypatch.setattr(history_worker, "get_video_statistics", _raise_if_called)

    collect_history_shard(
        shard=shard,
        **_kwargs(
            manifest=_FakeManifest([ManifestEntry("v1", "c1", True)]),
            history=history,
            video_master=video_master,
        ),
    )

    [updated] = video_master.upsert_calls[0]
    assert updated.title == "Real Title"
    assert updated.published_at == "2020-05-01T00:00:00Z"
    assert updated.creator_id == "c1"
    assert updated.discovered_at == "2026-01-01T00:00:00Z"


# --- Final correction: monotonic (not equality-only) idempotency guard ------


def _replayed_shard(shard, video_id, *, existing, observed_at, view_count=100):
    """Set up a video whose Video Master row already has `existing.last_checked_at`,
    then replay one already-persisted HistoryRow observed at `observed_at`."""
    history = _FakeHistory()
    history.objects[(date(2026, 9, 15), shard)] = [
        HistoryRow(
            video_id=video_id, creator_id="c1", view_count=view_count, observed_at=observed_at,
            availability_status="available",
        )
    ]
    video_master = _FakeVideoMaster([existing])
    return history, video_master


def test_replaying_the_same_observation_is_a_no_op(monkeypatch):
    """existing.last_checked_at == row.observed_at -> no-op."""
    shard = history_worker.shard_for_video("v1")
    same_timestamp = "2026-09-15T18:00:00+09:00"
    existing = Video(
        video_id="v1", creator_id="c1", title="t", published_at="2026-01-01T00:00:00Z",
        last_checked_at=same_timestamp, last_view_count=100, snapshot_count=3,
    )
    history, video_master = _replayed_shard(shard, "v1", existing=existing, observed_at=same_timestamp)
    monkeypatch.setattr(history_worker, "get_video_statistics", _raise_if_called)

    collect_history_shard(
        shard=shard,
        **_kwargs(manifest=_FakeManifest([ManifestEntry("v1", "c1", True)]), history=history, video_master=video_master),
    )

    assert video_master.upsert_calls == []
    assert video_master.videos["v1"] == existing


def test_replaying_an_older_observation_than_current_state_is_a_no_op(monkeypatch):
    """existing.last_checked_at > row.observed_at -> no-op; an old shard replayed after a
    newer observation already landed must never regress scheduler state backwards."""
    shard = history_worker.shard_for_video("v1")
    newer_timestamp = "2026-09-15T18:00:00+09:00"
    older_timestamp = "2026-09-10T18:00:00+09:00"
    existing = Video(
        video_id="v1", creator_id="c1", title="t", published_at="2026-01-01T00:00:00Z",
        activity_state="Hot", last_checked_at=newer_timestamp, last_view_count=999_999,
        snapshot_count=10, quiet_streak=0,
    )
    # The replayed row is an OLD observation (a stale/reprocessed shard) with a much
    # smaller view count -- if applied, it would regress last_view_count/activity_state.
    history, video_master = _replayed_shard(
        shard, "v1", existing=existing, observed_at=older_timestamp, view_count=10
    )
    monkeypatch.setattr(history_worker, "get_video_statistics", _raise_if_called)

    collect_history_shard(
        shard=shard,
        **_kwargs(manifest=_FakeManifest([ManifestEntry("v1", "c1", True)]), history=history, video_master=video_master),
    )

    assert video_master.upsert_calls == []
    assert video_master.videos["v1"] == existing


def test_replaying_a_genuinely_newer_observation_is_applied(monkeypatch):
    """existing.last_checked_at < row.observed_at -> classify and persist normally."""
    shard = history_worker.shard_for_video("v1")
    older_timestamp = "2026-09-10T18:00:00+09:00"
    newer_timestamp = "2026-09-15T18:00:00+09:00"
    existing = Video(
        video_id="v1", creator_id="c1", title="t", published_at="2026-01-01T00:00:00Z",
        last_checked_at=older_timestamp, last_view_count=100, snapshot_count=1,
    )
    history, video_master = _replayed_shard(shard, "v1", existing=existing, observed_at=newer_timestamp, view_count=200)
    monkeypatch.setattr(history_worker, "get_video_statistics", _raise_if_called)

    collect_history_shard(
        shard=shard,
        **_kwargs(manifest=_FakeManifest([ManifestEntry("v1", "c1", True)]), history=history, video_master=video_master),
    )

    assert len(video_master.upsert_calls) == 1
    [updated] = video_master.upsert_calls[0]
    assert updated.last_checked_at == newer_timestamp
    assert updated.last_view_count == 200
    assert updated.snapshot_count == 2


def test_none_last_checked_at_is_applied_normally(monkeypatch):
    """existing.last_checked_at is None -> apply normally (first-ever observation;
    nothing to compare against, so the monotonic guard does not block it)."""
    shard = history_worker.shard_for_video("v1")
    observed_at = "2026-09-15T18:00:00+09:00"
    existing = Video(video_id="v1", creator_id="c1", title="t", published_at="2026-01-01T00:00:00Z")
    assert existing.last_checked_at is None
    history, video_master = _replayed_shard(shard, "v1", existing=existing, observed_at=observed_at, view_count=50)
    monkeypatch.setattr(history_worker, "get_video_statistics", _raise_if_called)

    collect_history_shard(
        shard=shard,
        **_kwargs(manifest=_FakeManifest([ManifestEntry("v1", "c1", True)]), history=history, video_master=video_master),
    )

    assert len(video_master.upsert_calls) == 1
    [updated] = video_master.upsert_calls[0]
    assert updated.last_checked_at == observed_at
    assert updated.snapshot_count == 1


def test_old_shard_replay_does_not_regress_any_scheduler_field(monkeypatch):
    """An old-shard replay must leave last_checked_at, last_view_count, snapshot_count,
    and quiet_streak exactly as newer, already-applied scheduler state left them --
    not just activity_state (already covered above), every one of these four fields."""
    shard = history_worker.shard_for_video("v1")
    newer_timestamp = "2026-09-15T18:00:00+09:00"
    older_timestamp = "2026-09-01T18:00:00+09:00"
    existing = Video(
        video_id="v1", creator_id="c1", title="t", published_at="2026-01-01T00:00:00Z",
        activity_state="Warm", last_checked_at=newer_timestamp, last_view_count=5_000,
        snapshot_count=7, quiet_streak=2,
    )
    history, video_master = _replayed_shard(shard, "v1", existing=existing, observed_at=older_timestamp, view_count=1)
    monkeypatch.setattr(history_worker, "get_video_statistics", _raise_if_called)

    collect_history_shard(
        shard=shard,
        **_kwargs(manifest=_FakeManifest([ManifestEntry("v1", "c1", True)]), history=history, video_master=video_master),
    )

    unchanged = video_master.videos["v1"]
    assert unchanged.last_checked_at == newer_timestamp
    assert unchanged.last_view_count == 5_000
    assert unchanged.snapshot_count == 7
    assert unchanged.quiet_streak == 2


# --- AWS Cost Recovery second pass: manifest-sourced topic_by_video ---------


def test_topic_by_video_uses_the_manifest_persisted_topic(monkeypatch):
    """collect_history_shard's topic_by_video comes straight from each active
    manifest entry's own topic -- no DynamoDB call anywhere in this path."""
    monkeypatch.setattr(
        history_worker,
        "get_video_statistics",
        lambda youtube, video_ids: (
            [{"videoId": vid, "title": "t", "publishedAt": "2026-01-01T00:00:00Z", "viewCount": 1} for vid in video_ids],
            {},
        ),
    )

    result = collect_history_shard(
        shard=history_worker.shard_for_video("v1"),
        **_kwargs(
            manifest=_FakeManifest([ManifestEntry("v1", "c1", True, topic="valorant")]),
            history=_FakeHistory(),
        ),
    )

    assert result.topic_by_video == {"v1": "valorant"}


def test_topic_by_video_falls_back_to_other_when_manifest_topic_is_missing(monkeypatch):
    """A manifest entry with no topic (predates the field, or backfill/discovery-time
    classification hasn't landed yet) falls back to OTHER_TOPIC, not omitted or crashed."""
    monkeypatch.setattr(
        history_worker,
        "get_video_statistics",
        lambda youtube, video_ids: (
            [{"videoId": vid, "title": "t", "publishedAt": "2026-01-01T00:00:00Z", "viewCount": 1} for vid in video_ids],
            {},
        ),
    )

    result = collect_history_shard(
        shard=history_worker.shard_for_video("v1"),
        **_kwargs(
            manifest=_FakeManifest([ManifestEntry("v1", "c1", True, topic=None)]),
            history=_FakeHistory(),
        ),
    )

    assert result.topic_by_video == {"v1": "other"}


def test_topic_by_video_falls_back_to_other_for_an_unrecognized_persisted_topic(monkeypatch):
    """A corrupted/stale/manually-edited topic value is never trusted as-is --
    same safety net as video_topics.resolve_video_topics' own persisted-value check."""
    monkeypatch.setattr(
        history_worker,
        "get_video_statistics",
        lambda youtube, video_ids: (
            [{"videoId": vid, "title": "t", "publishedAt": "2026-01-01T00:00:00Z", "viewCount": 1} for vid in video_ids],
            {},
        ),
    )

    result = collect_history_shard(
        shard=history_worker.shard_for_video("v1"),
        **_kwargs(
            manifest=_FakeManifest([ManifestEntry("v1", "c1", True, topic="not-a-real-topic")]),
            history=_FakeHistory(),
        ),
    )

    assert result.topic_by_video == {"v1": "other"}
