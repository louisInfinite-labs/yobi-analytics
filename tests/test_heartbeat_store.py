import boto3
import pytest
from moto import mock_aws

from heartbeat_store import HEARTBEAT_TABLE, HeartbeatStoreError, get_heartbeat, list_all, put_heartbeat

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
def heartbeat_table(aws_credentials):
    """Create the production-shaped Heartbeat table inside moto's fully mocked DynamoDB."""
    with mock_aws():
        client = boto3.client("dynamodb", region_name=AWS_REGION)
        client.create_table(
            TableName=HEARTBEAT_TABLE,
            AttributeDefinitions=[{"AttributeName": "clientId", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "clientId", "KeyType": "HASH"}],
            BillingMode="PAY_PER_REQUEST",
        )
        yield


def test_put_then_get_round_trips_a_heartbeat(heartbeat_table):
    put_heartbeat({"clientId": "c1", "lastSeenAt": "2026-09-03T00:00:00+00:00", "appVersion": "1.0.0"})

    assert get_heartbeat("c1") == {
        "clientId": "c1",
        "lastSeenAt": "2026-09-03T00:00:00+00:00",
        "appVersion": "1.0.0",
    }


def test_get_returns_none_for_a_client_that_never_sent_a_heartbeat(heartbeat_table):
    assert get_heartbeat("no_such_client") is None


def test_put_overwrites_the_previous_heartbeat(heartbeat_table):
    put_heartbeat({"clientId": "c1", "lastSeenAt": "2026-09-03T00:00:00+00:00", "appVersion": "1.0.0"})
    put_heartbeat({"clientId": "c1", "lastSeenAt": "2026-09-03T00:05:00+00:00", "appVersion": "1.0.1"})

    record = get_heartbeat("c1")

    assert record["lastSeenAt"] == "2026-09-03T00:05:00+00:00"
    assert record["appVersion"] == "1.0.1"


def test_heartbeats_for_different_clients_do_not_overwrite_each_other(heartbeat_table):
    put_heartbeat({"clientId": "c1", "lastSeenAt": "2026-09-03T00:00:00+00:00", "appVersion": "1.0.0"})
    put_heartbeat({"clientId": "c2", "lastSeenAt": "2026-09-03T00:00:00+00:00", "appVersion": "2.0.0"})

    assert get_heartbeat("c1")["appVersion"] == "1.0.0"
    assert get_heartbeat("c2")["appVersion"] == "2.0.0"


def test_list_all_returns_every_stored_heartbeat(heartbeat_table):
    put_heartbeat({"clientId": "c1", "lastSeenAt": "2026-09-03T00:00:00+00:00", "appVersion": "1.0.0"})
    put_heartbeat({"clientId": "c2", "lastSeenAt": "2026-09-03T00:05:00+00:00", "appVersion": "2.0.0"})

    records = list_all()

    assert {record["clientId"] for record in records} == {"c1", "c2"}


def test_list_all_returns_empty_list_when_no_heartbeats_recorded(heartbeat_table):
    assert list_all() == []


def test_put_raises_heartbeat_store_error_when_table_is_missing(aws_credentials):
    with mock_aws():
        with pytest.raises(HeartbeatStoreError):
            put_heartbeat({"clientId": "c1", "lastSeenAt": "2026-09-03T00:00:00+00:00", "appVersion": "1.0.0"})
