import importlib.util
import sys
from dataclasses import replace
from pathlib import Path

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

_MODULE_PATH = Path(__file__).resolve().parents[3] / "scripts" / "backfill" / "backfill_video_topics.py"
_spec = importlib.util.spec_from_file_location("backfill_video_topics", _MODULE_PATH)
backfill_video_topics = importlib.util.module_from_spec(_spec)
sys.modules.setdefault("backfill_video_topics", backfill_video_topics)
_spec.loader.exec_module(backfill_video_topics)

from stores.dynamodb_store import CREATOR_ID_INDEX, VIDEO_MASTER_TABLE, upsert_videos  # noqa: E402
from stores.history_store import shard_for_video  # noqa: E402
from tracking.tracking_manifest import (  # noqa: E402
    PATCH_SHARD_MAX_ATTEMPTS,
    ManifestConflictError,
    ManifestEntry,
    S3TrackingManifestStore,
    TrackingManifestError,
)
from tracking.video_master import Video, VideoMasterError  # noqa: E402

AWS_REGION = "ap-northeast-1"
BUCKET = "test-history-bucket"


@pytest.fixture
def table(aws_credentials, monkeypatch):
    # main() reads YOBI_HISTORY_BUCKET; never let a developer shell's value leak into these tests.
    monkeypatch.delenv("YOBI_HISTORY_BUCKET", raising=False)
    with mock_aws():
        client = boto3.client("dynamodb", region_name=AWS_REGION)
        client.create_table(
            TableName=VIDEO_MASTER_TABLE,
            AttributeDefinitions=[{"AttributeName": "videoId", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "videoId", "KeyType": "HASH"}],
            BillingMode="PAY_PER_REQUEST",
        )
        yield boto3.resource("dynamodb", region_name=AWS_REGION).Table(VIDEO_MASTER_TABLE)


def _put(table, video_id, title, **extra):
    table.put_item(Item={"videoId": video_id, "creatorId": "c1", "title": title, "snapshotCount": 4, **extra})


def _topics(table):
    return {item["videoId"]: item.get("topic") for item in table.scan()["Items"]}


def _seed(table):
    _put(table, "v1", "【VALORANT】ランク")
    _put(table, "v2", "マイクラ建築")
    _put(table, "v3", "お知らせ")
    _put(table, "v4", "【VALORANT】already tagged as chatting", topic="chatting")


def test_dry_run_reports_and_writes_nothing(table):
    _seed(table)

    summary = backfill_video_topics.backfill_topics(execute=False, reclassify=False)

    assert _topics(table) == {"v1": None, "v2": None, "v3": None, "v4": "chatting"}
    assert summary["scanned"] == 4
    assert summary["alreadyClassified"] == 1
    assert summary["missingTopic"] == 3
    assert summary["wouldUpdate"] == 3
    assert summary["updated"] == 0
    assert summary["errors"] == 0


def test_execute_classifies_missing_topics_and_skips_valid_existing_ones(table):
    _seed(table)

    summary = backfill_video_topics.backfill_topics(execute=True, reclassify=False)

    assert _topics(table) == {"v1": "valorant", "v2": "minecraft", "v3": "other", "v4": "chatting"}
    assert summary["updated"] == 3
    assert summary["topicCounts"] == {"minecraft": 1, "other": 1, "valorant": 1}
    assert summary["otherCount"] == 1


def test_execute_leaves_every_other_field_untouched(table):
    _put(table, "v1", "【VALORANT】ランク", lastViewCount=99)

    backfill_video_topics.backfill_topics(execute=True, reclassify=False)

    item = table.get_item(Key={"videoId": "v1"})["Item"]
    assert (item["snapshotCount"], item["lastViewCount"], item["creatorId"]) == (4, 99, "c1")


def test_second_execute_run_rewrites_nothing(table):
    _seed(table)
    backfill_video_topics.backfill_topics(execute=True, reclassify=False)

    second = backfill_video_topics.backfill_topics(execute=True, reclassify=False)

    assert (second["alreadyClassified"], second["missingTopic"], second["wouldUpdate"], second["updated"]) == (4, 0, 0, 0)
    assert second["topicCounts"] == {}


def test_malformed_records_are_counted_and_do_not_stop_the_run(table):
    _put(table, "v1", "【VALORANT】ランク")
    table.put_item(Item={"videoId": "no_title", "creatorId": "c1"})
    _put(table, "blank_title", "   ")
    _put(table, "bad_topic", "雑談", topic="not_a_topic")

    summary = backfill_video_topics.backfill_topics(execute=True, reclassify=False)

    assert summary["errors"] == 3
    assert summary["updated"] == 1
    assert _topics(table)["v1"] == "valorant"
    assert _topics(table)["bad_topic"] == "not_a_topic"


def test_reclassify_rewrites_only_topics_that_change(table):
    _put(table, "changes", "【VALORANT】ランク", topic="chatting")
    _put(table, "same", "マイクラ建築", topic="minecraft")
    _put(table, "invalid", "雑談", topic="not_a_topic")

    first = backfill_video_topics.backfill_topics(execute=True, reclassify=True)

    assert _topics(table) == {"changes": "valorant", "same": "minecraft", "invalid": "chatting"}
    assert (first["wouldUpdate"], first["updated"], first["alreadyClassified"], first["errors"]) == (2, 2, 1, 0)

    second = backfill_video_topics.backfill_topics(execute=True, reclassify=True)

    assert (second["wouldUpdate"], second["updated"], second["alreadyClassified"]) == (0, 0, 3)


def test_main_defaults_to_a_dry_run(table, capsys):
    _seed(table)

    assert backfill_video_topics.main([]) == 0

    assert "DRY RUN" in capsys.readouterr().out
    assert _topics(table)["v1"] is None


# --- manifest behavior (patch_shard only, never a full rebuild) ---------------------------------


@pytest.fixture
def env(aws_credentials, monkeypatch):
    """One moto context holding both YobiVideoMaster (DynamoDB) and the manifest bucket (S3)."""
    monkeypatch.delenv("YOBI_HISTORY_BUCKET", raising=False)
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
        s3_client = boto3.client("s3", region_name=AWS_REGION)
        s3_client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": AWS_REGION})
        yield S3TrackingManifestStore(BUCKET, s3_client=s3_client)


def _video(video_id, title, **extra):
    return Video(video_id=video_id, creator_id="c1", title=title, published_at="2026-08-01T00:00:00Z", **extra)


def _seed_manifest(store, entries):
    by_shard = {}
    for entry in entries:
        by_shard.setdefault(shard_for_video(entry.video_id), []).append(entry)
    for shard, shard_entries in by_shard.items():
        store.write_shard(shard, shard_entries)


def _manifest(store):
    return {entry.video_id: entry for shard in range(16) for entry in store.read_shard_for_patch(shard)[0]}


def _vm_topics():
    return _topics(boto3.resource("dynamodb", region_name=AWS_REGION).Table(VIDEO_MASTER_TABLE))


def _full_entry(video_id, **overrides):
    fields = {
        "active": True,
        "discovered_at": "2026-07-01T00:00:00Z",
        "published_at": "2026-06-01T00:00:00Z",
        "activity_state": "Hot",
        "title": "kept title",
        "thumbnail_url": "https://example.test/t.jpg",
        "content_type": "live",
        "live_status": "completed",
    }
    fields.update(overrides)
    return ManifestEntry(video_id, "c1", **fields)


def test_manifest_dry_run_reports_what_would_be_patched_and_writes_nothing(env):
    upsert_videos([_video("v1", "【VALORANT】ランク"), _video("v2", "お知らせ")])
    _seed_manifest(env, [_full_entry("v1"), _full_entry("v2")])
    before = _manifest(env)

    summary = backfill_video_topics.backfill_topics(execute=False, reclassify=False, manifest_store=env)

    assert (summary["scanned"], summary["missingTopic"], summary["wouldUpdate"], summary["updated"]) == (2, 2, 2, 0)
    assert summary["manifestEntriesInspected"] == 2
    assert summary["manifestEntriesMissingTopic"] == 2
    assert summary["manifestEntriesPatchable"] == 2
    assert summary["manifestEntriesPatched"] == 0 and summary["manifestShardsPatched"] == 0
    assert _manifest(env) == before
    assert _vm_topics() == {"v1": None, "v2": None}


def test_execute_patches_only_topic_and_preserves_every_other_manifest_field(env):
    upsert_videos([_video("v1", "【VALORANT】ランク"), _video("v2", "マイクラ建築")])
    original_v1 = _full_entry("v1")
    original_v2 = _full_entry("v2", active=False, activity_state="Cold", content_type="upload", live_status=None)
    _seed_manifest(env, [original_v1, original_v2])

    summary = backfill_video_topics.backfill_topics(execute=True, reclassify=False, manifest_store=env)

    manifest = _manifest(env)
    assert manifest["v1"] == replace(original_v1, topic="valorant")
    assert manifest["v2"] == replace(original_v2, topic="minecraft")  # still inactive, everything else untouched
    assert summary["manifestEntriesPatched"] == 2
    assert (summary["attempted"], summary["updated"], summary["skippedConcurrent"], summary["writeErrors"]) == (2, 2, 0, 0)
    assert summary["manifestEntriesRemainingPatchable"] == 0 and summary["manifestReconciled"] is True
    assert summary["status"] == "COMPLETE"


def test_manifest_only_entries_are_never_dropped_or_given_a_topic(env):
    upsert_videos([_video("v1", "【VALORANT】ランク")])
    ghost = _full_entry("ghost-not-in-video-master")
    _seed_manifest(env, [_full_entry("v1"), ghost])

    summary = backfill_video_topics.backfill_topics(execute=True, reclassify=False, manifest_store=env)

    manifest = _manifest(env)
    assert manifest["ghost-not-in-video-master"] == ghost
    assert manifest["v1"].topic == "valorant"
    assert summary["manifestEntriesStillMissingTopic"] == 1


def test_an_existing_manifest_topic_is_not_overwritten_without_reclassify(env):
    upsert_videos([_video("v1", "【VALORANT】ランク", topic="valorant")])
    _seed_manifest(env, [_full_entry("v1", topic="chatting")])

    backfill_video_topics.backfill_topics(execute=True, reclassify=False, manifest_store=env)

    assert _manifest(env)["v1"].topic == "chatting"


def test_reclassify_aligns_a_differing_manifest_topic_to_video_master(env):
    upsert_videos([_video("v1", "【VALORANT】ランク", topic="chatting")])
    _seed_manifest(env, [_full_entry("v1", topic="chatting")])

    backfill_video_topics.backfill_topics(execute=True, reclassify=True, manifest_store=env)

    assert _manifest(env)["v1"].topic == "valorant"
    assert _vm_topics() == {"v1": "valorant"}


def test_a_shard_with_nothing_to_patch_is_not_written(env, monkeypatch):
    upsert_videos([_video("v1", "【VALORANT】ランク", topic="valorant")])
    _seed_manifest(env, [_full_entry("v1", topic="valorant")])
    writes = _spy_manifest_writes(monkeypatch)

    summary = backfill_video_topics.backfill_topics(execute=True, reclassify=False, manifest_store=env)

    assert summary["manifestShardsPatched"] == 0 and summary["manifestAffectedShards"] == []
    assert writes == []  # no conditional shard write was even attempted (an ETag check can't prove this)
    assert summary["status"] == "COMPLETE"


def test_second_execute_run_patches_nothing(env):
    upsert_videos([_video("v1", "【VALORANT】ランク"), _video("v2", "お知らせ")])
    _seed_manifest(env, [_full_entry("v1"), _full_entry("v2")])
    backfill_video_topics.backfill_topics(execute=True, reclassify=False, manifest_store=env)

    second = backfill_video_topics.backfill_topics(execute=True, reclassify=False, manifest_store=env)

    assert (second["wouldUpdate"], second["updated"]) == (0, 0)
    assert (second["manifestEntriesPatchable"], second["manifestShardsPatched"]) == (0, 0)


def test_rerun_completes_the_manifest_after_an_interrupted_run_that_only_reached_video_master(env):
    upsert_videos([_video("v1", "【VALORANT】ランク")])
    _seed_manifest(env, [_full_entry("v1")])
    backfill_video_topics.backfill_topics(execute=True, reclassify=False, manifest_store=None)  # Video Master only
    assert _manifest(env)["v1"].topic is None

    resumed = backfill_video_topics.backfill_topics(execute=True, reclassify=False, manifest_store=env)

    assert resumed["alreadyClassified"] == 1 and resumed["updated"] == 0
    assert _manifest(env)["v1"].topic == "valorant"  # taken from Video Master's own topic


def test_concurrent_manifest_writer_is_not_lost(env, monkeypatch):
    upsert_videos([_video("v1", "【VALORANT】ランク")])
    _seed_manifest(env, [_full_entry("v1")])
    shard = shard_for_video("v1")
    new_video_id = next(f"new{i}" for i in range(1000) if shard_for_video(f"new{i}") == shard)
    original_write = S3TrackingManifestStore.write_shard_if_version
    writes = {"n": 0}

    def _write_after_an_interloper(self, shard_arg, entries, *, version):
        writes["n"] += 1
        if writes["n"] == 1:
            # A concurrent discovery-style writer commits first, so this backfill's own
            # version is stale and patch_shard must re-read and re-apply, not overwrite.
            current, current_version = self.read_shard_for_patch(shard_arg)
            original_write(self, shard_arg, current + [ManifestEntry(new_video_id, "c1", True)], version=current_version)
        return original_write(self, shard_arg, entries, version=version)

    monkeypatch.setattr(S3TrackingManifestStore, "write_shard_if_version", _write_after_an_interloper)

    backfill_video_topics.backfill_topics(execute=True, reclassify=False, manifest_store=env)

    manifest = _manifest(env)
    assert writes["n"] == 2  # one conflict, one successful retry
    assert manifest["v1"].topic == "valorant"
    assert new_video_id in manifest  # the concurrent writer's new entry survived


def test_main_execute_without_a_manifest_bucket_refuses_before_any_write(env, capsys):
    upsert_videos([_video("v1", "【VALORANT】ランク")])

    assert backfill_video_topics.main(["--execute", "--yes"]) == 2

    assert "YOBI_HISTORY_BUCKET" in capsys.readouterr().out
    assert _vm_topics() == {"v1": None}


def test_main_skip_manifest_backfills_video_master_only(env):
    upsert_videos([_video("v1", "【VALORANT】ランク")])

    assert backfill_video_topics.main(["--execute", "--yes", "--skip-manifest"]) == 0

    assert _vm_topics() == {"v1": "valorant"}


def test_main_execute_with_a_bucket_patches_the_manifest(env, monkeypatch, capsys):
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", BUCKET)
    monkeypatch.setattr(backfill_video_topics, "S3TrackingManifestStore", lambda bucket: env)
    upsert_videos([_video("v1", "【VALORANT】ランク")])
    _seed_manifest(env, [_full_entry("v1")])

    assert backfill_video_topics.main(["--execute", "--yes"]) == 0

    assert _manifest(env)["v1"].topic == "valorant"
    assert "SUCCESSFUL ReduceRankings" in capsys.readouterr().out


# --- safety fixes: preflight, incomplete-work accounting, per-item / per-shard error handling ----


def _spy_manifest_writes(monkeypatch):
    """Record every write_shard_if_version call (still performing it) so a test can prove none happened."""
    calls = []
    original = S3TrackingManifestStore.write_shard_if_version

    def _spy(self, shard, entries, *, version):
        calls.append(shard)
        return original(self, shard, entries, version=version)

    monkeypatch.setattr(S3TrackingManifestStore, "write_shard_if_version", _spy)
    return calls


def _spy_video_master_writes(monkeypatch, *, fail_for=None, reject=None):
    """Record every set_video_topic call; `fail_for` ids raise, `reject` ids return False (mutable sets, so a test can heal them)."""
    calls = []
    fail_for = set() if fail_for is None else fail_for
    reject = set() if reject is None else reject
    original = backfill_video_topics.set_video_topic

    def _spy(video_id, topic, *, overwrite, expected_topic=None):
        calls.append(video_id)
        if video_id in fail_for:
            raise VideoMasterError("simulated DynamoDB failure")
        if video_id in reject:
            return False
        return original(video_id, topic, overwrite=overwrite, expected_topic=expected_topic)

    monkeypatch.setattr(backfill_video_topics, "set_video_topic", _spy)
    return calls


def _ids_in_distinct_shards(count):
    ids, seen, candidate = [], set(), 0
    while len(ids) < count:
        video_id = f"vid{candidate}"
        candidate += 1
        if shard_for_video(video_id) not in seen:
            seen.add(shard_for_video(video_id))
            ids.append(video_id)
    return ids


def _use_store(monkeypatch, store):
    """Make main() build `store` for the configured bucket instead of a real S3TrackingManifestStore."""
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", BUCKET)
    monkeypatch.setattr(backfill_video_topics, "S3TrackingManifestStore", lambda name: store)


def test_preflight_unreadable_bucket_aborts_with_zero_writes(env, monkeypatch, capsys):
    upsert_videos([_video("v1", "【VALORANT】ランク")])
    _seed_manifest(env, [_full_entry("v1")])
    vm_writes = _spy_video_master_writes(monkeypatch)
    manifest_writes = _spy_manifest_writes(monkeypatch)
    _use_store(monkeypatch, S3TrackingManifestStore("no-such-bucket", s3_client=env.s3_client))

    assert backfill_video_topics.main(["--execute", "--yes"]) == 2

    out = capsys.readouterr().out
    assert "Preflight failed" in out and "RESULT: FAILED" in out
    assert vm_writes == [] and manifest_writes == []
    assert _vm_topics() == {"v1": None}


def test_preflight_one_unreadable_shard_aborts_with_zero_writes(env, monkeypatch):
    upsert_videos([_video("v1", "【VALORANT】ランク")])
    _seed_manifest(env, [_full_entry("v1")])
    vm_writes = _spy_video_master_writes(monkeypatch)
    manifest_writes = _spy_manifest_writes(monkeypatch)
    original_read = S3TrackingManifestStore.read_shard_for_patch

    def _read(self, shard):
        if shard == 5:
            raise TrackingManifestError("simulated AccessDenied on one shard")
        return original_read(self, shard)

    monkeypatch.setattr(S3TrackingManifestStore, "read_shard_for_patch", _read)

    summary = backfill_video_topics.backfill_topics(execute=True, reclassify=False, manifest_store=env)

    assert summary["preflightFailed"] is True and summary["status"] == "FAILED"
    assert "shard 05" in summary["abortedReason"]
    assert vm_writes == [] and manifest_writes == []
    assert _vm_topics() == {"v1": None}


def test_preflight_empty_manifest_aborts_with_zero_writes(env, monkeypatch):
    upsert_videos([_video("v1", "【VALORANT】ランク")])  # no manifest shard is written at all
    vm_writes = _spy_video_master_writes(monkeypatch)
    manifest_writes = _spy_manifest_writes(monkeypatch)
    _use_store(monkeypatch, env)

    assert backfill_video_topics.main(["--execute", "--yes"]) == 2

    assert vm_writes == [] and manifest_writes == []
    assert _vm_topics() == {"v1": None}


def test_dry_run_through_main_with_a_bucket_performs_zero_writes(env, monkeypatch, capsys):
    upsert_videos([_video("v1", "【VALORANT】ランク"), _video("v2", "お知らせ")])
    _seed_manifest(env, [_full_entry("v1"), _full_entry("v2")])
    manifest_before = _manifest(env)
    vm_writes = _spy_video_master_writes(monkeypatch)
    manifest_writes = _spy_manifest_writes(monkeypatch)
    _use_store(monkeypatch, env)

    assert backfill_video_topics.main([]) == 0

    out = capsys.readouterr().out
    assert "RESULT: DRY RUN" in out and "manifestEntriesPatchable: 2" in out
    assert vm_writes == [] and manifest_writes == []
    assert _vm_topics() == {"v1": None, "v2": None}
    assert _manifest(env) == manifest_before


def test_a_rejected_conditional_write_is_counted_and_the_run_is_not_reported_complete(env, monkeypatch, capsys):
    upsert_videos([_video("v1", "【VALORANT】ランク"), _video("v2", "マイクラ建築")])
    _seed_manifest(env, [_full_entry("v1"), _full_entry("v2")])
    _spy_video_master_writes(monkeypatch, reject={"v1"})
    _use_store(monkeypatch, env)

    assert backfill_video_topics.main(["--execute", "--yes"]) == 1

    out = capsys.readouterr().out
    assert "attempted: 2" in out and "updated: 1" in out and "skippedConcurrent: 1" in out
    assert "RESULT: PARTIAL" in out
    assert _manifest(env)["v1"].topic is None and _manifest(env)["v2"].topic == "minecraft"


def test_a_video_master_write_failure_is_counted_and_the_summary_is_still_printed(env, monkeypatch, capsys):
    upsert_videos([_video("v1", "【VALORANT】ランク"), _video("v2", "マイクラ建築")])
    _seed_manifest(env, [_full_entry("v1"), _full_entry("v2")])
    failing = {"v1"}
    _spy_video_master_writes(monkeypatch, fail_for=failing)
    _use_store(monkeypatch, env)

    assert backfill_video_topics.main(["--execute", "--yes"]) == 1

    out = capsys.readouterr().out
    assert "writeErrors: 1" in out and "updated: 1" in out and "RESULT: PARTIAL" in out
    assert _vm_topics() == {"v1": None, "v2": "minecraft"}  # the other item and its manifest entry still went through
    assert _manifest(env)["v2"].topic == "minecraft" and _manifest(env)["v1"].topic is None

    failing.clear()  # the transient failure heals; a plain re-run finishes the remaining work

    assert backfill_video_topics.main(["--execute", "--yes"]) == 0
    assert _vm_topics() == {"v1": "valorant", "v2": "minecraft"}
    assert _manifest(env)["v1"].topic == "valorant"


def test_consecutive_write_failures_stop_the_run_as_failed_without_touching_the_manifest(env, monkeypatch, capsys):
    ids = ["v1", "v2", "v3"]
    upsert_videos([_video(video_id, "【VALORANT】ランク") for video_id in ids])
    _seed_manifest(env, [_full_entry(video_id) for video_id in ids])
    monkeypatch.setattr(backfill_video_topics, "MAX_CONSECUTIVE_WRITE_ERRORS", 2)
    vm_writes = _spy_video_master_writes(monkeypatch, fail_for=set(ids))
    manifest_writes = _spy_manifest_writes(monkeypatch)
    _use_store(monkeypatch, env)

    assert backfill_video_topics.main(["--execute", "--yes"]) == 1

    out = capsys.readouterr().out
    assert "RESULT: FAILED" in out and "2 consecutive Video Master write failures" in out
    assert len(vm_writes) == 2  # stopped, not 3
    assert manifest_writes == []


def test_a_failed_video_master_scan_is_reported_as_failed_with_the_summary(env, monkeypatch, capsys):
    def _boom():
        raise VideoMasterError("simulated scan failure")

    monkeypatch.setattr(backfill_video_topics, "scan_video_topic_items", _boom)
    vm_writes = _spy_video_master_writes(monkeypatch)
    _seed_manifest(env, [_full_entry("v1")])
    _use_store(monkeypatch, env)

    assert backfill_video_topics.main([]) == 1

    out = capsys.readouterr().out
    assert "RESULT: FAILED" in out and "Video Master scan failed" in out
    assert vm_writes == []


def test_shard_patch_retry_exhaustion_is_counted_other_shards_complete_and_a_rerun_finishes(env, monkeypatch, capsys):
    id_a, id_b = _ids_in_distinct_shards(2)
    shard_a = shard_for_video(id_a)
    upsert_videos([_video(id_a, "【VALORANT】ランク"), _video(id_b, "マイクラ建築")])
    _seed_manifest(env, [_full_entry(id_a), _full_entry(id_b)])
    original_write = S3TrackingManifestStore.write_shard_if_version
    broken = {"on": True}
    attempts_on_a = []

    def _write(self, shard, entries, *, version):
        if broken["on"] and shard == shard_a:
            attempts_on_a.append(shard)
            raise ManifestConflictError("simulated permanent contention")
        return original_write(self, shard, entries, version=version)

    monkeypatch.setattr(S3TrackingManifestStore, "write_shard_if_version", _write)
    _use_store(monkeypatch, env)

    assert backfill_video_topics.main(["--execute", "--yes"]) == 1

    out = capsys.readouterr().out
    assert "manifestShardErrors: 1" in out and f"manifestFailedShards: [{shard_a}]" in out
    assert "manifestEntriesRemainingPatchable: 1" in out and "RESULT: PARTIAL" in out
    assert len(attempts_on_a) == PATCH_SHARD_MAX_ATTEMPTS  # bounded retries, then it gave up on that shard only
    assert _manifest(env)[id_a].topic is None and _manifest(env)[id_b].topic == "minecraft"
    assert _vm_topics() == {id_a: "valorant", id_b: "minecraft"}  # Video Master is done; only one shard is left

    broken["on"] = False  # contention clears; a plain re-run completes only the remaining work

    assert backfill_video_topics.main(["--execute", "--yes"]) == 0
    assert _manifest(env)[id_a].topic == "valorant" and _manifest(env)[id_b].topic == "minecraft"
    assert "RESULT: COMPLETE" in capsys.readouterr().out


def test_entries_still_patchable_after_execute_are_not_reported_as_success(env, monkeypatch, capsys):
    upsert_videos([_video("v1", "【VALORANT】ランク")])
    _seed_manifest(env, [_full_entry("v1")])
    # A patch that "succeeds" without actually changing the shard: the verification re-read must catch it.
    monkeypatch.setattr(backfill_video_topics, "patch_shard", lambda store, shard, apply: ("key", []))
    _use_store(monkeypatch, env)

    assert backfill_video_topics.main(["--execute", "--yes"]) == 1

    out = capsys.readouterr().out
    assert "manifestEntriesRemainingPatchable: 1" in out and "manifestReconciled: False" in out
    assert "RESULT: PARTIAL" in out


def test_skip_manifest_bypasses_preflight_and_the_manifest_entirely_and_says_so(env, monkeypatch, capsys):
    upsert_videos([_video("v1", "【VALORANT】ランク")])
    _seed_manifest(env, [_full_entry("v1")])
    manifest_before = _manifest(env)
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", BUCKET)

    def _must_not_be_built(name):
        raise AssertionError("--skip-manifest must not construct or read a manifest store")

    monkeypatch.setattr(backfill_video_topics, "S3TrackingManifestStore", _must_not_be_built)

    assert backfill_video_topics.main(["--execute", "--yes", "--skip-manifest"]) == 0

    out = capsys.readouterr().out
    assert "WARNING" in out and "COMPLETE (Video Master only; manifest skipped)" in out
    assert _vm_topics() == {"v1": "valorant"}
    assert _manifest(env) == manifest_before


# --- L1: write targets + explicit --yes confirmation; L2: divergence; stricter reconciliation -----


def _set_fake_secret_sentinels(monkeypatch):
    """Put recognisable fake secrets in the (moto-only) environment so a test can prove they are never printed."""
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "FAKE-SECRET-SENTINEL-9f3a")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "FAKE-TOKEN-SENTINEL-77c1")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "FAKE-KEYID-SENTINEL-42bd")
    return ("FAKE-SECRET-SENTINEL-9f3a", "FAKE-TOKEN-SENTINEL-77c1", "FAKE-KEYID-SENTINEL-42bd")


def test_execute_without_yes_prints_targets_and_performs_zero_writes(env, monkeypatch, capsys):
    secrets = _set_fake_secret_sentinels(monkeypatch)
    upsert_videos([_video("v1", "【VALORANT】ランク")])
    _seed_manifest(env, [_full_entry("v1")])
    manifest_before = _manifest(env)
    vm_writes = _spy_video_master_writes(monkeypatch)
    manifest_writes = _spy_manifest_writes(monkeypatch)
    _use_store(monkeypatch, env)

    assert backfill_video_topics.main(["--execute"]) == 2

    out = capsys.readouterr().out
    assert "Refusing to write without --yes" in out and "nothing was written" in out
    assert f"DynamoDB table : {VIDEO_MASTER_TABLE}" in out and f"Manifest bucket: {BUCKET}" in out
    assert "Mode           : EXECUTE (writes)" in out
    assert not any(secret in out for secret in secrets)
    assert vm_writes == [] and manifest_writes == []
    assert _vm_topics() == {"v1": None} and _manifest(env) == manifest_before


def test_targets_are_printed_with_yes_and_in_a_dry_run_without_leaking_secrets(env, monkeypatch, capsys):
    secrets = _set_fake_secret_sentinels(monkeypatch)
    upsert_videos([_video("v1", "【VALORANT】ランク")])
    _seed_manifest(env, [_full_entry("v1")])
    _use_store(monkeypatch, env)

    assert backfill_video_topics.main([]) == 0  # a dry run needs no --yes
    dry_out = capsys.readouterr().out
    assert f"DynamoDB table : {VIDEO_MASTER_TABLE}" in dry_out and "Mode           : DRY RUN (no writes)" in dry_out

    assert backfill_video_topics.main(["--execute", "--yes"]) == 0
    exec_out = capsys.readouterr().out
    assert f"Manifest bucket: {BUCKET}" in exec_out and "RESULT: COMPLETE" in exec_out
    assert not any(secret in dry_out + exec_out for secret in secrets)


def test_reclassify_execute_requires_yes_and_warns_about_overwriting(env, monkeypatch, capsys):
    upsert_videos([_video("v1", "【VALORANT】ランク", topic="chatting")])
    _seed_manifest(env, [_full_entry("v1", topic="chatting")])
    vm_writes = _spy_video_master_writes(monkeypatch)
    manifest_writes = _spy_manifest_writes(monkeypatch)
    _use_store(monkeypatch, env)

    assert backfill_video_topics.main(["--execute", "--reclassify"]) == 2

    out = capsys.readouterr().out
    assert "--reclassify may OVERWRITE existing topic values" in out and "Refusing to write without --yes" in out
    assert "Mode           : EXECUTE (writes) + RECLASSIFY" in out
    assert vm_writes == [] and manifest_writes == []
    assert _vm_topics() == {"v1": "chatting"} and _manifest(env)["v1"].topic == "chatting"


def test_reclassify_dry_run_needs_no_yes_and_writes_nothing(env, monkeypatch, capsys):
    upsert_videos([_video("v1", "【VALORANT】ランク", topic="chatting")])
    _seed_manifest(env, [_full_entry("v1", topic="chatting")])
    vm_writes = _spy_video_master_writes(monkeypatch)
    _use_store(monkeypatch, env)

    assert backfill_video_topics.main(["--reclassify"]) == 0

    assert "RESULT: DRY RUN" in capsys.readouterr().out
    assert vm_writes == [] and _vm_topics() == {"v1": "chatting"}


def test_skip_manifest_execute_without_yes_still_warns_and_refuses(env, monkeypatch, capsys):
    upsert_videos([_video("v1", "【VALORANT】ランク")])
    vm_writes = _spy_video_master_writes(monkeypatch)

    assert backfill_video_topics.main(["--execute", "--skip-manifest"]) == 2

    out = capsys.readouterr().out
    assert "WARNING: --skip-manifest" in out and "Manifest bucket: skipped (--skip-manifest)" in out
    assert vm_writes == [] and _vm_topics() == {"v1": None}


def test_a_divergent_manifest_topic_is_counted_not_overwritten_and_blocks_a_clean_complete(env, monkeypatch, capsys):
    upsert_videos([_video("v1", "【VALORANT】ランク", topic="valorant"), _video("v2", "マイクラ建築")])
    _seed_manifest(env, [_full_entry("v1", topic="chatting"), _full_entry("v2")])
    _use_store(monkeypatch, env)

    dry = backfill_video_topics.backfill_topics(execute=False, reclassify=False, manifest_store=env)
    assert dry["manifestEntriesDivergent"] == 1 and dry["manifestEntriesPatchable"] == 1  # v2 only

    assert backfill_video_topics.main(["--execute", "--yes"]) == 1

    out = capsys.readouterr().out
    assert "manifestEntriesDivergent: 1" in out and "RESULT: PARTIAL" in out
    manifest = _manifest(env)
    assert manifest["v1"] == _full_entry("v1", topic="chatting")  # the divergent entry is byte-for-byte unchanged
    assert manifest["v2"].topic == "minecraft"  # the missing one was still filled


def test_reclassify_execute_aligns_vm_and_manifest_and_reports_complete(env, monkeypatch, capsys):
    upsert_videos([_video("v1", "【VALORANT】ランク", topic="chatting")])
    _seed_manifest(env, [_full_entry("v1", topic="chatting")])
    _use_store(monkeypatch, env)

    assert backfill_video_topics.main(["--execute", "--yes", "--reclassify"]) == 0

    out = capsys.readouterr().out
    assert "--reclassify may OVERWRITE" in out and "RESULT: COMPLETE" in out
    assert _vm_topics() == {"v1": "valorant"} and _manifest(env)["v1"].topic == "valorant"


def test_reclassify_never_overwrites_a_video_master_topic_changed_after_it_was_read(env, monkeypatch, capsys):
    upsert_videos([_video("v1", "【VALORANT】ランク", topic="chatting")])
    _seed_manifest(env, [_full_entry("v1", topic="chatting")])
    original = backfill_video_topics.set_video_topic
    table = boto3.resource("dynamodb", region_name=AWS_REGION).Table(VIDEO_MASTER_TABLE)

    def _racing(video_id, topic, *, overwrite, expected_topic=None):
        # Another writer changes the topic between this run's scan and its write.
        table.update_item(Key={"videoId": video_id}, UpdateExpression="SET topic = :t", ExpressionAttributeValues={":t": "apex"})
        return original(video_id, topic, overwrite=overwrite, expected_topic=expected_topic)

    monkeypatch.setattr(backfill_video_topics, "set_video_topic", _racing)
    _use_store(monkeypatch, env)

    assert backfill_video_topics.main(["--execute", "--yes", "--reclassify"]) == 1

    out = capsys.readouterr().out
    assert "skippedConcurrent: 1" in out and "RESULT: PARTIAL" in out
    assert _vm_topics() == {"v1": "apex"}  # the newer concurrent value survived


def test_manifest_reconciled_false_is_partial_and_non_zero_even_when_nothing_remains_patchable(env, monkeypatch, capsys):
    upsert_videos([_video("v1", "【VALORANT】ランク")])
    _seed_manifest(env, [_full_entry("v1")])
    original_patch = backfill_video_topics.patch_shard

    def _patch_after_a_concurrent_writer_already_set_it(store, shard, apply):
        # By the time this run's patch reads the shard, someone else already set the topic: this run
        # patches 0 of the 1 planned entries, nothing remains patchable, yet the counts do not reconcile.
        original_patch(store, shard, lambda entries: [replace(entry, topic="valorant") for entry in entries])
        return original_patch(store, shard, apply)

    monkeypatch.setattr(backfill_video_topics, "patch_shard", _patch_after_a_concurrent_writer_already_set_it)
    _use_store(monkeypatch, env)

    assert backfill_video_topics.main(["--execute", "--yes"]) == 1

    out = capsys.readouterr().out
    assert "manifestEntriesRemainingPatchable: 0" in out and "manifestReconciled: False" in out
    assert "RESULT: PARTIAL" in out and "RESULT: COMPLETE" not in out


# --- final hardening: sanitized AWS errors, Ctrl-C, exact flag names, invalid records ---------------

_AWS_IDENTIFIER_SENTINELS = ("123456789012", "SENTINEL-IAM-USER", "SENTINEL-BUCKET-ARN", "SENTINEL-REQUEST-ID")


def _raise_denied(wrapper_cls):
    """Raise wrapper_cls(...) chained from an AccessDenied ClientError whose text carries fake IAM identifiers."""
    try:
        raise ClientError(
            {
                "Error": {
                    "Code": "AccessDenied",
                    "Message": "User: arn:aws:iam::123456789012:user/SENTINEL-IAM-USER is not authorized to perform: "
                    "s3:GetObject on resource: arn:aws:s3:::SENTINEL-BUCKET-ARN/key",
                },
                "ResponseMetadata": {"RequestId": "SENTINEL-REQUEST-ID", "HTTPHeaders": {"x-amz-id-2": "SENTINEL-REQUEST-ID"}},
            },
            "GetObject",
        )
    except ClientError as exc:
        raise wrapper_cls(f"Failed: {exc}") from exc


def _assert_sanitized(out):
    assert "AccessDenied" in out  # the safe AWS error code is still shown
    assert not any(sentinel in out for sentinel in _AWS_IDENTIFIER_SENTINELS)


def test_preflight_failure_output_has_no_aws_identifiers(env, monkeypatch, capsys):
    upsert_videos([_video("v1", "【VALORANT】ランク")])
    _seed_manifest(env, [_full_entry("v1")])
    monkeypatch.setattr(S3TrackingManifestStore, "read_shard_for_patch", lambda self, shard: _raise_denied(TrackingManifestError))
    _use_store(monkeypatch, env)

    assert backfill_video_topics.main(["--execute", "--yes"]) == 2

    _assert_sanitized(capsys.readouterr().out)


def test_video_master_write_failure_output_has_no_aws_identifiers(env, monkeypatch, capsys):
    upsert_videos([_video("v1", "【VALORANT】ランク")])
    _seed_manifest(env, [_full_entry("v1")])

    def _denied(video_id, topic, *, overwrite, expected_topic=None):
        _raise_denied(VideoMasterError)

    monkeypatch.setattr(backfill_video_topics, "set_video_topic", _denied)
    _use_store(monkeypatch, env)

    assert backfill_video_topics.main(["--execute", "--yes"]) == 1

    _assert_sanitized(capsys.readouterr().out)


def test_manifest_shard_patch_failure_output_has_no_aws_identifiers(env, monkeypatch, capsys):
    upsert_videos([_video("v1", "【VALORANT】ランク")])
    _seed_manifest(env, [_full_entry("v1")])
    original_write = S3TrackingManifestStore.write_shard_if_version

    def _denied_write(self, shard, entries, *, version):
        _raise_denied(TrackingManifestError)

    monkeypatch.setattr(S3TrackingManifestStore, "write_shard_if_version", _denied_write)
    _use_store(monkeypatch, env)

    assert backfill_video_topics.main(["--execute", "--yes"]) == 1

    _assert_sanitized(capsys.readouterr().out)
    monkeypatch.setattr(S3TrackingManifestStore, "write_shard_if_version", original_write)


def test_video_master_scan_failure_output_has_no_aws_identifiers(env, monkeypatch, capsys):
    monkeypatch.setattr(backfill_video_topics, "scan_video_topic_items", lambda: _raise_denied(VideoMasterError))

    assert backfill_video_topics.main([]) == 1

    out = capsys.readouterr().out
    _assert_sanitized(out)
    assert "RESULT: FAILED" in out


def test_ctrl_c_during_video_master_writes_prints_the_summary_exits_non_zero_and_a_rerun_resumes(env, monkeypatch, capsys):
    upsert_videos([_video("v1", "【VALORANT】ランク"), _video("v2", "マイクラ建築")])
    _seed_manifest(env, [_full_entry("v1"), _full_entry("v2")])
    original = backfill_video_topics.set_video_topic
    state = {"calls": 0, "interrupt": True}

    def _interrupting(video_id, topic, *, overwrite, expected_topic=None):
        state["calls"] += 1
        if state["interrupt"] and state["calls"] == 2:
            raise KeyboardInterrupt
        return original(video_id, topic, overwrite=overwrite, expected_topic=expected_topic)

    monkeypatch.setattr(backfill_video_topics, "set_video_topic", _interrupting)
    _use_store(monkeypatch, env)

    assert backfill_video_topics.main(["--execute", "--yes"]) == 1

    out = capsys.readouterr().out
    assert "interrupted (Ctrl-C)" in out and "RESULT: FAILED" in out
    assert "updated: 1" in out and "scanned: 2" in out  # the completed progress is preserved in the summary
    assert sum(topic is not None for topic in _vm_topics().values()) == 1
    assert all(entry.topic is None for entry in _manifest(env).values())  # manifest phase did not start

    state["interrupt"] = False  # a plain re-run resumes and finishes everything

    assert backfill_video_topics.main(["--execute", "--yes"]) == 0
    assert _vm_topics() == {"v1": "valorant", "v2": "minecraft"}
    assert {video_id: entry.topic for video_id, entry in _manifest(env).items()} == {"v1": "valorant", "v2": "minecraft"}


def test_ctrl_c_during_manifest_patching_keeps_video_master_progress_and_exits_non_zero(env, monkeypatch, capsys):
    upsert_videos([_video("v1", "【VALORANT】ランク")])
    _seed_manifest(env, [_full_entry("v1")])

    def _interrupt(store, shard, apply):
        raise KeyboardInterrupt

    monkeypatch.setattr(backfill_video_topics, "patch_shard", _interrupt)
    _use_store(monkeypatch, env)

    assert backfill_video_topics.main(["--execute", "--yes"]) == 1

    out = capsys.readouterr().out
    assert "interrupted (Ctrl-C)" in out and "RESULT: FAILED" in out and "updated: 1" in out
    assert _vm_topics() == {"v1": "valorant"}  # Video Master was already done; only the manifest remains


@pytest.mark.parametrize("argv", [["--exec"], ["--execute", "--y"], ["--execute", "--yes", "--skip"], ["--recl"]])
def test_abbreviated_flags_are_rejected_with_zero_writes(env, monkeypatch, argv):
    upsert_videos([_video("v1", "【VALORANT】ランク")])
    _seed_manifest(env, [_full_entry("v1")])
    vm_writes = _spy_video_master_writes(monkeypatch)
    manifest_writes = _spy_manifest_writes(monkeypatch)
    _use_store(monkeypatch, env)

    with pytest.raises(SystemExit) as exc_info:
        backfill_video_topics.main(argv)

    assert exc_info.value.code == 2
    assert vm_writes == [] and manifest_writes == []
    assert _vm_topics() == {"v1": None}


def test_execute_with_invalid_and_malformed_records_is_partial_and_non_zero(env, monkeypatch, capsys):
    upsert_videos([_video("v1", "【VALORANT】ランク")])
    table = boto3.resource("dynamodb", region_name=AWS_REGION).Table(VIDEO_MASTER_TABLE)
    table.put_item(Item={"videoId": "bad_topic", "creatorId": "c1", "title": "雑談", "topic": "not_a_topic"})
    table.put_item(Item={"videoId": "no_title", "creatorId": "c1"})
    _seed_manifest(env, [_full_entry("v1")])
    _use_store(monkeypatch, env)

    assert backfill_video_topics.main(["--execute", "--yes"]) == 1

    out = capsys.readouterr().out
    assert "errors: 2" in out and "RESULT: PARTIAL" in out and "RESULT: COMPLETE" not in out
    topics = _vm_topics()
    assert topics["v1"] == "valorant" and topics["bad_topic"] == "not_a_topic" and topics["no_title"] is None


# --- MV taxonomy rollout: --only-topic, topicTransitions, --report-file -----------------------------------------------


def _seed_mv_rollout(env):
    """Persisted state before the MV rollout: covers stored as `other`, 歌ってみた stored as `singing`."""
    upsert_videos(
        [
            _video("cover", "【Cover】新曲", topic="other"),
            _video("utamita", "【歌ってみた】新曲", topic="singing"),
            _video("original", "Original Song 公開", topic="other"),
            _video("karaoke", "【歌枠】karaoke", topic="singing"),
            _video("falsepos", "空月の歌", topic="other"),
            _video("game", "【VALORANT】ランク", topic="valorant"),
            _video("stale_chat", "【VALORANT】雑談", topic="chatting"),  # an unrelated stale topic: must stay untouched
        ]
    )
    _seed_manifest(
        env,
        [
            _full_entry("cover", topic="other"),
            _full_entry("utamita", topic="singing"),
            _full_entry("original", topic="other"),
            _full_entry("karaoke", topic="singing"),
            _full_entry("falsepos", topic="other"),
            _full_entry("game", topic="valorant"),
            _full_entry("stale_chat", topic="chatting"),
        ]
    )


def test_only_topic_mv_moves_music_works_and_leaves_every_unrelated_record_untouched(env):
    _seed_mv_rollout(env)

    summary = backfill_video_topics.backfill_topics(execute=True, reclassify=True, manifest_store=env, only_topic="mv")

    assert _vm_topics() == {
        "cover": "mv",
        "utamita": "mv",
        "original": "mv",
        "karaoke": "singing",
        "falsepos": "other",
        "game": "valorant",
        "stale_chat": "chatting",
    }
    manifest = _manifest(env)
    assert {video_id: entry.topic for video_id, entry in manifest.items()} == _vm_topics()
    assert summary["topicTransitions"] == {"other->mv": 2, "singing->mv": 1}
    assert (summary["scanned"], summary["updated"], summary["alreadyClassified"], summary["outOfScope"]) == (7, 3, 0, 4)  # 4 = records not involving mv
    assert summary["status"] == "COMPLETE"


def test_only_topic_mv_dry_run_reports_the_transitions_and_writes_nothing(env):
    _seed_mv_rollout(env)
    before_manifest = _manifest(env)
    before_vm = _vm_topics()

    summary = backfill_video_topics.backfill_topics(execute=False, reclassify=True, manifest_store=env, only_topic="mv")

    assert summary["topicTransitions"] == {"other->mv": 2, "singing->mv": 1}
    assert summary["wouldUpdate"] == 3 and summary["updated"] == 0
    assert summary["manifestEntriesPatchable"] == 3
    assert _vm_topics() == before_vm and _manifest(env) == before_manifest


def test_only_topic_mv_second_run_is_a_no_op(env):
    _seed_mv_rollout(env)
    backfill_video_topics.backfill_topics(execute=True, reclassify=True, manifest_store=env, only_topic="mv")
    after_first_vm, after_first_manifest = _vm_topics(), _manifest(env)

    second = backfill_video_topics.backfill_topics(execute=True, reclassify=True, manifest_store=env, only_topic="mv")

    assert second["topicTransitions"] == {} and second["wouldUpdate"] == 0 and second["updated"] == 0
    assert second["manifestEntriesPatchable"] == 0 and second["manifestEntriesPatched"] == 0
    assert _vm_topics() == after_first_vm and _manifest(env) == after_first_manifest


def test_only_topic_never_rewrites_other_fields(env):
    upsert_videos([_video("cover", "【Cover】新曲", topic="other")])
    _seed_manifest(env, [_full_entry("cover", topic="other")])
    before = _manifest(env)["cover"]

    backfill_video_topics.backfill_topics(execute=True, reclassify=True, manifest_store=env, only_topic="mv")

    assert _manifest(env)["cover"] == replace(before, topic="mv")


def test_only_topic_rejects_an_unknown_topic_id():
    with pytest.raises(ValueError):
        backfill_video_topics.backfill_topics(execute=False, reclassify=True, only_topic="not_a_topic")


def test_main_only_topic_requires_reclassify(env, monkeypatch, capsys):
    _use_store(monkeypatch, env)

    assert backfill_video_topics.main(["--only-topic", "mv"]) == 2
    assert "--only-topic only applies together with --reclassify" in capsys.readouterr().out


def test_main_report_file_is_written_outside_the_repo_and_carries_the_transitions(env, monkeypatch, tmp_path, capsys):
    _seed_mv_rollout(env)
    _use_store(monkeypatch, env)
    report = tmp_path / "report.json"

    assert backfill_video_topics.main(["--reclassify", "--only-topic", "mv", "--report-file", str(report)]) == 0

    import json

    written = json.loads(report.read_text(encoding="utf-8"))
    assert written["topicTransitions"] == {"other->mv": 2, "singing->mv": 1}
    assert written["status"] == "DRY RUN" and "DRY RUN" in written["mode"]


def test_main_refuses_a_report_file_inside_the_repository_before_doing_anything(env, monkeypatch, capsys):
    _use_store(monkeypatch, env)
    inside = backfill_video_topics.REPO_ROOT / "mv_backfill_report.json"

    assert backfill_video_topics.main(["--report-file", str(inside)]) == 2

    assert "outside the repository" in capsys.readouterr().out
    assert not inside.exists()
