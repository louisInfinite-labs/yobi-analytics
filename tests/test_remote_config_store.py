import boto3
import pytest
from moto import mock_aws

from remote_config_store import (
    REMOTE_CONFIG_TABLE,
    RemoteConfigStoreError,
    delete_remote_config,
    get_remote_config,
    list_by_key,
    list_remote_config,
    put_remote_config,
)

AWS_REGION = "ap-northeast-1"


@pytest.fixture(autouse=True)
def aws_credentials(monkeypatch):
    """moto still requires boto3 to resolve *some* credentials; these never reach real AWS."""
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_SECURITY_TOKEN", "testing")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", AWS_REGION)


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
