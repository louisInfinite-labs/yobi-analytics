"""Real-S3 (moto) tests for stores.subscriber_history_store (ranking-
simplification, subscriber-history foundation, R1) -- mirrors the moto
conventions already established in tests/tracking/test_tracking_manifest_patch.py
for this same repository.
"""

from datetime import date

import boto3
import pytest
from moto import mock_aws

from stores.subscriber_history_store import (
    S3SubscriberHistoryStore,
    SubscriberHistoryStoreError,
    SubscriberRow,
    deserialize_subscriber_rows,
    serialize_subscriber_rows,
    subscriber_history_key,
)

BUCKET = "test-history-bucket"
REGION = "ap-northeast-1"
DAY = date(2026, 9, 29)


@pytest.fixture
def s3_store(aws_credentials):
    with mock_aws():
        client = boto3.client("s3", region_name=REGION)
        client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})
        yield S3SubscriberHistoryStore(BUCKET, s3_client=client)


def _visible_row(creator_id: str, subscriber_count: int, *, observed_at: str = "2026-09-29T18:00:00+09:00") -> SubscriberRow:
    return SubscriberRow(
        creator_id=creator_id, subscriber_count=subscriber_count, hidden_subscriber_count=False, observed_at=observed_at
    )


def _hidden_row(creator_id: str, *, observed_at: str = "2026-09-29T18:00:00+09:00") -> SubscriberRow:
    return SubscriberRow(creator_id=creator_id, subscriber_count=None, hidden_subscriber_count=True, observed_at=observed_at)


# --- key shape (no sharding) -------------------------------------------------


def test_subscriber_history_key_has_no_shard_segment():
    """One object per day for the whole roster -- unlike daily_history_key,
    there is no shard=NN segment at all."""
    assert subscriber_history_key(DAY) == "subscriber-history/date=2026-09-29.parquet"


# --- serialize/deserialize roundtrip -----------------------------------------


def test_serialize_deserialize_roundtrip_preserves_visible_and_hidden_rows():
    rows = [_visible_row("creator_a", 500_000), _hidden_row("creator_b")]

    roundtripped = deserialize_subscriber_rows(serialize_subscriber_rows(rows))

    assert sorted(roundtripped, key=lambda row: row.creator_id) == sorted(rows, key=lambda row: row.creator_id)


def test_deserialize_rejects_duplicate_creator_ids():
    """Two rows for the same creator in one day's snapshot is a corrupt
    snapshot, not two legitimate observations."""
    rows = [_visible_row("dup", 1), _visible_row("dup", 2)]
    payload = _force_serialize_bypassing_validation(rows)

    with pytest.raises(SubscriberHistoryStoreError, match="duplicate"):
        deserialize_subscriber_rows(payload)


def _force_serialize_bypassing_validation(rows: list[SubscriberRow]) -> bytes:
    """serialize_subscriber_rows itself validates (and would reject a
    legitimately-shaped duplicate no differently than deserialize does) --
    this constructs the same Parquet bytes serialize_subscriber_rows would,
    without going through its own row-level validation, so the duplicate
    check under test is deserialize_subscriber_rows' own, not an earlier one."""
    import io

    import pyarrow as pa
    import pyarrow.parquet as parquet

    table = pa.table(
        {
            "creatorId": pa.array([row.creator_id for row in rows], type=pa.string()),
            "subscriberCount": pa.array([row.subscriber_count for row in rows], type=pa.int64()),
            "hiddenSubscriberCount": pa.array([row.hidden_subscriber_count for row in rows], type=pa.bool_()),
            "observedAt": pa.array([row.observed_at for row in rows], type=pa.string()),
        }
    )
    output = io.BytesIO()
    parquet.write_table(table, output, compression="snappy")
    return output.getvalue()


# --- row validation -----------------------------------------------------------


def test_hidden_row_must_not_carry_a_subscriber_count():
    bad_row = SubscriberRow(creator_id="c1", subscriber_count=0, hidden_subscriber_count=True, observed_at="2026-09-29T18:00:00+09:00")

    with pytest.raises(SubscriberHistoryStoreError, match="hidden"):
        serialize_subscriber_rows([bad_row])


def test_non_hidden_row_must_carry_a_real_subscriber_count():
    bad_row = SubscriberRow(creator_id="c1", subscriber_count=None, hidden_subscriber_count=False, observed_at="2026-09-29T18:00:00+09:00")

    with pytest.raises(SubscriberHistoryStoreError, match="not marked hidden"):
        serialize_subscriber_rows([bad_row])


def test_negative_subscriber_count_is_rejected():
    bad_row = _visible_row("c1", -5)

    with pytest.raises(SubscriberHistoryStoreError, match="invalid subscriber_count"):
        serialize_subscriber_rows([bad_row])


def test_empty_creator_id_is_rejected():
    bad_row = _visible_row("", 5)

    with pytest.raises(SubscriberHistoryStoreError, match="empty required field"):
        serialize_subscriber_rows([bad_row])


# --- S3 store, real moto S3 ---------------------------------------------------


def test_read_daily_snapshot_returns_empty_list_when_absent(s3_store):
    assert s3_store.read_daily_snapshot(DAY) == []


def test_snapshot_exists_is_false_before_any_write(s3_store):
    assert s3_store.snapshot_exists(DAY) is False


def test_write_then_read_roundtrips_visible_and_hidden_rows(s3_store):
    rows = [_visible_row("creator_a", 2_000_000), _visible_row("creator_b", 900_000), _hidden_row("creator_c")]

    key = s3_store.write_daily_snapshot(DAY, rows)

    assert key == "subscriber-history/date=2026-09-29.parquet"
    assert s3_store.snapshot_exists(DAY) is True
    read_back = s3_store.read_daily_snapshot(DAY)
    assert sorted(read_back, key=lambda row: row.creator_id) == sorted(rows, key=lambda row: row.creator_id)


def test_write_is_idempotent_a_retry_overwrites_not_appends(s3_store):
    s3_store.write_daily_snapshot(DAY, [_visible_row("creator_a", 1)])
    s3_store.write_daily_snapshot(DAY, [_visible_row("creator_a", 2)])

    read_back = s3_store.read_daily_snapshot(DAY)

    assert len(read_back) == 1
    assert read_back[0].subscriber_count == 2


def test_write_rejects_duplicate_creator_ids_in_the_same_snapshot(s3_store):
    with pytest.raises(SubscriberHistoryStoreError, match="duplicate"):
        s3_store.write_daily_snapshot(DAY, [_visible_row("dup", 1), _visible_row("dup", 2)])


def test_two_different_days_are_independent_objects(s3_store):
    other_day = date(2026, 9, 28)
    s3_store.write_daily_snapshot(DAY, [_visible_row("creator_a", 100)])
    s3_store.write_daily_snapshot(other_day, [_visible_row("creator_a", 90)])

    assert s3_store.read_daily_snapshot(DAY)[0].subscriber_count == 100
    assert s3_store.read_daily_snapshot(other_day)[0].subscriber_count == 90


def test_from_environment_requires_the_history_bucket_env_var(monkeypatch):
    monkeypatch.delenv("YOBI_HISTORY_BUCKET", raising=False)

    with pytest.raises(SubscriberHistoryStoreError, match="YOBI_HISTORY_BUCKET"):
        S3SubscriberHistoryStore.from_environment()
