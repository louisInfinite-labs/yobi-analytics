import datetime as dt

import boto3
import pytest
from moto import mock_aws

from stores.pairing_token_store import (
    PAIRING_TOKENS_TABLE,
    HUMAN_CODE_INDEX,
    create_pairing_session,
    get_live_session_by_code_hash,
    get_live_session_by_token_hash,
    mark_consumed,
)

AWS_REGION = "ap-northeast-1"


@pytest.fixture
def pairing_tokens_table(aws_credentials):
    with mock_aws():
        client = boto3.client("dynamodb", region_name=AWS_REGION)
        client.create_table(
            TableName=PAIRING_TOKENS_TABLE,
            AttributeDefinitions=[
                {"AttributeName": "tokenHash", "AttributeType": "S"},
                {"AttributeName": "humanCodeHash", "AttributeType": "S"},
            ],
            KeySchema=[{"AttributeName": "tokenHash", "KeyType": "HASH"}],
            GlobalSecondaryIndexes=[
                {
                    "IndexName": HUMAN_CODE_INDEX,
                    "KeySchema": [{"AttributeName": "humanCodeHash", "KeyType": "HASH"}],
                    "Projection": {"ProjectionType": "ALL"},
                }
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        yield


def _session(**overrides):
    base = {
        "tokenHash": "tok-hash-1",
        "humanCodeHash": "code-hash-1",
        "profileId": None,
        "createdByDeviceId": "d1",
        "createdAt": "2026-01-01T00:00:00+00:00",
        "expiresAt": int(dt.datetime(2099, 1, 1, tzinfo=dt.timezone.utc).timestamp()),
    }
    base.update(overrides)
    return base


def test_create_then_get_by_token_hash_round_trips(pairing_tokens_table):
    create_pairing_session(_session())

    session = get_live_session_by_token_hash("tok-hash-1")

    assert session is not None
    assert session["humanCodeHash"] == "code-hash-1"
    assert session["consumed"] is False


def test_get_by_code_hash_resolves_the_same_session_via_the_gsi(pairing_tokens_table):
    create_pairing_session(_session())

    session = get_live_session_by_code_hash("code-hash-1")

    assert session is not None
    assert session["tokenHash"] == "tok-hash-1"


def test_get_returns_none_for_an_unknown_hash(pairing_tokens_table):
    assert get_live_session_by_token_hash("no-such-hash") is None
    assert get_live_session_by_code_hash("no-such-hash") is None


def test_get_returns_none_for_an_expired_session(pairing_tokens_table):
    expired_at = int(dt.datetime(2000, 1, 1, tzinfo=dt.timezone.utc).timestamp())
    create_pairing_session(_session(expiresAt=expired_at))

    assert get_live_session_by_token_hash("tok-hash-1") is None


def test_mark_consumed_succeeds_once_and_then_rejects_a_replay(pairing_tokens_table):
    create_pairing_session(_session())

    first = mark_consumed("tok-hash-1", resolved_profile_id="profile-1")
    second = mark_consumed("tok-hash-1", resolved_profile_id="profile-1")

    assert first is True
    assert second is False


def test_get_returns_none_once_consumed(pairing_tokens_table):
    create_pairing_session(_session())
    mark_consumed("tok-hash-1", resolved_profile_id="profile-1")

    assert get_live_session_by_token_hash("tok-hash-1") is None
