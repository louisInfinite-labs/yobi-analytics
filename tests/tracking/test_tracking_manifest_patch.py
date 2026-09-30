"""Real-S3 (moto) tests for the optimistic-concurrency manifest-patch primitives
added in AWS Cost Recovery's third pass: read_shard_for_patch/
write_shard_if_version/patch_shard. These specifically exercise real S3
If-Match/If-None-Match conditional-write semantics -- not just a Python-level
fake -- since the whole point of this mechanism is that it behaves correctly
against the real AWS feature it depends on, with no new AWS infrastructure
(no DynamoDB Streams, no new Lambda, no lock table).
"""

import boto3
import pytest
from moto import mock_aws

from stores.history_store import shard_for_video
from tracking.tracking_manifest import (
    ManifestConflictError,
    ManifestEntry,
    PATCH_SHARD_MAX_ATTEMPTS,
    S3TrackingManifestStore,
    patch_shard,
)

BUCKET = "test-history-bucket"
REGION = "ap-northeast-1"
SHARD = 0


def _ids_for_shard(shard: int, count: int) -> list[str]:
    """Deterministically find `count` distinct video ids that actually hash to
    `shard` -- every write_shard_if_version call rejects an entry whose own
    shard_for_video doesn't match the shard it's being written to, so a test
    can't just use "v1"/"v2"/... directly without risking a mismatch."""
    ids = []
    candidate = 0
    while len(ids) < count:
        video_id = f"video-{candidate:06d}"
        if shard_for_video(video_id) == shard:
            ids.append(video_id)
        candidate += 1
    return ids


V1, V2, V3, V_CONCURRENT = _ids_for_shard(SHARD, 4)


@pytest.fixture
def s3_store(aws_credentials):
    with mock_aws():
        client = boto3.client("s3", region_name=REGION)
        client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})
        yield S3TrackingManifestStore(BUCKET, s3_client=client)


def _entry(video_id: str, **overrides) -> ManifestEntry:
    fields = {"video_id": video_id, "creator_id": "c1", "active": True}
    fields.update(overrides)
    return ManifestEntry(**fields)


def test_read_shard_for_patch_returns_empty_entries_and_none_version_for_a_missing_shard(s3_store):
    entries, version = s3_store.read_shard_for_patch(SHARD)

    assert entries == []
    assert version is None


def test_write_shard_if_version_none_creates_a_brand_new_shard(s3_store):
    shard = SHARD
    entries = [_entry(V1)]

    key = s3_store.write_shard_if_version(shard, entries, version=None)

    assert s3_store.read_shard(shard) == entries
    assert key.endswith(f"shard={SHARD:02d}.parquet")


def test_write_shard_if_version_none_conflicts_when_the_shard_already_exists(s3_store):
    shard = SHARD
    s3_store.write_shard_if_version(shard, [_entry(V1)], version=None)

    with pytest.raises(ManifestConflictError):
        s3_store.write_shard_if_version(shard, [_entry(V2)], version=None)


def test_write_shard_if_version_succeeds_when_version_matches_current_state(s3_store):
    shard = SHARD
    s3_store.write_shard_if_version(shard, [_entry(V1)], version=None)
    entries, version = s3_store.read_shard_for_patch(shard)

    s3_store.write_shard_if_version(shard, entries + [_entry(V2)], version=version)

    assert {entry.video_id for entry in s3_store.read_shard(shard)} == {V1, V2}


def test_write_shard_if_version_conflicts_when_another_writer_already_moved_the_shard(s3_store):
    """The core race this whole mechanism exists to close: two independent
    daily writers (discovery adding a new video, history_worker patching
    activity_state) both read the same shard, then both try to write it back
    -- the second writer's own stale version must be rejected, never silently
    overwrite the first writer's already-persisted change."""
    shard = SHARD
    s3_store.write_shard_if_version(shard, [_entry(V1)], version=None)
    entries_a, version_a = s3_store.read_shard_for_patch(shard)
    entries_b, version_b = s3_store.read_shard_for_patch(shard)
    assert version_a == version_b  # both readers saw the same starting state

    # Writer A applies its own change and wins the race.
    s3_store.write_shard_if_version(shard, entries_a + [_entry(V2)], version=version_a)

    # Writer B's write is still against the now-stale version it read earlier.
    with pytest.raises(ManifestConflictError):
        s3_store.write_shard_if_version(shard, entries_b + [_entry(V3)], version=version_b)

    # Writer A's change survived; writer B's was rejected, not silently lost
    # or silently applied on top without B ever knowing.
    assert {entry.video_id for entry in s3_store.read_shard(shard)} == {V1, V2}


def test_patch_shard_creates_a_shard_that_does_not_exist_yet(s3_store):
    key, new_entries = patch_shard(s3_store, SHARD, lambda entries: entries + [_entry(V1)])

    assert {entry.video_id for entry in new_entries} == {V1}
    assert {entry.video_id for entry in s3_store.read_shard(SHARD)} == {V1}


def test_patch_shard_is_a_pure_read_modify_write_when_uncontended(s3_store):
    s3_store.write_shard_if_version(SHARD, [_entry(V1)], version=None)

    patch_shard(s3_store, SHARD, lambda entries: entries + [_entry(V2)])

    assert {entry.video_id for entry in s3_store.read_shard(SHARD)} == {V1, V2}


def test_patch_shard_converges_after_a_real_concurrent_writer_wins_first(s3_store):
    """Simulates the exact race patch_shard exists to survive: a concurrent
    writer commits its own change *between* this call's own read and write.
    patch_shard must detect the conflict, re-read the now-current state, and
    re-apply its own patch on top of it -- never lose either side's change."""
    shard = SHARD
    s3_store.write_shard_if_version(shard, [_entry(V1)], version=None)

    real_write = s3_store.write_shard_if_version
    call_count = {"n": 0}

    def _write_with_interloper(shard_arg, entries, *, version):
        call_count["n"] += 1
        if call_count["n"] == 1:
            # A concurrent writer sneaks in and commits first, invalidating
            # the version this call is about to write with.
            current_entries, current_version = s3_store.read_shard_for_patch(shard_arg)
            real_write(shard_arg, current_entries + [_entry(V_CONCURRENT)], version=current_version)
        return real_write(shard_arg, entries, version=version)

    s3_store.write_shard_if_version = _write_with_interloper

    key, new_entries = patch_shard(s3_store, shard, lambda entries: entries + [_entry(V2)])

    final_ids = {entry.video_id for entry in s3_store.read_shard(shard)}
    assert final_ids == {V1, V2, V_CONCURRENT}
    assert call_count["n"] == 2  # exactly one conflict, then one successful retry


def test_patch_shard_gives_up_after_max_attempts_against_a_permanently_contended_shard(s3_store):
    """A pathological case (something keeps rewriting this shard on every single
    attempt) must not retry forever -- it must eventually surface the real
    ManifestConflictError so a caller (or its own best-effort wrapper) can log
    it instead of hanging."""
    shard = SHARD
    s3_store.write_shard_if_version(shard, [_entry(V1)], version=None)

    real_write = s3_store.write_shard_if_version
    interloper_ids = _ids_for_shard(shard, PATCH_SHARD_MAX_ATTEMPTS + 2)[1:]  # avoid colliding with V1

    def _always_contended(shard_arg, entries, *, version):
        # A distinct interloper id every single call: this must keep
        # invalidating *every* attempt patch_shard makes, not just the first
        # -- a duplicate id on a retried read would itself raise a different,
        # unrelated TrackingManifestError, masking the one this test wants.
        current_entries, current_version = s3_store.read_shard_for_patch(shard_arg)
        interloper_id = interloper_ids.pop(0)
        real_write(shard_arg, current_entries + [_entry(interloper_id)], version=current_version)
        return real_write(shard_arg, entries, version=version)

    s3_store.write_shard_if_version = _always_contended

    with pytest.raises(ManifestConflictError):
        patch_shard(s3_store, shard, lambda entries: entries + [_entry(V2)])


def test_patch_shard_max_attempts_is_a_small_bounded_constant():
    """Documents the bound itself: this must be small (a genuine conflict should
    resolve within a couple of retries), never large enough to look like an
    unbounded/infinite retry loop in practice."""
    assert 2 <= PATCH_SHARD_MAX_ATTEMPTS <= 10
