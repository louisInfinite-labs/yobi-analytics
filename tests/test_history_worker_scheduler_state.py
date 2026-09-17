from datetime import date

import pytest

import history_worker
from history_store import HistoryRow
from history_worker import collect_history_shard
from tracking_manifest import ManifestEntry
from video_master import Video


class _FakeManifest:
    """A tracking-manifest store stub returning one fixed set of active entries."""

    def __init__(self, entries):
        self._entries = entries

    def read_shard(self, shard):
        return self._entries


class _FakeHistory:
    """A history store stub with in-memory shard storage, matching the real
    idempotency contract (shard_exists gates whether YouTube gets called again)."""

    def __init__(self):
        self.objects = {}

    def write_daily_shard(self, collection_date, shard, rows):
        self.objects[(collection_date, shard)] = list(rows)
        from history_store import daily_history_key

        return daily_history_key(collection_date, shard)

    def read_daily_shard(self, collection_date, shard):
        return self.objects.get((collection_date, shard), [])

    def shard_exists(self, collection_date, shard):
        return (collection_date, shard) in self.objects


class _FakeVideoMaster:
    """A Video Master store stub: an in-memory dict of authoritative Video rows,
    matching video_master.VideoMasterStore's shape (get_video/upsert_videos)."""

    def __init__(self, videos: list[Video]):
        self.videos = {video.video_id: video for video in videos}
        self.upsert_calls: list[list[Video]] = []

    def get_video(self, video_id):
        return self.videos.get(video_id)

    def upsert_videos(self, videos):
        self.upsert_calls.append(list(videos))
        for video in videos:
            self.videos[video.video_id] = video


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


def test_full_catalog_collection_still_requests_every_active_manifest_entry(monkeypatch):
    """This task deliberately does not enable select_due_video_ids in Phase B yet --
    every active manifest entry is still requested regardless of any activityState/
    publishedAt on the manifest, exactly as before this change."""
    target_shard = 0
    stale_id, cold_id, inactive_id = _ids_in_same_shard(target_shard, 3)

    requested = []

    def fake_statistics(youtube, video_ids):
        requested.append(list(video_ids))
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

    assert requested == [sorted([stale_id, cold_id])]


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
