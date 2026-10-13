from datetime import datetime, timezone

import boto3
import pytest
from moto import mock_aws

from scripts.migration import backfill_notification_slots as backfill
from stores import notification_slot_store, remote_config_store

AWS_REGION = "ap-northeast-1"
NOW = datetime(2026, 9, 10, 0, 0, tzinfo=timezone.utc)


def _preference(**overrides) -> dict:
    fields = {
        "enabled": True,
        "notificationLevel": "all",
        "notificationTimeZone": "Asia/Tokyo",
        "deliveryWindows": ["08:00", "18:00"],
    }
    fields.update(overrides)
    return fields


@pytest.fixture
def tables(aws_credentials):
    with mock_aws():
        client = boto3.client("dynamodb", region_name=AWS_REGION)
        client.create_table(
            TableName=remote_config_store.REMOTE_CONFIG_TABLE,
            AttributeDefinitions=[
                {"AttributeName": "clientId", "AttributeType": "S"},
                {"AttributeName": "configKey", "AttributeType": "S"},
            ],
            KeySchema=[{"AttributeName": "clientId", "KeyType": "HASH"}, {"AttributeName": "configKey", "KeyType": "RANGE"}],
            GlobalSecondaryIndexes=[
                {
                    "IndexName": remote_config_store.CONFIG_KEY_INDEX,
                    "KeySchema": [{"AttributeName": "configKey", "KeyType": "HASH"}],
                    "Projection": {"ProjectionType": "ALL"},
                }
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        client.create_table(
            TableName=notification_slot_store.NOTIFICATION_SLOTS_TABLE,
            AttributeDefinitions=[
                {"AttributeName": "slotKey", "AttributeType": "S"},
                {"AttributeName": "clientId", "AttributeType": "S"},
            ],
            KeySchema=[{"AttributeName": "slotKey", "KeyType": "HASH"}, {"AttributeName": "clientId", "KeyType": "RANGE"}],
            GlobalSecondaryIndexes=[
                {
                    "IndexName": notification_slot_store.CLIENT_INDEX,
                    "KeySchema": [{"AttributeName": "clientId", "KeyType": "HASH"}],
                    "Projection": {"ProjectionType": "ALL"},
                }
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        yield


def _store(client_id: str, value: dict) -> None:
    remote_config_store.put_remote_config(
        {"clientId": client_id, "key": "notificationPreference", "value": value, "updatedAt": "2026-09-01T00:00:00+00:00"}
    )


def test_a_dry_run_reports_what_it_would_index_and_writes_nothing(tables):
    _store("c1", _preference())
    _store("c2", _preference(enabled=False))

    report = backfill.run(apply=False, now=NOW)

    assert report.indexed == [("c1", (16, 36))]
    assert report.removed == ["c2"]
    assert notification_slot_store.list_recipients(16) == []
    assert notification_slot_store.client_slot_keys("c1") == set()


def test_apply_indexes_each_enabled_client_with_the_cutover_time_as_active_since(tables):
    _store("c1", _preference())
    # A client's own stored zone is irrelevant: delivery slots are JST, so 06:30 is JST slot 13 whatever zone is stored.
    _store("c3", _preference(notificationTimeZone="America/New_York", deliveryWindows=["06:30"]))

    backfill.run(apply=True, now=NOW)

    assert notification_slot_store.list_recipients(16) == [notification_slot_store.SlotRecipient("c1", NOW.isoformat())]
    assert [r.client_id for r in notification_slot_store.list_recipients(13)] == ["c3"]


def test_a_disabled_or_invalid_client_is_not_indexed_and_a_stale_index_entry_is_removed(tables):
    notification_slot_store.sync_client_slots("c2", slots=[16], now_iso="2026-01-01T00:00:00+00:00")
    notification_slot_store.sync_client_slots("c4", slots=[16], now_iso="2026-01-01T00:00:00+00:00")
    _store("c2", _preference(enabled=False))
    _store("c4", {"enabled": "not-a-bool"})

    report = backfill.run(apply=True, now=NOW)

    assert sorted(report.removed) == ["c2", "c4"] and report.invalid == ["c4"]
    assert notification_slot_store.client_slot_keys("c2") == set()
    assert notification_slot_store.client_slot_keys("c4") == set()


def test_windows_written_before_the_four_slot_rule_are_normalized_and_reported(tables):
    _store("legacy", _preference(deliveryWindows=["06:00", "07:10", "08:00", "09:00", "10:00"]))

    report = backfill.run(apply=True, now=NOW)

    assert report.normalized == [("legacy", ["06:00", "07:10", "08:00", "09:00", "10:00"], ["06:00", "07:00", "08:00", "09:00"])]
    assert notification_slot_store.client_slot_keys("legacy") == {f"{slot:02d}" for slot in (12, 14, 16, 18)}


def test_running_it_twice_changes_nothing_and_keeps_the_first_active_since(tables):
    _store("c1", _preference())
    backfill.run(apply=True, now=NOW)

    backfill.run(apply=True, now=datetime(2026, 9, 11, tzinfo=timezone.utc))

    assert notification_slot_store.list_recipients(16) == [notification_slot_store.SlotRecipient("c1", NOW.isoformat())]


def test_the_cli_is_a_dry_run_unless_apply_is_passed(tables, capsys):
    _store("c1", _preference())

    assert backfill.main([]) == 0
    assert "DRY RUN" in capsys.readouterr().out
    assert notification_slot_store.list_recipients(16) == []

    assert backfill.main(["--apply"]) == 0
    assert "APPLIED" in capsys.readouterr().out
    assert [r.client_id for r in notification_slot_store.list_recipients(16)] == ["c1"]
