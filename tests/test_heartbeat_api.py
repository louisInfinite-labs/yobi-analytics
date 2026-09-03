from datetime import datetime, timedelta, timezone

import pytest

from heartbeat_api import (
    ClientError,
    ONLINE_THRESHOLD_SECONDS,
    online_status,
    parse_app_version,
    parse_client_id,
    record_heartbeat,
)

FIXED_NOW = datetime(2026, 9, 1, 18, 0, 0, tzinfo=timezone.utc)


# --- parse_client_id / parse_app_version ------------------------------------


@pytest.mark.parametrize("bad_value", [None, 123, ""])
def test_parse_client_id_rejects_missing_or_non_string_values(bad_value):
    with pytest.raises(ClientError):
        parse_client_id(bad_value)


def test_parse_client_id_accepts_a_uuid_string():
    assert parse_client_id("c1a2b3c4-0000-0000-0000-000000000000") == "c1a2b3c4-0000-0000-0000-000000000000"


@pytest.mark.parametrize("bad_value", [None, 123, ""])
def test_parse_app_version_rejects_missing_or_non_string_values(bad_value):
    with pytest.raises(ClientError):
        parse_app_version(bad_value)


# --- record_heartbeat --------------------------------------------------


def test_record_heartbeat_returns_the_normalized_record():
    record = record_heartbeat({"clientId": "client-1", "appVersion": "1.2.3"}, now=FIXED_NOW)

    assert record == {
        "clientId": "client-1",
        "lastSeenAt": FIXED_NOW.isoformat(),
        "appVersion": "1.2.3",
    }


def test_record_heartbeat_ignores_a_client_supplied_lastSeenAt():
    """lastSeenAt must always be the server's own clock — a client could
    otherwise misreport its own online status with a skewed/spoofed clock."""
    record = record_heartbeat(
        {"clientId": "client-1", "appVersion": "1.2.3", "lastSeenAt": "2000-01-01T00:00:00+00:00"},
        now=FIXED_NOW,
    )

    assert record["lastSeenAt"] == FIXED_NOW.isoformat()


@pytest.mark.parametrize("bad_body", [{}, {"clientId": "client-1"}, {"appVersion": "1.2.3"}, {"clientId": 123, "appVersion": "1.2.3"}])
def test_record_heartbeat_rejects_a_malformed_body(bad_body):
    with pytest.raises(ClientError):
        record_heartbeat(bad_body, now=FIXED_NOW)


# --- online_status -----------------------------------------------------


def test_online_status_is_online_within_the_threshold():
    seen = (FIXED_NOW - timedelta(seconds=ONLINE_THRESHOLD_SECONDS)).isoformat()
    assert online_status(seen, now=FIXED_NOW) == "online"


def test_online_status_is_offline_just_past_the_threshold():
    seen = (FIXED_NOW - timedelta(seconds=ONLINE_THRESHOLD_SECONDS + 1)).isoformat()
    assert online_status(seen, now=FIXED_NOW) == "offline"


def test_online_status_is_online_for_a_timestamp_ahead_of_the_reference_clock():
    """A slightly-ahead lastSeenAt (small clock skew between the write and
    read reference times) must not read as stale/offline."""
    seen = (FIXED_NOW + timedelta(seconds=5)).isoformat()
    assert online_status(seen, now=FIXED_NOW) == "online"


@pytest.mark.parametrize("bad_value", [None, 123, "", "not-a-timestamp", "2026-09-01T18:00:00"])
def test_online_status_rejects_malformed_or_naive_timestamps(bad_value):
    """A naive (no UTC offset) timestamp is rejected rather than compared
    against an aware reference clock, which would raise TypeError."""
    with pytest.raises(ClientError):
        online_status(bad_value, now=FIXED_NOW)
