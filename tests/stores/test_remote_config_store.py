import boto3
import pytest
from moto import mock_aws

from stores.remote_config_store import (
    REMOTE_CONFIG_TABLE,
    RemoteConfigStoreError,
    delete_remote_config,
    get_remote_config,
    list_by_key,
    list_remote_config,
    list_remote_config_by_prefix,
    put_remote_config,
    put_remote_config_if_newer,
    put_remote_config_versioned,
)

AWS_REGION = "ap-northeast-1"




@pytest.fixture
def remote_config_table(aws_credentials):
    """Create the production-shaped Remote Config table inside moto's fully mocked DynamoDB."""
    with mock_aws():
        client = boto3.client("dynamodb", region_name=AWS_REGION)
        client.create_table(
            TableName=REMOTE_CONFIG_TABLE,
            AttributeDefinitions=[
                {"AttributeName": "clientId", "AttributeType": "S"},
                {"AttributeName": "configKey", "AttributeType": "S"},
            ],
            KeySchema=[
                {"AttributeName": "clientId", "KeyType": "HASH"},
                {"AttributeName": "configKey", "KeyType": "RANGE"},
            ],
            GlobalSecondaryIndexes=[
                {
                    "IndexName": "configKey-index",
                    "KeySchema": [{"AttributeName": "configKey", "KeyType": "HASH"}],
                    "Projection": {"ProjectionType": "ALL"},
                }
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        yield


def test_put_then_get_round_trips_a_simple_value(remote_config_table):
    put_remote_config({"clientId": "c1", "key": "enabled", "value": True, "updatedAt": "2026-09-03T00:00:00+00:00"})

    assert get_remote_config("c1", "enabled") == {
        "clientId": "c1",
        "key": "enabled",
        "value": True,
        "updatedAt": "2026-09-03T00:00:00+00:00",
    }


def test_get_returns_none_for_an_unset_key(remote_config_table):
    assert get_remote_config("c1", "no_such_key") is None


def test_put_overwrites_the_previous_value_for_the_same_key(remote_config_table):
    put_remote_config({"clientId": "c1", "key": "notificationLevel", "value": "all", "updatedAt": "2026-09-03T00:00:00+00:00"})
    put_remote_config({"clientId": "c1", "key": "notificationLevel", "value": "important", "updatedAt": "2026-09-03T01:00:00+00:00"})

    record = get_remote_config("c1", "notificationLevel")

    assert record["value"] == "important"
    assert record["updatedAt"] == "2026-09-03T01:00:00+00:00"


def test_nested_floats_round_trip_through_decimal(remote_config_table):
    """`value` is opaque and can be an arbitrarily nested dict/list containing a
    float — DynamoDB requires Decimal internally, but a caller must get back
    the same Python types it wrote, not a Decimal."""
    nested_value = {"threshold": 0.35, "windows": [8.5, 18.25], "creatorOverride": {"aizawa_ema": False}}
    put_remote_config({"clientId": "c1", "key": "prefs", "value": nested_value, "updatedAt": "2026-09-03T00:00:00+00:00"})

    record = get_remote_config("c1", "prefs")

    assert record["value"] == nested_value
    assert isinstance(record["value"]["threshold"], float)
    assert isinstance(record["value"]["windows"][1], float)


def test_a_whole_number_float_reads_back_as_an_int(remote_config_table):
    """DynamoDB's Number type has no int/float distinction — a Decimal with
    no fractional part is indistinguishable from an int that was written
    directly, so a whole-number float (e.g. 18.0) is a known, unavoidable
    lossy edge for this opaque store: it comes back as int 18, not float
    18.0. Documented here rather than silently relied upon."""
    put_remote_config({"clientId": "c1", "key": "prefs", "value": {"hour": 18.0}, "updatedAt": "2026-09-03T00:00:00+00:00"})

    record = get_remote_config("c1", "prefs")

    assert record["value"] == {"hour": 18}


def test_list_remote_config_returns_every_key_for_one_client_only(remote_config_table):
    put_remote_config({"clientId": "c1", "key": "enabled", "value": True, "updatedAt": "2026-09-03T00:00:00+00:00"})
    put_remote_config({"clientId": "c1", "key": "notificationLevel", "value": "all", "updatedAt": "2026-09-03T00:00:00+00:00"})
    put_remote_config({"clientId": "c2", "key": "enabled", "value": False, "updatedAt": "2026-09-03T00:00:00+00:00"})

    records = list_remote_config("c1")

    assert {record["key"] for record in records} == {"enabled", "notificationLevel"}
    assert all(record["clientId"] == "c1" for record in records)


def test_list_remote_config_returns_empty_list_for_a_client_with_no_stored_keys(remote_config_table):
    assert list_remote_config("no_such_client") == []


def test_list_by_key_returns_every_clients_record_for_one_key(remote_config_table):
    put_remote_config({"clientId": "c1", "key": "notificationPreference", "value": {"enabled": True}, "updatedAt": "2026-09-03T00:00:00+00:00"})
    put_remote_config({"clientId": "c2", "key": "notificationPreference", "value": {"enabled": False}, "updatedAt": "2026-09-03T00:00:00+00:00"})
    put_remote_config({"clientId": "c1", "key": "enabled", "value": True, "updatedAt": "2026-09-03T00:00:00+00:00"})

    records = list_by_key("notificationPreference")

    assert {record["clientId"] for record in records} == {"c1", "c2"}
    assert all(record["key"] == "notificationPreference" for record in records)


def test_list_by_key_returns_empty_list_when_no_client_has_that_key(remote_config_table):
    assert list_by_key("no_such_key") == []


def test_list_by_key_never_scans_the_whole_table(remote_config_table, monkeypatch):
    """AWS Cost Recovery: list_by_key must use the configKey-index Query, never a
    table-wide Scan -- the exact O(total clients) failure class this GSI exists
    to remove. Patching Table.scan to raise proves the Query path is what's
    actually exercised, not merely that the result happens to look right."""
    from stores import remote_config_store

    put_remote_config(
        {"clientId": "c1", "key": "notificationPreference", "value": {"enabled": True}, "updatedAt": "2026-09-03T00:00:00+00:00"}
    )

    table = remote_config_store._resource().Table(REMOTE_CONFIG_TABLE)
    monkeypatch.setattr(table, "scan", lambda *a, **k: (_ for _ in ()).throw(AssertionError("list_by_key must not Scan")))

    records = list_by_key("notificationPreference")

    assert {record["clientId"] for record in records} == {"c1"}


def test_delete_remote_config_removes_the_stored_record(remote_config_table):
    put_remote_config({"clientId": "c1", "key": "pushSubscription", "value": {"endpoint": "x"}, "updatedAt": "2026-09-03T00:00:00+00:00"})

    delete_remote_config("c1", "pushSubscription")

    assert get_remote_config("c1", "pushSubscription") is None


def test_delete_remote_config_is_a_no_op_when_nothing_was_stored(remote_config_table):
    delete_remote_config("no_such_client", "no_such_key")

    assert get_remote_config("no_such_client", "no_such_key") is None


def test_delete_remote_config_only_removes_the_named_key(remote_config_table):
    put_remote_config({"clientId": "c1", "key": "pushSubscription", "value": {"endpoint": "x"}, "updatedAt": "2026-09-03T00:00:00+00:00"})
    put_remote_config({"clientId": "c1", "key": "enabled", "value": True, "updatedAt": "2026-09-03T00:00:00+00:00"})

    delete_remote_config("c1", "pushSubscription")

    assert get_remote_config("c1", "enabled") is not None


def test_put_raises_remote_config_store_error_when_table_is_missing(aws_credentials):
    with mock_aws():
        with pytest.raises(RemoteConfigStoreError):
            put_remote_config({"clientId": "c1", "key": "enabled", "value": True, "updatedAt": "2026-09-03T00:00:00+00:00"})


def _record(client_id, key, value, updated_at="2026-09-03T00:00:00+00:00"):
    return {"clientId": client_id, "key": key, "value": value, "updatedAt": updated_at}


def test_list_by_prefix_returns_only_that_clients_matching_keys(remote_config_table):
    put_remote_config(_record("c1", "creatorReminder#ema#all", {"advanceReminder": "30min"}))
    put_remote_config(_record("c1", "creatorReminder#ema#sf6", {"advanceReminder": "10min"}))
    put_remote_config(_record("c1", "streamOverride#v1", {"advanceReminder": "1hour"}))
    put_remote_config(_record("c1", "notificationPreference", {"enabled": True}))
    put_remote_config(_record("c2", "creatorReminder#ema#all", {"advanceReminder": "1min"}))

    records = list_remote_config_by_prefix("c1", "creatorReminder#")

    assert sorted(r["key"] for r in records) == ["creatorReminder#ema#all", "creatorReminder#ema#sf6"]


def test_list_by_prefix_returns_empty_list_when_nothing_matches(remote_config_table):
    assert list_remote_config_by_prefix("c1", "creatorReminder#") == []


def _system_record(key: str, value: dict, client_id: str = "__system__") -> dict:
    """A record as remote_config_api.write_remote_config shapes it."""
    return {"clientId": client_id, "key": key, "value": value, "updatedAt": "2026-10-17T00:00:00+00:00"}


def test_if_newer_writes_when_nothing_is_stored_and_replaces_an_older_revision(remote_config_table):
    """The revision-guarded schedule write: first write lands, a newer revision replaces it."""
    assert put_remote_config_if_newer(_system_record("streamSchedule", {"revision": 100, "n": 1}), revision=100) is True
    assert put_remote_config_if_newer(_system_record("streamSchedule", {"revision": 200, "n": 2}), revision=200) is True

    assert get_remote_config("__system__", "streamSchedule")["value"] == {"revision": 200, "n": 2}


def test_if_newer_refuses_an_older_or_equal_revision_and_leaves_the_stored_value_alone(remote_config_table):
    """An older overlapping run (or a duplicate of the same source) loses the conditional write instead of overwriting newer state."""
    put_remote_config_if_newer(_system_record("streamSchedule", {"revision": 200, "n": 2}), revision=200)

    assert put_remote_config_if_newer(_system_record("streamSchedule", {"revision": 100, "n": 1}), revision=100) is False
    assert put_remote_config_if_newer(_system_record("streamSchedule", {"revision": 200, "n": 3}), revision=200) is False

    assert get_remote_config("__system__", "streamSchedule")["value"] == {"revision": 200, "n": 2}


def test_if_newer_always_replaces_a_record_written_before_revisions_existed(remote_config_table):
    """A stored record with no revision (the record format before this change) is replaced."""
    put_remote_config(_system_record("streamSchedule", {"entries": {}}))

    assert put_remote_config_if_newer(_system_record("streamSchedule", {"revision": 5}), revision=5) is True
    assert get_remote_config("__system__", "streamSchedule")["value"] == {"revision": 5}


def test_versioned_create_succeeds_once_and_fails_if_the_record_exists(remote_config_table):
    """expected_version=None is create-only: of two writers racing to create a ledger exactly one wins."""
    assert put_remote_config_versioned(_system_record("simulNotice#x", {"version": 1}), expected_version=None) is True
    assert put_remote_config_versioned(_system_record("simulNotice#x", {"version": 1, "other": True}), expected_version=None) is False

    assert get_remote_config("__system__", "simulNotice#x")["value"] == {"version": 1}


def test_versioned_update_is_a_compare_and_set_on_the_stored_version(remote_config_table):
    """Only the writer holding the current version can advance it; a stale writer is refused and changes nothing."""
    put_remote_config_versioned(_system_record("simulNotice#x", {"version": 1}), expected_version=None)

    assert put_remote_config_versioned(_system_record("simulNotice#x", {"version": 2, "by": "first"}), expected_version=1) is True
    assert put_remote_config_versioned(_system_record("simulNotice#x", {"version": 2, "by": "second"}), expected_version=1) is False

    assert get_remote_config("__system__", "simulNotice#x")["value"] == {"version": 2, "by": "first"}


def test_versioned_update_of_a_missing_record_is_refused(remote_config_table):
    """A deleted (superseded) ledger is never resurrected by a late writer holding an old version."""
    assert put_remote_config_versioned(_system_record("simulNotice#gone", {"version": 2}), expected_version=1) is False
    assert get_remote_config("__system__", "simulNotice#gone") is None


def test_the_config_key_index_lists_exactly_the_clients_holding_a_reminder_or_opt_in_key(remote_config_table):
    """The sparse per-creator / opt-in lookups the dispatcher relies on: a Query of one configKey returns only the clients that stored it."""
    for client_id in ("c1", "c2", "c3"):
        put_remote_config(_system_record("creatorReminder#aizawa_ema#all", {"notifyAtStart": True, "advanceReminder": None}, client_id))
    put_remote_config(_system_record("creatorReminder#other#all", {"notifyAtStart": True, "advanceReminder": None}, "c4"))
    put_remote_config(_system_record("simultaneousLiveNotice", {"enabled": True}, "c2"))

    assert [r["clientId"] for r in list_by_key("creatorReminder#aizawa_ema#all")] == ["c1", "c2", "c3"]
    assert [r["clientId"] for r in list_by_key("simultaneousLiveNotice")] == ["c2"]
    assert list_by_key("creatorReminder#nobody#all") == []
    assert {"clientId", "key", "value", "updatedAt"} == set(list_by_key("simultaneousLiveNotice")[0])
