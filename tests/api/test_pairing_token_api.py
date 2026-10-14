import pytest

from api.pairing_token_api import (
    PAIRING_SESSION_TTL_SECONDS,
    PairingError,
    create_pairing_session,
    generate_human_code,
    generate_pairing_secret,
    hash_pairing_value,
    normalize_human_code,
    parse_consume_request,
    parse_device_label,
    parse_device_type,
)


def test_generate_pairing_secret_is_high_entropy_and_unique():
    a, b = generate_pairing_secret(), generate_pairing_secret()
    assert len(a) > 30
    assert a != b


def test_generate_human_code_is_grouped_and_excludes_ambiguous_characters():
    code = generate_human_code()
    assert len(code) == 9  # "XXXX-XXXX"
    assert code[4] == "-"
    for ch in code.replace("-", ""):
        assert ch not in "0O1IL"


def test_normalize_human_code_strips_dashes_spaces_and_uppercases():
    assert normalize_human_code("ab3d efgh") == normalize_human_code("AB3D-EFGH")


def test_normalize_human_code_rejects_wrong_length():
    with pytest.raises(PairingError):
        normalize_human_code("ABC")


def test_normalize_human_code_rejects_ambiguous_characters_not_in_the_alphabet():
    with pytest.raises(PairingError):
        normalize_human_code("AAAA000O")  # contains '0' and 'O', excluded from the generation alphabet


def test_hash_pairing_value_is_deterministic_and_never_the_raw_value():
    value = generate_pairing_secret()
    assert hash_pairing_value(value) == hash_pairing_value(value)
    assert hash_pairing_value(value) != value


def test_create_pairing_session_without_profile_id_is_a_fresh_pairing():
    record = create_pairing_session({"deviceId": "d1"})
    assert record["profileId"] is None
    assert record["createdByDeviceId"] == "d1"
    assert record["tokenHash"] == hash_pairing_value(record["token"])
    assert record["humanCodeHash"] == hash_pairing_value(record["humanCode"])


def test_create_pairing_session_with_profile_id_carries_it_through():
    record = create_pairing_session({"deviceId": "d1", "profileId": "profile-1"})
    assert record["profileId"] == "profile-1"


def test_create_pairing_session_expiry_matches_the_ttl_constant():
    import datetime as dt

    now = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
    record = create_pairing_session({"deviceId": "d1"}, now=now)
    assert record["expiresAt"] == int(now.timestamp()) + PAIRING_SESSION_TTL_SECONDS


def test_create_pairing_session_rejects_a_missing_device_id():
    with pytest.raises(PairingError):
        create_pairing_session({})


def test_parse_consume_request_requires_exactly_one_of_token_or_code():
    base = {"deviceId": "d1", "deviceLabel": "Desktop Chrome", "deviceType": "desktop"}
    with pytest.raises(PairingError):
        parse_consume_request({**base, "token": "t", "code": "c"})
    with pytest.raises(PairingError):
        parse_consume_request(base)


def test_parse_consume_request_with_token_hashes_the_raw_token_directly():
    parsed = parse_consume_request({"token": "raw-token", "deviceId": "d1", "deviceLabel": "x", "deviceType": "ios"})
    assert parsed["lookupHash"] == hash_pairing_value("raw-token")
    assert parsed["usedToken"] is True


def test_parse_consume_request_with_code_normalizes_before_hashing():
    parsed = parse_consume_request({"code": "ab3d efgh", "deviceId": "d1", "deviceLabel": "x", "deviceType": "android"})
    assert parsed["lookupHash"] == hash_pairing_value("AB3DEFGH")
    assert parsed["usedToken"] is False


def test_parse_device_type_rejects_an_unknown_value():
    with pytest.raises(PairingError):
        parse_device_type("smart-fridge")


def test_parse_device_label_trims_and_caps_length():
    assert parse_device_label("  Desktop Chrome  ") == "Desktop Chrome"
    with pytest.raises(PairingError):
        parse_device_label("   ")
