"""F37 one-time backfill: planning counts, dry-run purity, idempotent/resumable execution, and safe handling of unavailable videos --
all with injected fakes (no YouTube, no AWS)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from collection.youtube_client import SKIP_REASON_NO_DATA, QuotaExhaustedError
from scripts.backfill import backfill_video_actual_start as backfill
from scripts.backfill.backfill_video_actual_start import CatalogRow, Checkpoint, plan_backfill, run_backfill
from stores.history_store import shard_for_video


def _rows(n_missing=3, n_done=2):
    rows = [CatalogRow(f"m{i}", "live", "completed", None, "2024") for i in range(n_missing)]
    rows += [CatalogRow(f"d{i}", "live", "completed", "2024-01-01T00:00:00+00:00", "2024") for i in range(n_done)]
    rows += [CatalogRow("up", "upload", None), CatalogRow("sh", "short", None), CatalogRow("un", None, None)]
    rows += [CatalogRow("soon", "live", "upcoming"), CatalogRow("now", "live", "live")]
    return rows


def test_plan_counts_only_completed_livestreams_without_a_start():
    """Existing vs missing vs ineligible, and the request/quota/write estimates at 50 ids per request."""
    plan = plan_backfill(_rows(120, 5))
    assert plan["rowsExamined"] == 120 + 5 + 5
    assert plan["completedLivestreams"] == 125 and plan["completedWithActualStart"] == 5 and plan["completedMissingActualStart"] == 120
    assert plan["eligible"] == 120 and plan["liveByStatus"] == {"completed": 125, "live": 1, "upcoming": 1}
    assert plan["youtubeRequestsPlanned"] == 3 and plan["youtubeQuotaUnitsPlanned"] == 3
    assert plan["masterWritesPlannedMax"] == 120 and plan["dynamoWriteUnitsPlannedMax"] == 120
    assert plan["byContentType"]["upload"] == 1 and plan["byContentType"]["unclassified"] == 1


def test_batch_size_is_capped_at_fifty():
    """A larger --batch-size cannot exceed the YouTube per-request id limit."""
    assert plan_backfill(_rows(120, 0), batch_size=500)["youtubeBatchSize"] == 50


def test_dry_run_touches_nothing_external():
    """A dry run never builds a YouTube client, never writes, and never patches a manifest."""
    def boom(*args, **kwargs):
        raise AssertionError("a dry run must not call this")

    summary = run_backfill(_rows(), execute=False, youtube_factory=boom, get_statistics=boom, write_start=boom, patch=boom)
    assert summary["status"] == backfill.STATUS_DRY_RUN and summary["eligible"] == 3 and "startsWritten" not in summary


class _Env:
    """Fakes for one execution: a YouTube whose answers are scripted, an in-memory master, and a recording manifest patch."""

    def __init__(self, answers, *, skipped=None):
        self.answers = answers  # videoId -> parsed video dict (absent = not returned)
        self.skipped = skipped or {}
        self.requests: list[list[str]] = []
        self.master: dict[str, str] = {}
        self.patches: list[tuple[int, dict]] = []

    def get_statistics(self, youtube, ids):
        self.requests.append(list(ids))
        return [self.answers[i] for i in ids if i in self.answers], {i: self.skipped.get(i, SKIP_REASON_NO_DATA) for i in ids if i not in self.answers}

    def write_start(self, video_id, start):
        if video_id in self.master:
            return False
        self.master[video_id] = start
        return True

    def patch(self, store, shard, apply):
        probe = {}
        import tracking.tracking_manifest as manifest

        entries = [manifest.ManifestEntry(video_id=v, creator_id="c") for v in self.master if shard_for_video(v) == shard]
        probe.update({e.video_id: e.actual_start_at for e in apply(entries)})
        self.patches.append((shard, probe))

    def run(self, rows, **kwargs):
        return run_backfill(rows, execute=True, manifest_store=object(), youtube_factory=lambda: object(), get_statistics=self.get_statistics,
                            write_start=self.write_start, patch=self.patch, **kwargs)


def _answer(video_id, start="2026-09-14T15:30:00Z", **fields):
    return {"videoId": video_id, "contentType": "live", "liveStatus": "completed", "actualStartTime": start, **fields}


def test_execute_writes_each_start_once_and_mirrors_it_to_the_manifest():
    """Starts are normalized, written conditionally, then mirrored per shard; counters add up."""
    env = _Env({f"m{i}": _answer(f"m{i}") for i in range(3)})
    summary = env.run(_rows(3, 2))

    assert summary["startsWritten"] == 3 and summary["status"] == backfill.STATUS_COMPLETE
    assert set(env.master) == {"m0", "m1", "m2"} and set(env.master.values()) == {"2026-09-14T15:30:00+00:00"}
    mirrored = {v: s for _shard, probe in env.patches for v, s in probe.items()}
    assert mirrored == env.master
    assert all(len(ids) <= 50 for ids in env.requests)


def test_rerun_is_idempotent_and_writes_unchanged_values_never():
    """After a full run the same catalog (now carrying the starts) plans zero work and issues no request."""
    env = _Env({f"m{i}": _answer(f"m{i}") for i in range(3)})
    env.run(_rows(3, 0))
    done = [CatalogRow(v, "live", "completed", s) for v, s in env.master.items()]
    requests_before = len(env.requests)

    again = env.run(done)
    assert again["eligible"] == 0 and again["startsWritten"] == 0 and len(env.requests) == requests_before


def test_a_master_that_already_has_a_start_rejects_the_write_and_is_counted():
    """If a start appeared between the scan and the write, the conditional write is rejected: nothing is overwritten."""
    env = _Env({"m0": _answer("m0")})
    env.master["m0"] = "2020-01-01T00:00:00+00:00"
    summary = env.run(_rows(1, 0))
    assert summary["startsWritten"] == 0 and summary["masterRejected"] == 1
    assert env.master["m0"] == "2020-01-01T00:00:00+00:00"


def test_unavailable_no_start_and_changed_videos_are_settled_not_guessed(tmp_path: Path):
    """Deleted/private, no start and no-longer-completed videos get no date, land in the checkpoint, and are not re-requested."""
    env = _Env({
        "m1": _answer("m1", start=None),  # returned without a usable start
        "m2": {"videoId": "m2", "contentType": "upload", "liveStatus": None},  # no longer a livestream
    })
    checkpoint = Checkpoint.load(tmp_path / "cp.json")
    summary = env.run(_rows(3, 0), checkpoint=checkpoint)

    assert summary["startsWritten"] == 0 and env.master == {}
    assert (summary["settledUnavailable"], summary["settledNoStart"], summary["settledNotCompletedLivestream"]) == (1, 1, 1)
    saved = json.loads((tmp_path / "cp.json").read_text(encoding="utf-8"))["settled"]
    assert saved == {"m0": "unavailable", "m1": "noStartTime", "m2": "notCompletedLivestream"}

    resumed = env.run(_rows(3, 0), checkpoint=Checkpoint.load(tmp_path / "cp.json"))
    assert resumed["eligible"] == 0
    retried = env.run(_rows(3, 0), checkpoint=Checkpoint.load(tmp_path / "cp.json"), retry_unavailable=True)
    assert retried["eligible"] == 3


def test_max_batches_bounds_a_run_and_resumes_cleanly():
    """The run stops after --max-batches, reports what is deferred, and a second run finishes without repeating work."""
    ids = [f"x{i}" for i in range(130)]
    rows = [CatalogRow(i, "live", "completed") for i in ids]
    env = _Env({i: _answer(i) for i in ids})
    first = env.run(rows, max_batches=2)
    assert first["youtubeRequests"] == 2 and first["batchesDeferred"] >= 1 and first["status"] == backfill.STATUS_PARTIAL

    remaining = [CatalogRow(i, "live", "completed", env.master.get(i)) for i in ids]
    second = env.run(remaining, max_batches=None)
    assert second["status"] == backfill.STATUS_COMPLETE and set(env.master) == set(ids)
    assert sum(len(batch) for batch in env.requests) == 130  # nothing requested twice


def test_quota_exhaustion_stops_after_persisting_what_was_fetched():
    """A quota error aborts the run as PARTIAL (recoverable by re-running); nothing was written."""
    env = _Env({})

    def quota(youtube, ids):
        raise QuotaExhaustedError("quota")

    summary = run_backfill(_rows(2, 0), execute=True, manifest_store=object(), youtube_factory=lambda: object(), get_statistics=quota,
                           write_start=env.write_start, patch=env.patch)
    assert summary["abortedReason"] == "YouTube quota exhausted" and summary["status"] == backfill.STATUS_PARTIAL


def test_a_crash_before_the_manifest_patch_is_repaired_from_the_checkpoint(tmp_path: Path):
    """manifestPending left by an interrupted run is mirrored first thing on the next run."""
    env = _Env({})
    env.master["m0"] = "2026-09-14T15:30:00+00:00"
    checkpoint = Checkpoint(manifest_pending={"m0": "2026-09-14T15:30:00+00:00"}, path=tmp_path / "cp.json")
    summary = env.run([CatalogRow("m0", "live", "completed", "2026-09-14T15:30:00+00:00")], checkpoint=checkpoint)

    assert summary["manifestShardsPatched"] == 1 and checkpoint.manifest_pending == {}
    assert env.patches[0][1] == {"m0": "2026-09-14T15:30:00+00:00"}


def test_cli_refuses_to_write_without_yes_or_with_an_offline_sample(capsys):
    """--execute needs --yes and a real source; an offline --ranking-dir sample can never be a write source."""
    assert backfill.main(["--execute"]) == 2
    assert backfill.main(["--execute", "--yes", "--ranking-dir", "."]) == 2


def test_offline_dry_run_reads_ranking_files_without_aws(tmp_path: Path, capsys):
    """--ranking-dir plans from downloaded per-creator result files and exits 0 without any AWS or YouTube call."""
    payload = {"videos": [
        {"videoId": "a", "contentType": "live", "liveStatus": "completed", "publishedAt": "2024-05-01T00:00:00Z"},
        {"videoId": "b", "contentType": "live", "liveStatus": "completed", "publishedAt": "2023-05-01T00:00:00Z", "actualStartAt": "2023-05-01T01:00:00+00:00"},
        {"videoId": "c", "contentType": "upload", "liveStatus": None, "publishedAt": "2023-05-01T00:00:00Z"},
    ]}
    (tmp_path / "creator.json").write_text(json.dumps(payload), encoding="utf-8")
    assert backfill.main(["--ranking-dir", str(tmp_path), "--checkpoint", str(tmp_path / "cp.json")]) == 0
    out = capsys.readouterr().out
    assert "eligible: 1" in out and "completedWithActualStart: 1" in out and "RESULT: DRY RUN" in out
    assert not (tmp_path / "cp.json").exists()


def test_creator_scope_limits_the_plan_and_reports_the_catalog_size():
    """A creator filter (for example the VSPO roster) plans only those creators' videos."""
    rows = [CatalogRow("a1", "live", "completed", None, "2024", "vspo_c"), CatalogRow("a2", "live", "completed", None, "2024", "vspo_c"), CatalogRow("b1", "live", "completed", None, "2024", "other_c")]
    summary = run_backfill(rows, execute=False, creator_ids={"vspo_c"})
    assert (summary["rowsInCatalog"], summary["rowsExamined"], summary["eligible"], summary["scopeCreators"]) == (3, 2, 2, 1)


def test_probe_only_spends_requests_but_writes_nothing_and_keeps_no_state(tmp_path: Path):
    """--probe-only asks YouTube, reports recoverability, and calls no write, no manifest patch and no checkpoint save."""
    rows = [CatalogRow(f"m{i}", "live", "completed", None, "2024", "vspo_c") for i in range(4)]
    env = _Env({"m0": _answer("m0"), "m1": _answer("m1"), "m2": _answer("m2", start=None)})  # m3 unavailable

    def boom(*args, **kwargs):
        raise AssertionError("a probe must not write")

    cp = tmp_path / "cp.json"
    summary = run_backfill(rows, execute=True, probe_only=True, checkpoint=Checkpoint(path=cp), manifest_store=object(), youtube_factory=lambda: object(),
                           get_statistics=env.get_statistics, write_start=boom, patch=boom, creator_ids={"vspo_c"})

    assert summary["mode"].startswith("PROBE ONLY") and summary["probeRecoverable"] == 2
    assert (summary["settledUnavailable"], summary["settledNoStart"], summary["startsWritten"]) == (1, 1, 0)
    assert not cp.exists() and env.master == {} and env.patches == []


def test_cli_probe_only_needs_yes_and_excludes_execute(capsys):
    """The probe spends quota, so it needs --yes, and it can never be combined with a write run."""
    assert backfill.main(["--probe-only"]) == 2
    assert backfill.main(["--probe-only", "--yes", "--execute"]) == 2


def test_scoped_dry_run_reads_only_the_scoped_creators_through_the_index(monkeypatch, capsys):
    """--creator plans from get_videos_by_creator (creatorId index); the whole-table scan is never used for a scoped run."""
    from stores import dynamodb_store
    from tracking.video_master import Video

    def no_scan():
        raise AssertionError("a scoped run must not scan the whole table")

    queried = []

    def by_creator(creator_id):
        queried.append(creator_id)
        return [Video(video_id=f"{creator_id}-1", creator_id=creator_id, title="t", published_at="2026-01-01T00:00:00Z", content_type="live", live_status="completed"),
                Video(video_id=f"{creator_id}-2", creator_id=creator_id, title="t", published_at="2026-01-01T00:00:00Z", content_type="live", live_status="completed", actual_start_at="2026-01-01T00:00:00+00:00")]

    monkeypatch.setattr(dynamodb_store, "scan_video_actual_start_items", no_scan)
    monkeypatch.setattr(dynamodb_store, "get_videos_by_creator", by_creator)

    assert backfill.main(["--creator", "aizawa_ema", "--checkpoint", "no-such-checkpoint.json"]) == 0

    out = capsys.readouterr().out
    assert queried == ["aizawa_ema"] and "eligible: 1" in out and "completedWithActualStart: 1" in out and "RESULT: DRY RUN" in out
