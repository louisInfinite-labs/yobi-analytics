"""The durable record of completed Premieres' archive-availability times (stores/premiere_archive_times_store.py), on moto's mocked DynamoDB."""

from datetime import datetime, timezone

import boto3
import pytest
from moto import mock_aws

from stores import premiere_archive_times_store as store
from stores.remote_config_store import REMOTE_CONFIG_TABLE, get_remote_config

AWS_REGION = "ap-northeast-1"
NOW = datetime(2026, 10, 22, 11, 0, tzinfo=timezone.utc)


@pytest.fixture
def remote_config_table(aws_credentials):
    """The production-shaped Remote Config table inside moto's fully mocked DynamoDB."""
    with mock_aws():
        client = boto3.client("dynamodb", region_name=AWS_REGION)
        client.create_table(
            TableName=REMOTE_CONFIG_TABLE,
            AttributeDefinitions=[{"AttributeName": "clientId", "AttributeType": "S"}, {"AttributeName": "configKey", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "clientId", "KeyType": "HASH"}, {"AttributeName": "configKey", "KeyType": "RANGE"}],
            GlobalSecondaryIndexes=[{"IndexName": "configKey-index", "KeySchema": [{"AttributeName": "configKey", "KeyType": "HASH"}], "Projection": {"ProjectionType": "ALL"}}],
            BillingMode="PAY_PER_REQUEST",
        )
        yield


def test_nothing_recorded_reads_as_an_empty_map(remote_config_table):
    """No record yet: an empty map, and recording nothing writes nothing."""
    assert store.read_premiere_archive_times() == {}
    assert store.record_premiere_archive_times({}, now=NOW) == 0
    assert get_remote_config(store.SYSTEM_CLIENT_ID, store.PREMIERE_ARCHIVE_TIMES_KEY) is None


def test_a_recorded_time_is_read_back_under_the_canonical_video_id(remote_config_table):
    """The record is a read model keyed by the exact videoId: one entry per video, the lifecycle's own timestamp copied as it is."""
    assert store.record_premiere_archive_times({"PREMIERE001": "2026-10-22T11:00:00+00:00"}, now=NOW) == 1

    assert store.read_premiere_archive_times() == {"PREMIERE001": "2026-10-22T11:00:00+00:00"}


def test_the_first_recorded_time_wins_and_a_repeat_writes_nothing(remote_config_table):
    """A confirmation is idempotent: a later cycle (or a retry) never moves an earlier time and costs no write."""
    store.record_premiere_archive_times({"p1": "2026-10-22T11:00:00+00:00"}, now=NOW)
    before = get_remote_config(store.SYSTEM_CLIENT_ID, store.PREMIERE_ARCHIVE_TIMES_KEY)

    assert store.record_premiere_archive_times({"p1": "2026-10-23T09:00:00+00:00"}, now=NOW) == 0

    assert store.read_premiere_archive_times()["p1"] == "2026-10-22T11:00:00+00:00"
    assert get_remote_config(store.SYSTEM_CLIENT_ID, store.PREMIERE_ARCHIVE_TIMES_KEY) == before  # not rewritten


def test_several_new_times_are_added_in_one_write_next_to_the_existing_ones(remote_config_table):
    """Existing entries are kept and the new ones join them."""
    store.record_premiere_archive_times({"p1": "2026-10-22T11:00:00+00:00"}, now=NOW)

    assert store.record_premiere_archive_times({"p1": "2026-10-22T12:00:00+00:00", "p2": "2026-10-22T12:00:00+00:00", "p3": "2026-10-22T13:00:00+00:00"}, now=NOW) == 2

    assert store.read_premiere_archive_times() == {"p1": "2026-10-22T11:00:00+00:00", "p2": "2026-10-22T12:00:00+00:00", "p3": "2026-10-22T13:00:00+00:00"}


def test_an_unusable_time_is_ignored_never_repaired_or_invented(remote_config_table):
    """Only ISO-8601 timestamps with a UTC offset are kept; nothing is defaulted from the current time."""
    assert store.record_premiere_archive_times({"a": "not a time", "b": "2026-10-22T11:00:00", "c": "", "d": None}, now=NOW) == 0  # type: ignore[dict-item]

    assert store.read_premiere_archive_times() == {}


def test_a_record_with_a_bad_entry_still_serves_the_good_ones(remote_config_table):
    """A damaged entry is dropped on read; the rest of the record is still served."""
    from stores.remote_config_store import put_remote_config

    put_remote_config(
        {"clientId": store.SYSTEM_CLIENT_ID, "key": store.PREMIERE_ARCHIVE_TIMES_KEY, "value": {"times": {"ok": "2026-10-22T11:00:00+00:00", "bad": "yesterday"}}, "updatedAt": NOW.isoformat()}
    )

    assert store.read_premiere_archive_times() == {"ok": "2026-10-22T11:00:00+00:00"}


def test_the_record_is_bounded_and_drops_the_oldest_times_first(remote_config_table, monkeypatch):
    """Beyond MAX_ENTRIES the oldest availability times are dropped, the newest are kept."""
    monkeypatch.setattr(store, "MAX_ENTRIES", 3)
    store.record_premiere_archive_times({"v1": "2026-10-01T00:00:00+00:00", "v2": "2026-10-02T00:00:00+00:00", "v3": "2026-10-03T00:00:00+00:00"}, now=NOW)

    store.record_premiere_archive_times({"v4": "2026-10-04T00:00:00+00:00"}, now=NOW)

    assert set(store.read_premiere_archive_times()) == {"v2", "v3", "v4"}
