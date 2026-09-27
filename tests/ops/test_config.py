from unittest.mock import patch

import boto3
import pytest
from moto import mock_aws

from ops import config
from ops.config import MissingAPIKeyError, MissingHolodexApiKeyError, get_api_key, get_holodex_api_key

AWS_REGION = "ap-northeast-1"
SECRET_NAME = "yobi-analytics/youtube-api-key"
HOLODEX_SECRET_NAME = "yobi-analytics/holodex-api-key"


@pytest.fixture(autouse=True)
def reset_cache_and_env(monkeypatch):
    """Each test starts with no cached key and neither env var set."""
    monkeypatch.delenv("YOUTUBE_API_KEY", raising=False)
    monkeypatch.delenv("YOUTUBE_API_KEY_SECRET_NAME", raising=False)
    get_api_key.cache_clear()
    yield
    get_api_key.cache_clear()


def test_reads_from_secrets_manager_when_secret_name_is_set(monkeypatch):
    monkeypatch.setenv("YOUTUBE_API_KEY_SECRET_NAME", SECRET_NAME)
    with mock_aws():
        client = boto3.client("secretsmanager", region_name=AWS_REGION)
        client.create_secret(Name=SECRET_NAME, SecretString="secret-key-value")

        assert get_api_key() == "secret-key-value"


def test_falls_back_to_plain_env_var_when_secret_name_is_unset(monkeypatch):
    monkeypatch.setenv("YOUTUBE_API_KEY", "local-dev-key")

    assert get_api_key() == "local-dev-key"


def test_raises_when_neither_is_set():
    with pytest.raises(MissingAPIKeyError):
        get_api_key()


def test_second_call_does_not_hit_secrets_manager_again(monkeypatch):
    monkeypatch.setenv("YOUTUBE_API_KEY_SECRET_NAME", SECRET_NAME)
    with mock_aws():
        client = boto3.client("secretsmanager", region_name=AWS_REGION)
        client.create_secret(Name=SECRET_NAME, SecretString="secret-key-value")

        with patch("boto3.client", wraps=boto3.client) as spy:
            first = get_api_key()
            second = get_api_key()

        assert first == second == "secret-key-value"
        spy.assert_called_once()


def test_raises_missing_api_key_error_when_secret_does_not_exist(monkeypatch):
    """A ClientError (e.g. ResourceNotFoundException) from Secrets Manager must surface as
    MissingAPIKeyError, the only exception type main.py's call sites catch."""
    monkeypatch.setenv("YOUTUBE_API_KEY_SECRET_NAME", SECRET_NAME)
    with mock_aws():
        with pytest.raises(MissingAPIKeyError):
            get_api_key()


def test_raises_missing_api_key_error_when_secret_has_no_secret_string(monkeypatch):
    """A secret created as SecretBinary (or otherwise lacking SecretString) must not raise
    a raw KeyError — it should fail the same clean way as every other missing-key case."""
    monkeypatch.setenv("YOUTUBE_API_KEY_SECRET_NAME", SECRET_NAME)
    with mock_aws():
        client = boto3.client("secretsmanager", region_name=AWS_REGION)
        client.create_secret(Name=SECRET_NAME, SecretBinary=b"not-a-string-secret")

        with pytest.raises(MissingAPIKeyError):
            get_api_key()


def test_failure_does_not_get_cached(monkeypatch):
    """A failed lookup must not be memoized — a later successful call (e.g. after the
    secret is created) must not keep raising."""
    monkeypatch.setenv("YOUTUBE_API_KEY_SECRET_NAME", SECRET_NAME)
    with mock_aws():
        with pytest.raises(MissingAPIKeyError):
            get_api_key()

        client = boto3.client("secretsmanager", region_name=AWS_REGION)
        client.create_secret(Name=SECRET_NAME, SecretString="secret-key-value")

        assert get_api_key() == "secret-key-value"


@pytest.fixture(autouse=True)
def reset_holodex_cache_and_env(monkeypatch):
    """Each test starts with no cached key and neither Holodex env var set."""
    monkeypatch.delenv("HOLODEX_API_KEY", raising=False)
    monkeypatch.delenv("HOLODEX_SECRET_NAME", raising=False)
    get_holodex_api_key.cache_clear()
    yield
    get_holodex_api_key.cache_clear()


def test_holodex_reads_from_secrets_manager_when_secret_name_is_set(monkeypatch):
    monkeypatch.setenv("HOLODEX_SECRET_NAME", HOLODEX_SECRET_NAME)
    with mock_aws():
        client = boto3.client("secretsmanager", region_name=AWS_REGION)
        client.create_secret(Name=HOLODEX_SECRET_NAME, SecretString="secret-holodex-value")

        assert get_holodex_api_key() == "secret-holodex-value"


def test_holodex_falls_back_to_plain_env_var_when_secret_name_is_unset(monkeypatch):
    monkeypatch.setenv("HOLODEX_API_KEY", "local-dev-holodex-key")

    assert get_holodex_api_key() == "local-dev-holodex-key"


def test_holodex_secret_name_takes_priority_when_both_are_set(monkeypatch):
    """Matches get_api_key()'s priority: Secrets Manager wins over the plaintext fallback."""
    monkeypatch.setenv("HOLODEX_SECRET_NAME", HOLODEX_SECRET_NAME)
    monkeypatch.setenv("HOLODEX_API_KEY", "local-dev-holodex-key")
    with mock_aws():
        client = boto3.client("secretsmanager", region_name=AWS_REGION)
        client.create_secret(Name=HOLODEX_SECRET_NAME, SecretString="secret-holodex-value")

        assert get_holodex_api_key() == "secret-holodex-value"


def test_holodex_raises_when_neither_is_set():
    with pytest.raises(MissingHolodexApiKeyError):
        get_holodex_api_key()


def test_holodex_second_call_does_not_hit_secrets_manager_again(monkeypatch):
    monkeypatch.setenv("HOLODEX_SECRET_NAME", HOLODEX_SECRET_NAME)
    with mock_aws():
        client = boto3.client("secretsmanager", region_name=AWS_REGION)
        client.create_secret(Name=HOLODEX_SECRET_NAME, SecretString="secret-holodex-value")

        with patch("boto3.client", wraps=boto3.client) as spy:
            first = get_holodex_api_key()
            second = get_holodex_api_key()

        assert first == second == "secret-holodex-value"
        spy.assert_called_once()


def test_holodex_raises_missing_api_key_error_when_secret_does_not_exist(monkeypatch):
    """A ClientError (e.g. ResourceNotFoundException) from Secrets Manager must surface as
    MissingHolodexApiKeyError, matching get_api_key()'s error-handling pattern."""
    monkeypatch.setenv("HOLODEX_SECRET_NAME", HOLODEX_SECRET_NAME)
    with mock_aws():
        with pytest.raises(MissingHolodexApiKeyError):
            get_holodex_api_key()


def test_holodex_raises_missing_api_key_error_when_secret_has_no_secret_string(monkeypatch):
    """A secret created as SecretBinary (or otherwise lacking SecretString) must not raise
    a raw KeyError — it should fail the same clean way as every other missing-key case."""
    monkeypatch.setenv("HOLODEX_SECRET_NAME", HOLODEX_SECRET_NAME)
    with mock_aws():
        client = boto3.client("secretsmanager", region_name=AWS_REGION)
        client.create_secret(Name=HOLODEX_SECRET_NAME, SecretBinary=b"not-a-string-secret")

        with pytest.raises(MissingHolodexApiKeyError):
            get_holodex_api_key()


def test_holodex_failure_does_not_get_cached(monkeypatch):
    """A failed lookup must not be memoized — a later successful call (e.g. after the
    secret is created) must not keep raising."""
    monkeypatch.setenv("HOLODEX_SECRET_NAME", HOLODEX_SECRET_NAME)
    with mock_aws():
        with pytest.raises(MissingHolodexApiKeyError):
            get_holodex_api_key()

        client = boto3.client("secretsmanager", region_name=AWS_REGION)
        client.create_secret(Name=HOLODEX_SECRET_NAME, SecretString="secret-holodex-value")

        assert get_holodex_api_key() == "secret-holodex-value"
