import pytest

from api.sync_profile_api import (
    SyncProfileError,
    attach_device_record,
    new_profile_id,
    new_profile_record,
    parse_device_type,
)


def test_new_profile_id_is_unique_and_opaque():
    a, b = new_profile_id(), new_profile_id()
    assert a != b
    assert len(a) >= 16


def test_new_profile_record_shape():
    record = new_profile_record()
    assert set(record.keys()) == {"profileId", "createdAt"}


def test_attach_device_record_sets_created_and_last_seen_to_the_same_call_timestamp():
    record = attach_device_record(profile_id="p1", device_id="d1", device_label="Desktop Chrome", device_type="desktop")
    assert record["createdAt"] == record["lastSeenAt"]
    assert record["profileId"] == "p1"
    assert record["deviceId"] == "d1"
    assert record["deviceType"] == "desktop"


def test_attach_device_record_rejects_an_unknown_device_type():
    with pytest.raises(SyncProfileError):
        attach_device_record(profile_id="p1", device_id="d1", device_label="x", device_type="smart-watch")


def test_parse_device_type_accepts_exactly_the_three_form_factors():
    for value in ("desktop", "android", "ios"):
        assert parse_device_type(value) == value
    with pytest.raises(SyncProfileError):
        parse_device_type("other")
