import boto3
import pytest
from moto import mock_aws

from notifications.delivery_slots import slot_key
from stores.notification_slot_store import (
    CLIENT_INDEX,
    NOTIFICATION_SLOTS_TABLE,
    NotificationSlotStoreError,
    SlotRecipient,
    client_slot_keys,
    list_recipients,
    remove_client,
    sync_client_slots,
)

AWS_REGION = "ap-northeast-1"
T0 = "2026-09-03T00:00:00+00:00"
T1 = "2026-09-04T00:00:00+00:00"


@pytest.fixture
def slots_table(aws_credentials):
    """The production-shaped slot-recipient table (see terraform/dynamodb.tf) inside moto's mocked DynamoDB."""
    with mock_aws():
        boto3.client("dynamodb", region_name=AWS_REGION).create_table(
            TableName=NOTIFICATION_SLOTS_TABLE,
            AttributeDefinitions=[
                {"AttributeName": "slotKey", "AttributeType": "S"},
                {"AttributeName": "clientId", "AttributeType": "S"},
            ],
            KeySchema=[
                {"AttributeName": "slotKey", "KeyType": "HASH"},
                {"AttributeName": "clientId", "KeyType": "RANGE"},
            ],
            GlobalSecondaryIndexes=[
                {
                    "IndexName": CLIENT_INDEX,
                    "KeySchema": [{"AttributeName": "clientId", "KeyType": "HASH"}],
                    "Projection": {"ProjectionType": "ALL"},
                }
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        yield


def test_a_client_is_listed_under_each_slot_it_chose_and_nowhere_else(slots_table):
    sync_client_slots("c1", slots=[16, 36], now_iso=T0)

    assert list_recipients(16) == [SlotRecipient("c1", T0)]
    assert list_recipients(36) == [SlotRecipient("c1", T0)]
    assert list_recipients(17) == []
    assert client_slot_keys("c1") == {slot_key(16), slot_key(36)}


def test_every_recipient_of_a_slot_is_returned(slots_table):
    for number in range(130):
        sync_client_slots(f"client-{number:03d}", slots=[16], now_iso=T0)

    recipients = list_recipients(16)

    assert [r.client_id for r in recipients] == [f"client-{n:03d}" for n in range(130)]


def test_changing_the_selection_adds_new_slots_removes_stale_ones_and_keeps_active_since(slots_table):
    sync_client_slots("c1", slots=[16, 36], now_iso=T0)

    sync_client_slots("c1", slots=[16, 20], now_iso=T1)

    assert client_slot_keys("c1") == {slot_key(16), slot_key(20)}
    assert list_recipients(36) == []
    assert list_recipients(20) == [SlotRecipient("c1", T0)]  # still the original enabled stretch


def test_resyncing_the_same_selection_changes_nothing(slots_table):
    sync_client_slots("c1", slots=[16], now_iso=T0)
    sync_client_slots("c1", slots=[16], now_iso=T1)

    assert list_recipients(16) == [SlotRecipient("c1", T0)]


def test_removing_a_client_deletes_all_its_slots_and_a_later_return_starts_a_new_stretch(slots_table):
    sync_client_slots("c1", slots=[16, 36], now_iso=T0)
    sync_client_slots("c2", slots=[16], now_iso=T0)

    remove_client("c1")

    assert client_slot_keys("c1") == set()
    assert [r.client_id for r in list_recipients(16)] == ["c2"]

    sync_client_slots("c1", slots=[16], now_iso=T1)
    assert SlotRecipient("c1", T1) in list_recipients(16)


def test_removing_an_unknown_client_is_a_no_op(slots_table):
    remove_client("nobody")


def test_an_out_of_range_slot_is_rejected(slots_table):
    with pytest.raises(ValueError):
        sync_client_slots("c1", slots=[48], now_iso=T0)


def test_a_missing_table_is_a_store_error(aws_credentials):
    with mock_aws():
        with pytest.raises(NotificationSlotStoreError):
            list_recipients(16)
        with pytest.raises(NotificationSlotStoreError):
            sync_client_slots("c1", slots=[16], now_iso=T0)
