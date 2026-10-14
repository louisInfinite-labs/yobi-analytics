import boto3
import pytest
from moto import mock_aws

from stores.sync_profile_store import (
    DEVICE_ID_INDEX,
    SYNC_DEVICES_TABLE,
    SYNC_PROFILES_TABLE,
    attach_device,
    create_profile,
    delete_device,
    device_belongs_to_profile,
    get_profile_id_for_device,
    list_devices,
    profile_exists,
)

AWS_REGION = "ap-northeast-1"


@pytest.fixture
def sync_tables(aws_credentials):
    with mock_aws():
        client = boto3.client("dynamodb", region_name=AWS_REGION)
        client.create_table(
            TableName=SYNC_PROFILES_TABLE,
            AttributeDefinitions=[{"AttributeName": "profileId", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "profileId", "KeyType": "HASH"}],
            BillingMode="PAY_PER_REQUEST",
        )
        client.create_table(
            TableName=SYNC_DEVICES_TABLE,
            AttributeDefinitions=[
                {"AttributeName": "profileId", "AttributeType": "S"},
                {"AttributeName": "deviceId", "AttributeType": "S"},
            ],
            KeySchema=[
                {"AttributeName": "profileId", "KeyType": "HASH"},
                {"AttributeName": "deviceId", "KeyType": "RANGE"},
            ],
            GlobalSecondaryIndexes=[
                {
                    "IndexName": DEVICE_ID_INDEX,
                    "KeySchema": [{"AttributeName": "deviceId", "KeyType": "HASH"}],
                    "Projection": {"ProjectionType": "ALL"},
                }
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        yield


def test_create_profile_then_exists(sync_tables):
    create_profile({"profileId": "p1", "createdAt": "2026-01-01T00:00:00+00:00"})

    assert profile_exists("p1") is True
    assert profile_exists("no-such-profile") is False


def test_attach_device_then_lookup_by_device_id(sync_tables):
    attach_device({"profileId": "p1", "deviceId": "d1", "deviceLabel": "Desktop Chrome", "deviceType": "desktop", "lastSeenAt": "t1"})

    assert get_profile_id_for_device("d1") == "p1"
    assert get_profile_id_for_device("unknown-device") is None


def test_attach_device_upsert_preserves_original_created_at(sync_tables):
    attach_device({"profileId": "p1", "deviceId": "d1", "deviceLabel": "Desktop Chrome", "deviceType": "desktop", "lastSeenAt": "t1"})
    attach_device({"profileId": "p1", "deviceId": "d1", "deviceLabel": "Desktop Edge", "deviceType": "desktop", "lastSeenAt": "t2"})

    devices = list_devices("p1")
    assert len(devices) == 1
    assert devices[0]["createdAt"] == "t1"
    assert devices[0]["lastSeenAt"] == "t2"
    assert devices[0]["deviceLabel"] == "Desktop Edge"


def test_list_devices_returns_every_device_in_a_profile(sync_tables):
    attach_device({"profileId": "p1", "deviceId": "d1", "deviceLabel": "PC", "deviceType": "desktop", "lastSeenAt": "t"})
    attach_device({"profileId": "p1", "deviceId": "d2", "deviceLabel": "Phone", "deviceType": "android", "lastSeenAt": "t"})
    attach_device({"profileId": "p2", "deviceId": "d3", "deviceLabel": "Other profile's device", "deviceType": "ios", "lastSeenAt": "t"})

    device_ids = sorted(d["deviceId"] for d in list_devices("p1"))

    assert device_ids == ["d1", "d2"]


def test_device_belongs_to_profile(sync_tables):
    attach_device({"profileId": "p1", "deviceId": "d1", "deviceLabel": "PC", "deviceType": "desktop", "lastSeenAt": "t"})

    assert device_belongs_to_profile("p1", "d1") is True
    assert device_belongs_to_profile("p1", "d2") is False
    assert device_belongs_to_profile("other-profile", "d1") is False


def test_delete_device_removes_it_and_is_idempotent(sync_tables):
    attach_device({"profileId": "p1", "deviceId": "d1", "deviceLabel": "PC", "deviceType": "desktop", "lastSeenAt": "t"})

    delete_device("p1", "d1")
    delete_device("p1", "d1")  # second call: no error, nothing left to delete

    assert list_devices("p1") == []
    assert get_profile_id_for_device("d1") is None
