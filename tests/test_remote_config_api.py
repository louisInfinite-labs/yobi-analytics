from datetime import datetime, timezone

import pytest

from remote_config_api import (
    ClientError,
    parse_client_id,
    parse_config_key,
    parse_read_query,
    write_remote_config,
)

FIXED_NOW = datetime(2026, 9, 1, 18, 0, 0, tzinfo=timezone.utc)


# --- parse_client_id / parse_config_key -------------------------------------


@pytest.mark.parametrize("bad_value", [None, 123, ""])
def test_parse_client_id_rejects_missing_or_non_string_values(bad_value):
    with pytest.raises(ClientError):
        parse_client_id(bad_value)


@pytest.mark.parametrize("bad_value", [None, 123, ""])
def test_parse_config_key_rejects_missing_or_non_string_values(bad_value):
    with pytest.raises(ClientError):
        parse_config_key(bad_value)


# --- write_remote_config -----------------------------------------------


@pytest.mark.parametrize(
    "value",
    ["off", 3, 3.5, True, False, None, ["Asia/Tokyo", "08:00"], {"quietHours": ["22:00", "07:00"]}],
)
def test_write_remote_config_accepts_any_json_typed_value(value):
    """The backend treats `value` as opaque — it must never reject a value
    for its type/shape, only for being absent entirely."""
    record = write_remote_config({"clientId": "client-1", "key": "notification.aizawa_ema", "value": value}, now=FIXED_NOW)

    assert record == {
        "clientId": "client-1",
        "key": "notification.aizawa_ema",
        "value": value,
        "updatedAt": FIXED_NOW.isoformat(),
    }


def test_write_remote_config_rejects_a_body_with_no_value_key_at_all():
    """A value of None is a legitimate stored value (see the parametrized
    test above) — the field must be present, not merely non-null."""
    with pytest.raises(ClientError):
        write_remote_config({"clientId": "client-1", "key": "notification.aizawa_ema"}, now=FIXED_NOW)


@pytest.mark.parametrize(
    "bad_body",
    [
        {},
        {"key": "notification.aizawa_ema", "value": "off"},
        {"clientId": "client-1", "value": "off"},
        {"clientId": 123, "key": "notification.aizawa_ema", "value": "off"},
        {"clientId": "client-1", "key": "", "value": "off"},
    ],
)
def test_write_remote_config_rejects_a_malformed_body(bad_body):
    with pytest.raises(ClientError):
        write_remote_config(bad_body, now=FIXED_NOW)


# --- parse_read_query ----------------------------------------------------


def test_parse_read_query_returns_client_id_with_no_key_when_key_is_absent():
    """Absent key means "every stored key for this client", not an error."""
    assert parse_read_query({"clientId": "client-1"}) == ("client-1", None)


def test_parse_read_query_returns_client_id_and_key_when_both_are_present():
    assert parse_read_query({"clientId": "client-1", "key": "notification.aizawa_ema"}) == (
        "client-1",
        "notification.aizawa_ema",
    )


@pytest.mark.parametrize("bad_client_id", [None, 123, ""])
def test_parse_read_query_rejects_a_missing_or_malformed_client_id(bad_client_id):
    with pytest.raises(ClientError):
        parse_read_query({"clientId": bad_client_id})


def test_parse_read_query_rejects_a_non_string_key_when_present():
    with pytest.raises(ClientError):
        parse_read_query({"clientId": "client-1", "key": 123})
