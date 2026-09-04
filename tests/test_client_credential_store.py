import boto3
import pytest
from botocore.exceptions import EndpointConnectionError
from moto import mock_aws

import client_credential_store
from client_credential_store import (
    CLIENT_CREDENTIALS_TABLE,
    ClientCredentialStoreError,
    create_secret,
    get_secret_hash,
)

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
def credentials_table(aws_credentials):
    """Create the production-shaped Client Credentials table inside moto's fully mocked DynamoDB."""
    with mock_aws():
        client = boto3.client("dynamodb", region_name=AWS_REGION)
        client.create_table(
            TableName=CLIENT_CREDENTIALS_TABLE,
            AttributeDefinitions=[{"AttributeName": "clientId", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "clientId", "KeyType": "HASH"}],
            BillingMode="PAY_PER_REQUEST",
        )
        yield


def test_a_clientid_with_no_credential_has_no_stored_hash(credentials_table):
    assert get_secret_hash("c1") is None


def test_create_secret_returns_true_and_makes_the_hash_readable(credentials_table):
    assert create_secret("c1", "hash-of-secret") is True

    assert get_secret_hash("c1") == "hash-of-secret"


def test_a_second_create_secret_call_for_the_same_clientid_returns_false(credentials_table):
    """The conditional write api_handler.py's registration route relies on:
    a clientId that already has a credential must not silently get a
    second one issued."""
    assert create_secret("c1", "first-hash") is True

    assert create_secret("c1", "second-hash") is False
    assert get_secret_hash("c1") == "first-hash"


def test_credentials_are_scoped_per_clientid(credentials_table):
    create_secret("c1", "c1-hash")

    assert get_secret_hash("c2") is None


def test_create_secret_raises_store_error_when_table_is_missing(aws_credentials):
    with mock_aws():
        with pytest.raises(ClientCredentialStoreError):
            create_secret("c1", "hash-of-secret")


def test_get_secret_hash_raises_store_error_when_table_is_missing(aws_credentials):
    with mock_aws():
        with pytest.raises(ClientCredentialStoreError):
            get_secret_hash("c1")


def test_create_secret_converts_a_botocore_error_too(monkeypatch):
    """EndpointConnectionError (and other BotoCoreError subclasses) are a
    separate exception family from ClientError and can be raised by
    _resource().Table(...) itself or put_item's own setup — catching only
    ClientError would let this escape as a raw exception instead."""
    monkeypatch.setattr(client_credential_store, "_resource", lambda: (_ for _ in ()).throw(EndpointConnectionError(endpoint_url="https://dynamodb.example.invalid")))

    with pytest.raises(ClientCredentialStoreError):
        create_secret("c1", "hash-of-secret")


def test_get_secret_hash_converts_a_botocore_error_too(monkeypatch):
    monkeypatch.setattr(client_credential_store, "_resource", lambda: (_ for _ in ()).throw(EndpointConnectionError(endpoint_url="https://dynamodb.example.invalid")))

    with pytest.raises(ClientCredentialStoreError):
        get_secret_hash("c1")
