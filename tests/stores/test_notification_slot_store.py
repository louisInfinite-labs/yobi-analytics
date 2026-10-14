import boto3
import pytest
from moto import mock_aws

from notifications.delivery_slots import ZONES_PARTITION, zone_slot_key
from stores.notification_slot_store import (
    CLIENT_INDEX,
    NOTIFICATION_SLOTS_TABLE,
    NotificationSlotStoreError,
    SlotRecipient,
    client_slot_keys,
    list_recipients,
    list_zones,
    remove_client,
    sync_client_slots,
)

AWS_REGION = "ap-northeast-1"
T0 = "2026-09-03T00:00:00+00:00"
T1 = "2026-09-04T00:00:00+00:00"
TOKYO = "Asia/Tokyo"
HONG_KONG = "Asia/Hong_Kong"
NEW_YORK = "America/New_York"


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


def _table():
    return boto3.resource("dynamodb", region_name=AWS_REGION).Table(NOTIFICATION_SLOTS_TABLE)


def test_a_client_is_listed_under_each_local_slot_it_chose_in_its_zone_and_nowhere_else(slots_table):
    sync_client_slots("c1", zone=HONG_KONG, slots=[16, 36], now_iso=T0)

    assert list_recipients(HONG_KONG, 16) == [SlotRecipient("c1", T0)]
    assert list_recipients(HONG_KONG, 36) == [SlotRecipient("c1", T0)]
    assert list_recipients(HONG_KONG, 17) == []
    assert list_recipients(TOKYO, 16) == []  # the same local time in another zone is a different partition
    assert client_slot_keys("c1") == {zone_slot_key(HONG_KONG, 16), zone_slot_key(HONG_KONG, 36)}


def test_the_same_local_time_in_different_zones_stays_separate(slots_table):
    sync_client_slots("hk", zone=HONG_KONG, slots=[16], now_iso=T0)
    sync_client_slots("jp", zone=TOKYO, slots=[16], now_iso=T0)
    sync_client_slots("ny", zone=NEW_YORK, slots=[16], now_iso=T0)

    assert [r.client_id for r in list_recipients(HONG_KONG, 16)] == ["hk"]
    assert [r.client_id for r in list_recipients(TOKYO, 16)] == ["jp"]
    assert [r.client_id for r in list_recipients(NEW_YORK, 16)] == ["ny"]


def test_every_zone_with_a_recipient_is_registered_once_and_zones_are_listed_without_a_scan(slots_table):
    sync_client_slots("hk1", zone=HONG_KONG, slots=[16], now_iso=T0)
    sync_client_slots("hk2", zone=HONG_KONG, slots=[16, 36], now_iso=T0)
    sync_client_slots("jp", zone=TOKYO, slots=[16], now_iso=T0)

    assert list_zones() == [HONG_KONG, TOKYO]
    registry = _table().query(
        KeyConditionExpression=boto3.dynamodb.conditions.Key("slotKey").eq(ZONES_PARTITION)  # one partition, read by key
    )["Items"]
    assert sorted(item["clientId"] for item in registry) == [HONG_KONG, TOKYO]


def test_a_zone_registered_before_its_rows_exist_is_never_missing_for_a_findable_client(slots_table):
    sync_client_slots("c1", zone=NEW_YORK, slots=[16], now_iso=T0)

    assert NEW_YORK in list_zones()
    assert list_recipients(NEW_YORK, 16) == [SlotRecipient("c1", T0)]


def test_every_recipient_of_a_slot_is_returned(slots_table):
    for number in range(130):
        sync_client_slots(f"client-{number:03d}", zone=TOKYO, slots=[16], now_iso=T0)

    recipients = list_recipients(TOKYO, 16)

    assert [r.client_id for r in recipients] == [f"client-{n:03d}" for n in range(130)]


def test_changing_the_selection_adds_new_slots_removes_stale_ones_and_keeps_active_since(slots_table):
    sync_client_slots("c1", zone=TOKYO, slots=[16, 36], now_iso=T0)

    sync_client_slots("c1", zone=TOKYO, slots=[16, 20], now_iso=T1)

    assert client_slot_keys("c1") == {zone_slot_key(TOKYO, 16), zone_slot_key(TOKYO, 20)}
    assert list_recipients(TOKYO, 36) == []
    assert list_recipients(TOKYO, 20) == [SlotRecipient("c1", T0)]  # still the original enabled stretch


def test_changing_time_zone_moves_the_client_keeps_the_local_times_and_never_resets_active_since(slots_table):
    sync_client_slots("c1", zone=HONG_KONG, slots=[16, 36], now_iso=T0)

    sync_client_slots("c1", zone="Europe/London", slots=[16, 36], now_iso=T1)  # same LOCAL 08:00 / 18:00, new zone

    assert client_slot_keys("c1") == {zone_slot_key("Europe/London", 16), zone_slot_key("Europe/London", 36)}
    assert list_recipients(HONG_KONG, 16) == []
    assert list_recipients("Europe/London", 16) == [SlotRecipient("c1", T0)]  # the enabled stretch continues: nothing is replayed


def test_resyncing_the_same_selection_changes_nothing(slots_table):
    sync_client_slots("c1", zone=TOKYO, slots=[16], now_iso=T0)
    sync_client_slots("c1", zone=TOKYO, slots=[16], now_iso=T1)

    assert list_recipients(TOKYO, 16) == [SlotRecipient("c1", T0)]
    assert len(_table().scan()["Items"]) == 2  # one slot row + the zone registry row: no duplicates


def test_removing_a_client_deletes_all_its_slots_and_a_later_return_starts_a_new_stretch(slots_table):
    sync_client_slots("c1", zone=TOKYO, slots=[16, 36], now_iso=T0)
    sync_client_slots("c2", zone=TOKYO, slots=[16], now_iso=T0)

    remove_client("c1")

    assert client_slot_keys("c1") == set()
    assert [r.client_id for r in list_recipients(TOKYO, 16)] == ["c2"]

    sync_client_slots("c1", zone=TOKYO, slots=[16], now_iso=T1)
    assert SlotRecipient("c1", T1) in list_recipients(TOKYO, 16)


def test_removing_an_unknown_client_is_a_no_op(slots_table):
    remove_client("nobody")


def test_first_release_rows_are_pruned_by_the_next_sync_and_kept_for_a_rollback_on_request(slots_table):
    # First-release rows: the bare JST slot as the key, no zone.
    for client_id in ("c1", "c2"):
        _table().put_item(Item={"slotKey": "16", "clientId": client_id, "slot": 16, "activeSince": T0})

    sync_client_slots("c1", zone=TOKYO, slots=[16], now_iso=T1)  # default: prune
    sync_client_slots("c2", zone=TOKYO, slots=[16], now_iso=T1, prune_legacy=False)

    assert client_slot_keys("c1") == {zone_slot_key(TOKYO, 16)}
    assert client_slot_keys("c2") == {"16", zone_slot_key(TOKYO, 16)}
    assert list_recipients(TOKYO, 16) == [SlotRecipient("c1", T0), SlotRecipient("c2", T0)]  # the original activeSince survived the re-key


def test_an_out_of_range_slot_or_an_unusable_zone_is_rejected(slots_table):
    with pytest.raises(ValueError):
        sync_client_slots("c1", zone=TOKYO, slots=[48], now_iso=T0)
    with pytest.raises(ValueError):
        sync_client_slots("c1", zone="", slots=[16], now_iso=T0)


def test_a_missing_table_is_a_store_error(aws_credentials):
    with mock_aws():
        with pytest.raises(NotificationSlotStoreError):
            list_recipients(TOKYO, 16)
        with pytest.raises(NotificationSlotStoreError):
            list_zones()
        with pytest.raises(NotificationSlotStoreError):
            sync_client_slots("c1", zone=TOKYO, slots=[16], now_iso=T0)
