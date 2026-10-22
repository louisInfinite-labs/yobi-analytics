"""The Collector's record of which upcoming videos it already decided about (stores/premiere_announcements_store.py), on moto's mocked DynamoDB."""

from datetime import datetime, timezone

import boto3
import pytest
from moto import mock_aws

from stores import premiere_announcements_store as store
from stores.remote_config_store import REMOTE_CONFIG_TABLE, RemoteConfigStoreError, get_remote_config, put_remote_config

AWS_REGION = "ap-northeast-1"
NOW = datetime(2026, 10, 22, 9, 0, tzinfo=timezone.utc)


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


def test_nothing_recorded_reads_as_no_decisions_and_recording_nothing_writes_nothing(remote_config_table):
    """No record yet: an empty map, and an empty batch costs no write."""
    assert store.read_decisions() == {}
    assert store.record_decisions({}, now=NOW) == 0
    assert get_remote_config(store.SYSTEM_CLIENT_ID, store.PREMIERE_ANNOUNCEMENTS_KEY) is None


def test_decisions_are_read_back_per_video_with_the_announced_ones_listed(remote_config_table):
    """A Premiere decision and an ordinary-livestream decision live side by side; only the Premiere is an announced id."""
    assert store.record_decisions({"Kd0nT-tybTA": True, "LIVE0000001": False}, now=NOW) == 2

    decisions = store.read_decisions()

    assert decisions == {
        "Kd0nT-tybTA": {"premiere": True, "at": NOW.isoformat()},
        "LIVE0000001": {"premiere": False, "at": NOW.isoformat()},
    }
    assert store.announced_video_ids(decisions) == {"Kd0nT-tybTA"}


def test_the_first_decision_wins_and_a_repeat_writes_nothing(remote_config_table):
    """A decision is never overwritten, and a batch with nothing new leaves the stored record byte-for-byte as it was."""
    store.record_decisions({"p1": True}, now=NOW)
    before = get_remote_config(store.SYSTEM_CLIENT_ID, store.PREMIERE_ANNOUNCEMENTS_KEY)

    assert store.record_decisions({"p1": False}, now=datetime(2026, 10, 23, tzinfo=timezone.utc)) == 0

    assert store.read_decisions()["p1"]["premiere"] is True
    assert get_remote_config(store.SYSTEM_CLIENT_ID, store.PREMIERE_ANNOUNCEMENTS_KEY) == before


def test_new_decisions_join_the_existing_ones_in_one_write(remote_config_table):
    """Existing entries are kept and only the new ids are added."""
    store.record_decisions({"p1": True}, now=NOW)

    assert store.record_decisions({"p1": True, "p2": False, "p3": True}, now=NOW) == 2

    assert set(store.read_decisions()) == {"p1", "p2", "p3"}


def test_a_damaged_entry_is_dropped_and_the_rest_is_served(remote_config_table):
    """A malformed decision never breaks the record: it is ignored on read, the good ones are served."""
    put_remote_config(
        {
            "clientId": store.SYSTEM_CLIENT_ID,
            "key": store.PREMIERE_ANNOUNCEMENTS_KEY,
            "value": {"decisions": {"ok": {"premiere": True, "at": NOW.isoformat()}, "bad_flag": {"premiere": "yes", "at": NOW.isoformat()}, "bad_time": {"premiere": True, "at": "yesterday"}}},
            "updatedAt": NOW.isoformat(),
        }
    )

    assert set(store.read_decisions()) == {"ok"}


def test_the_record_is_bounded_and_drops_the_oldest_decisions_first(remote_config_table, monkeypatch):
    """Beyond MAX_ENTRIES the oldest decisions are dropped, the newest are kept."""
    monkeypatch.setattr(store, "MAX_ENTRIES", 3)
    for day, video_id in enumerate(["v1", "v2", "v3"], start=1):
        store.record_decisions({video_id: True}, now=datetime(2026, 10, day, tzinfo=timezone.utc))

    store.record_decisions({"v4": True}, now=datetime(2026, 10, 4, tzinfo=timezone.utc))

    assert set(store.read_decisions()) == {"v2", "v3", "v4"}


def _rival_record(version: int | None, video_id: str) -> dict:
    """What a concurrent Collector run would write at the same moment: one different decision, the next version."""
    return {
        "clientId": store.SYSTEM_CLIENT_ID,
        "key": store.PREMIERE_ANNOUNCEMENTS_KEY,
        "value": {"version": (version or 0) + 1, "decisions": {video_id: {"premiere": True, "at": NOW.isoformat()}}},
        "updatedAt": NOW.isoformat(),
    }


def test_a_concurrent_writer_between_read_and_write_loses_nothing(remote_config_table, monkeypatch):
    """Two overlapping runs: the first to write wins the compare-and-set; the other re-reads, merges and retries, so both runs' decisions end up stored."""
    original = store.put_remote_config_versioned
    state = {"rival_done": False}

    def racing(record, *, expected_version):
        """The rival run's write lands first, then this run's own write is attempted against the moved version."""
        if not state["rival_done"]:
            state["rival_done"] = True
            assert original(_rival_record(expected_version, "RIVAL000001"), expected_version=expected_version)
        return original(record, expected_version=expected_version)

    monkeypatch.setattr(store, "put_remote_config_versioned", racing)

    assert store.record_decisions({"OURS0000001": True}, now=NOW) == 1

    assert set(store.read_decisions()) == {"RIVAL000001", "OURS0000001"}


def test_an_id_a_concurrent_writer_already_decided_is_not_decided_twice(remote_config_table, monkeypatch):
    """If the rival run recorded the very same id meanwhile, the retry finds nothing new to write and keeps the rival's decision."""
    original = store.put_remote_config_versioned
    state = {"rival_done": False}

    def racing(record, *, expected_version):
        """The rival run decides the same video first."""
        if not state["rival_done"]:
            state["rival_done"] = True
            assert original(_rival_record(expected_version, "SAME0000001"), expected_version=expected_version)
        return original(record, expected_version=expected_version)

    monkeypatch.setattr(store, "put_remote_config_versioned", racing)

    assert store.record_decisions({"SAME0000001": False}, now=NOW) == 0

    assert store.read_decisions()["SAME0000001"]["premiere"] is True  # first decision wins


def test_a_write_that_keeps_losing_raises_and_stores_nothing_of_its_own(remote_config_table, monkeypatch):
    """After MAX_WRITE_ATTEMPTS lost races the call raises (the Collector step then warns and the ids stay undecided) instead of overwriting."""
    monkeypatch.setattr(store, "put_remote_config_versioned", lambda record, *, expected_version: False)

    with pytest.raises(RemoteConfigStoreError):
        store.record_decisions({"p1": True}, now=NOW)

    assert store.read_decisions() == {}


def _dynamodb_item_size_bytes(value) -> int:
    """A conservative estimate of DynamoDB's item size for a JSON-like value: UTF-8 bytes of every name and string, 1 byte per boolean, up to 21 bytes per number,
    plus the documented 3 bytes of container overhead and 1 byte per element."""
    if isinstance(value, bool):
        return 1
    if isinstance(value, (int, float)):
        return 21
    if isinstance(value, str):
        return len(value.encode("utf-8"))
    if isinstance(value, dict):
        return 3 + sum(len(str(name).encode("utf-8")) + _dynamodb_item_size_bytes(child) + 1 for name, child in value.items())
    return 3 + sum(_dynamodb_item_size_bytes(child) + 1 for child in value)


def test_a_full_record_stays_far_below_the_dynamodb_item_limit(remote_config_table):
    """1,000 decisions with the longest possible timestamps (microseconds and an offset) are written as ONE item well under the 400 KB limit."""
    long_time = datetime(2026, 10, 22, 20, 0, 0, 123456, tzinfo=timezone.utc).isoformat()
    decisions = {f"{n:011d}": {"premiere": bool(n % 2), "at": long_time} for n in range(store.MAX_ENTRIES)}
    put_remote_config(
        {"clientId": store.SYSTEM_CLIENT_ID, "key": store.PREMIERE_ANNOUNCEMENTS_KEY, "value": {"version": 1, "decisions": decisions}, "updatedAt": long_time}
    )

    record = get_remote_config(store.SYSTEM_CLIENT_ID, store.PREMIERE_ANNOUNCEMENTS_KEY)

    assert len(store.read_decisions()) == store.MAX_ENTRIES
    assert _dynamodb_item_size_bytes(record["value"]) < 150 * 1024  # a 400 KB item limit leaves well over 2x headroom even with this conservative estimate


def test_an_overfull_record_is_cut_back_to_the_limit_on_the_next_write(remote_config_table, monkeypatch):
    """Writing past MAX_ENTRIES never grows the stored record beyond it, and the newest decisions are the ones kept."""
    monkeypatch.setattr(store, "MAX_ENTRIES", 5)
    for day in range(1, 9):
        store.record_decisions({f"v{day}": True}, now=datetime(2026, 10, day, tzinfo=timezone.utc))

    assert set(store.read_decisions()) == {"v4", "v5", "v6", "v7", "v8"}
