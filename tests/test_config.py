from unittest.mock import patch

import boto3
import pytest
from moto import mock_aws

import config
from config import MissingAPIKeyError, get_api_key

AWS_REGION = "ap-northeast-1"
SECRET_NAME = "yobi-analytics/youtube-api-key"


@pytest.fixture(autouse=True)
def reset_cache_and_env(monkeypatch):
    """Each test starts with no cached key and neither env var set."""
    monkeypatch.delenv("YOUTUBE_API_KEY", raising=False)
    monkeypatch.delenv("YOUTUBE_API_KEY_SECRET_NAME", raising=False)
    config._cached_api_key = None
    yield
    config._cached_api_key = None


@pytest.fixture(autouse=True)
def aws_credentials(monkeypatch):
    """moto still requires boto3 to resolve *some* credentials; these never reach real AWS."""
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_SECURITY_TOKEN", "testing")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", AWS_REGION)


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
