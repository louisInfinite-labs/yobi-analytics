"""SSM-first secret loading with the controlled Secrets Manager fallback used while the migration is in flight (ops/config.py)."""

from __future__ import annotations

import boto3
import pytest
from botocore.exceptions import ClientError, EndpointConnectionError
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

REGION = "ap-northeast-1"
VALUE = "S3CRET-VALUE-MUST-NEVER-BE-LOGGED"
OLD_VALUE = "OLD-SECRETS-MANAGER-VALUE"

# description as logged, getter, SSM locator env, Secrets Manager locator env, error class, a parameter name, a secret name
SECRETS = {
    "youtube": ("YouTube Data API key", get_api_key, "YOUTUBE_API_KEY_SSM_PARAMETER", "YOUTUBE_API_KEY_SECRET_NAME", MissingAPIKeyError, "/yobi-analytics/youtube-api-key", "yobi-analytics/youtube-api-key"),
    "holodex": ("Holodex API key", get_holodex_api_key, "HOLODEX_SSM_PARAMETER", "HOLODEX_SECRET_NAME", MissingHolodexApiKeyError, "/yobi-analytics/holodex-api-key", "yobi-analytics/holodex-api-key"),
    "admin": ("admin API key", get_admin_api_key, "YOBI_ADMIN_API_KEY_SSM_PARAMETER", "YOBI_ADMIN_API_KEY_SECRET_NAME", MissingAdminApiKeyError, "/yobi-analytics/admin-api-key", "yobi-analytics/admin-api-key"),
    "vapid": ("VAPID private key", lambda: get_vapid_credentials()[0], "VAPID_PRIVATE_KEY_SSM_PARAMETER", "VAPID_PRIVATE_KEY_SECRET_NAME", MissingVapidCredentialsError, "/yobi-analytics/vapid-private-key", "yobi-analytics/vapid-private-key"),
}
ALL_LOCATOR_ENVS = [
    "YOUTUBE_API_KEY", "YOUTUBE_API_KEY_SSM_PARAMETER", "YOUTUBE_API_KEY_SECRET_NAME",
    "HOLODEX_API_KEY", "HOLODEX_SSM_PARAMETER", "HOLODEX_SECRET_NAME",
    "YOBI_ADMIN_API_KEY", "YOBI_ADMIN_API_KEY_SSM_PARAMETER", "YOBI_ADMIN_API_KEY_SECRET_NAME",
    "VAPID_PRIVATE_KEY", "VAPID_PRIVATE_KEY_PATH", "VAPID_PRIVATE_KEY_SSM_PARAMETER", "VAPID_PRIVATE_KEY_SECRET_NAME",
]


@pytest.fixture(autouse=True)
def clean_state(monkeypatch):
    """No locator set, no memoized key, no remembered log lines -- and a fixed region so moto and the fakes agree."""
    for name in ALL_LOCATOR_ENVS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("VAPID_CLAIMS_SUB", "mailto:test@example.com")
    monkeypatch.setenv("AWS_DEFAULT_REGION", REGION)
    get_api_key.cache_clear()
    get_holodex_api_key.cache_clear()
    config._logged_sources.clear()
    yield
    get_api_key.cache_clear()
    get_holodex_api_key.cache_clear()
    config._logged_sources.clear()


def _use(monkeypatch, key, *, ssm=True, secret=True):
    _description, _getter, ssm_env, secret_env, _error, parameter, secret_name = SECRETS[key]
    if ssm:
        monkeypatch.setenv(ssm_env, parameter)
    if secret:
        monkeypatch.setenv(secret_env, secret_name)
    return SECRETS[key]


class FakeClients:
    """Replaces boto3.client inside ops.config: SSM raises `ssm_error` (or returns `ssm_value`), Secrets Manager returns `secret_value`."""

    def __init__(self, *, ssm_error=None, ssm_value=VALUE, secret_value=OLD_VALUE):
        self.ssm_error, self.ssm_value, self.secret_value = ssm_error, ssm_value, secret_value
        self.secretsmanager_calls = 0

    def __call__(self, service, **kwargs):
        fake = self

        class _SSM:
            def get_parameter(self, Name, WithDecryption):  # noqa: N803 -- boto3's own keywords
                assert WithDecryption is True
                if fake.ssm_error is not None:
                    raise fake.ssm_error
                return {"Parameter": {"Value": fake.ssm_value}}

        class _SecretsManager:
            def get_secret_value(self, SecretId):  # noqa: N803
                fake.secretsmanager_calls += 1
                return {"SecretString": fake.secret_value}

        return {"ssm": _SSM, "secretsmanager": _SecretsManager}[service]()


def client_error(code):
    return ClientError({"Error": {"Code": code, "Message": f"{code} (simulated)"}}, "GetParameter")


@pytest.mark.parametrize("key", list(SECRETS))
def test_the_ssm_parameter_is_used_and_the_source_is_logged_without_the_value(monkeypatch, capsys, key):
    description, getter, _s, _n, _e, parameter, _name = _use(monkeypatch, key, secret=False)
    with mock_aws():
        boto3.client("ssm", region_name=REGION).put_parameter(Name=parameter, Value=VALUE, Type="SecureString")

        assert getter() == VALUE

    captured = capsys.readouterr()
    assert f"secret source: {description} source=ssm" in captured.out
    assert VALUE not in captured.out + captured.err


@pytest.mark.parametrize("key", list(SECRETS))
def test_ssm_wins_over_secrets_manager_when_both_exist(monkeypatch, key):
    _description, getter, _s, _n, _e, parameter, secret_name = _use(monkeypatch, key)
    with mock_aws():
        boto3.client("ssm", region_name=REGION).put_parameter(Name=parameter, Value=VALUE, Type="SecureString")
        boto3.client("secretsmanager", region_name=REGION).create_secret(Name=secret_name, SecretString=OLD_VALUE)

        assert getter() == VALUE


@pytest.mark.parametrize("key", list(SECRETS))
def test_a_parameter_that_does_not_exist_yet_falls_back_to_the_old_secret_and_says_so(monkeypatch, capsys, key):
    description, getter, _s, _n, _e, _parameter, secret_name = _use(monkeypatch, key)
    with mock_aws():
        boto3.client("secretsmanager", region_name=REGION).create_secret(Name=secret_name, SecretString=OLD_VALUE)

        assert getter() == OLD_VALUE

    out = capsys.readouterr().out
    assert f"secret source: {description} source=secretsmanager fallback_reason=ssm_ParameterNotFound" in out
    assert OLD_VALUE not in out


@pytest.mark.parametrize("key", list(SECRETS))
def test_a_role_that_cannot_read_the_parameter_yet_falls_back_to_the_old_secret(monkeypatch, capsys, key):
    description, getter, *_ = _use(monkeypatch, key)
    fake = FakeClients(ssm_error=client_error("AccessDeniedException"))
    monkeypatch.setattr(config.boto3, "client", fake)

    assert getter() == OLD_VALUE

    assert fake.secretsmanager_calls == 1
    assert f"secret source: {description} source=secretsmanager fallback_reason=ssm_AccessDeniedException" in capsys.readouterr().out


@pytest.mark.parametrize("code", ["ThrottlingException", "InternalServerError", "InvalidKeyId", "ParameterVersionNotFound", "ValidationException"])
@pytest.mark.parametrize("key", list(SECRETS))
def test_any_other_ssm_failure_is_a_real_error_and_never_falls_back(monkeypatch, key, code):
    _description, getter, _s, _n, error_class, parameter, _name = _use(monkeypatch, key)
    fake = FakeClients(ssm_error=client_error(code))
    monkeypatch.setattr(config.boto3, "client", fake)

    with pytest.raises(error_class, match=parameter):
        getter()

    assert fake.secretsmanager_calls == 0  # the old secret is NOT consulted for an arbitrary failure


@pytest.mark.parametrize("key", list(SECRETS))
def test_a_network_level_read_failure_is_a_real_error_and_never_falls_back(monkeypatch, key):
    _description, getter, _s, _n, error_class, _parameter, _name = _use(monkeypatch, key)
    fake = FakeClients(ssm_error=EndpointConnectionError(endpoint_url="https://ssm.example"))
    monkeypatch.setattr(config.boto3, "client", fake)

    with pytest.raises(error_class):
        getter()

    assert fake.secretsmanager_calls == 0


@pytest.mark.parametrize("key", list(SECRETS))
def test_an_empty_parameter_value_is_malformed_and_never_falls_back(monkeypatch, key):
    _description, getter, _s, _n, error_class, parameter, _name = _use(monkeypatch, key)
    fake = FakeClients(ssm_value="")
    monkeypatch.setattr(config.boto3, "client", fake)

    with pytest.raises(error_class, match="no value"):
        getter()

    assert fake.secretsmanager_calls == 0


@pytest.mark.parametrize("code", ["ParameterNotFound", "AccessDeniedException"])
@pytest.mark.parametrize("key", list(SECRETS))
def test_without_an_old_secret_locator_even_the_fallback_codes_are_errors(monkeypatch, key, code):
    """After the cutover (no *_SECRET_NAME) a missing / unreadable parameter must fail loudly, not silently use something else."""
    _description, getter, _s, _n, error_class, parameter, _name = _use(monkeypatch, key, secret=False)
    monkeypatch.setattr(config.boto3, "client", FakeClients(ssm_error=client_error(code)))

    with pytest.raises(error_class, match=parameter):
        getter()


@pytest.mark.parametrize("key", list(SECRETS))
def test_neither_the_value_nor_the_old_value_appears_in_error_messages(monkeypatch, key):
    _description, getter, _s, _n, error_class, _parameter, _name = _use(monkeypatch, key)
    monkeypatch.setattr(config.boto3, "client", FakeClients(ssm_error=client_error("ThrottlingException"), ssm_value=VALUE))

    with pytest.raises(error_class) as raised:
        getter()

    assert VALUE not in str(raised.value) and OLD_VALUE not in str(raised.value)


def test_the_source_line_is_printed_once_per_process_not_on_every_call(monkeypatch, capsys):
    """get_admin_api_key / get_vapid_credentials are deliberately uncached (read on every request/run); their log must not repeat."""
    _use(monkeypatch, "admin", secret=False)
    monkeypatch.setattr(config.boto3, "client", FakeClients())

    for _ in range(3):
        assert get_admin_api_key() == VALUE

    assert capsys.readouterr().out.count("source=ssm") == 1


def test_a_rotated_admin_key_is_picked_up_on_the_very_next_call(monkeypatch):
    _use(monkeypatch, "admin", secret=False)
    fake = FakeClients(ssm_value="first")
    monkeypatch.setattr(config.boto3, "client", fake)
    assert get_admin_api_key() == "first"

    fake.ssm_value = "rotated"

    assert get_admin_api_key() == "rotated"


def test_the_holodex_key_is_cached_after_a_successful_ssm_read_and_a_failure_is_not(monkeypatch):
    _use(monkeypatch, "holodex", secret=False)
    failing = FakeClients(ssm_error=client_error("ThrottlingException"))
    monkeypatch.setattr(config.boto3, "client", failing)
    with pytest.raises(MissingHolodexApiKeyError):
        get_holodex_api_key()  # the failure must not be remembered

    monkeypatch.setattr(config.boto3, "client", FakeClients(ssm_value="holodex-value"))
    assert get_holodex_api_key() == "holodex-value"

    monkeypatch.setattr(config.boto3, "client", FakeClients(ssm_error=client_error("ThrottlingException")))
    assert get_holodex_api_key() == "holodex-value"  # served from the cache, SSM not asked again


def test_the_vapid_private_key_comes_from_ssm_and_the_claims_stay_a_plain_setting(monkeypatch):
    _use(monkeypatch, "vapid", secret=False)
    monkeypatch.setattr(config.boto3, "client", FakeClients(ssm_value="-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"))

    private_key, claims = get_vapid_credentials()

    assert private_key.startswith("-----BEGIN PRIVATE KEY-----")
    assert claims == {"sub": "mailto:test@example.com"}


def test_with_no_deployed_locator_the_local_plaintext_variables_still_work(monkeypatch):
    monkeypatch.setenv("YOUTUBE_API_KEY", "local-dev-key")
    monkeypatch.setenv("HOLODEX_API_KEY", "local-holodex")
    monkeypatch.setenv("YOBI_ADMIN_API_KEY", "local-admin")
    monkeypatch.setenv("VAPID_PRIVATE_KEY", "local-pem")

    assert get_api_key() == "local-dev-key"
    assert get_holodex_api_key() == "local-holodex"
    assert get_admin_api_key() == "local-admin"
    assert get_vapid_credentials()[0] == "local-pem"
