from unittest.mock import patch

import boto3
import pytest
from moto import mock_aws

from ops import config
from ops.config import (
    MissingAdminApiKeyError,
    MissingAPIKeyError,
    MissingHolodexApiKeyError,
    MissingVapidCredentialsError,
    get_admin_api_key,
    get_api_key,
    get_holodex_api_key,
    get_vapid_credentials,
)

AWS_REGION = "ap-northeast-1"
SECRET_NAME = "yobi-analytics/youtube-api-key"
HOLODEX_SECRET_NAME = "yobi-analytics/holodex-api-key"
SSM_PARAMETER_NAME = "/yobi-analytics/youtube-api-key"


@pytest.fixture(autouse=True)
def reset_cache_and_env(monkeypatch):
    """Each test starts with no cached key and none of the env vars set."""
    monkeypatch.delenv("YOUTUBE_API_KEY", raising=False)
    monkeypatch.delenv("YOUTUBE_API_KEY_SECRET_NAME", raising=False)
    monkeypatch.delenv("YOUTUBE_API_KEY_SSM_PARAMETER", raising=False)
    get_api_key.cache_clear()
    yield
    get_api_key.cache_clear()


# --- AWS Cost Recovery (third pass, Scope I): SSM Parameter Store path -----
# Prepared but not cut over -- see ops/config.py's own module docstring.


def test_reads_from_ssm_when_ssm_parameter_is_set(monkeypatch):
    monkeypatch.setenv("YOUTUBE_API_KEY_SSM_PARAMETER", SSM_PARAMETER_NAME)
    with mock_aws():
        client = boto3.client("ssm", region_name=AWS_REGION)
        client.put_parameter(Name=SSM_PARAMETER_NAME, Value="ssm-key-value", Type="SecureString")

        assert get_api_key() == "ssm-key-value"


def test_ssm_parameter_takes_priority_over_secrets_manager_and_plaintext(monkeypatch):
    """The whole point of a controlled cutover: setting the new SSM env var
    alongside the old ones must prefer SSM, so an operator can migrate one
    secret at a time without any code change."""
    monkeypatch.setenv("YOUTUBE_API_KEY_SSM_PARAMETER", SSM_PARAMETER_NAME)
    monkeypatch.setenv("YOUTUBE_API_KEY_SECRET_NAME", SECRET_NAME)
    monkeypatch.setenv("YOUTUBE_API_KEY", "local-dev-key")
    with mock_aws():
        ssm = boto3.client("ssm", region_name=AWS_REGION)
        ssm.put_parameter(Name=SSM_PARAMETER_NAME, Value="ssm-key-value", Type="SecureString")
        secrets = boto3.client("secretsmanager", region_name=AWS_REGION)
        secrets.create_secret(Name=SECRET_NAME, SecretString="secret-key-value")

        assert get_api_key() == "ssm-key-value"


def test_setting_only_the_ssm_env_var_is_the_only_change_needed_no_code_change(monkeypatch):
    """Confirms the rollback story from the other direction: with the SSM env
    var unset (today's real deployed state), behavior is completely
    unaffected -- this migration is a pure no-op until an operator flips it."""
    monkeypatch.setenv("YOUTUBE_API_KEY_SECRET_NAME", SECRET_NAME)
    with mock_aws():
        client = boto3.client("secretsmanager", region_name=AWS_REGION)
        client.create_secret(Name=SECRET_NAME, SecretString="secret-key-value")

        assert get_api_key() == "secret-key-value"


def test_raises_missing_api_key_error_when_ssm_parameter_does_not_exist(monkeypatch):
    monkeypatch.setenv("YOUTUBE_API_KEY_SSM_PARAMETER", SSM_PARAMETER_NAME)
    with mock_aws():
        with pytest.raises(MissingAPIKeyError):
            get_api_key()


def test_ssm_failure_does_not_get_cached(monkeypatch):
    monkeypatch.setenv("YOUTUBE_API_KEY_SSM_PARAMETER", SSM_PARAMETER_NAME)
    with mock_aws():
        with pytest.raises(MissingAPIKeyError):
            get_api_key()

        client = boto3.client("ssm", region_name=AWS_REGION)
        client.put_parameter(Name=SSM_PARAMETER_NAME, Value="ssm-key-value", Type="SecureString")

        assert get_api_key() == "ssm-key-value"


def test_ssm_second_call_does_not_hit_ssm_again(monkeypatch):
    monkeypatch.setenv("YOUTUBE_API_KEY_SSM_PARAMETER", SSM_PARAMETER_NAME)
    with mock_aws():
        client = boto3.client("ssm", region_name=AWS_REGION)
        client.put_parameter(Name=SSM_PARAMETER_NAME, Value="ssm-key-value", Type="SecureString")

        with patch("boto3.client", wraps=boto3.client) as spy:
            first = get_api_key()
            second = get_api_key()

        assert first == second == "ssm-key-value"
        spy.assert_called_once()


def test_admin_api_key_reads_from_ssm_when_ssm_parameter_is_set(monkeypatch):
    parameter_name = "/yobi-analytics/admin-api-key"
    monkeypatch.setenv("YOBI_ADMIN_API_KEY_SSM_PARAMETER", parameter_name)
    with mock_aws():
        client = boto3.client("ssm", region_name=AWS_REGION)
        client.put_parameter(Name=parameter_name, Value="ssm-admin-value", Type="SecureString")

        assert get_admin_api_key() == "ssm-admin-value"


def test_admin_api_key_ssm_path_is_never_cached():
    """The whole reason get_admin_api_key isn't @functools.cache'd applies
    identically to its new SSM path: a rotated key must take effect on the
    very next request."""
    assert not hasattr(get_admin_api_key, "cache_clear")


def test_admin_api_key_raises_when_ssm_parameter_does_not_exist(monkeypatch):
    monkeypatch.setenv("YOBI_ADMIN_API_KEY_SSM_PARAMETER", "/yobi-analytics/admin-api-key")
    with mock_aws():
        with pytest.raises(MissingAdminApiKeyError):
            get_admin_api_key()


def test_vapid_credentials_read_from_ssm_when_ssm_parameter_is_set(monkeypatch):
    parameter_name = "/yobi-analytics/vapid-private-key"
    monkeypatch.setenv("VAPID_PRIVATE_KEY_SSM_PARAMETER", parameter_name)
    monkeypatch.setenv("VAPID_CLAIMS_SUB", "mailto:ops@example.com")
    with mock_aws():
        client = boto3.client("ssm", region_name=AWS_REGION)
        client.put_parameter(Name=parameter_name, Value="-----BEGIN PRIVATE KEY-----", Type="SecureString")

        private_key, claims = get_vapid_credentials()

        assert private_key == "-----BEGIN PRIVATE KEY-----"
        assert claims == {"sub": "mailto:ops@example.com"}


def test_vapid_credentials_raise_when_ssm_parameter_does_not_exist(monkeypatch):
    monkeypatch.setenv("VAPID_PRIVATE_KEY_SSM_PARAMETER", "/yobi-analytics/vapid-private-key")
    monkeypatch.setenv("VAPID_CLAIMS_SUB", "mailto:ops@example.com")
    with mock_aws():
        with pytest.raises(MissingVapidCredentialsError):
            get_vapid_credentials()


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
