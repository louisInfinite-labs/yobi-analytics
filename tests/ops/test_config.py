"""SSM-only secret loading (ops/config.py): YouTube, Holodex, VAPID private key and admin key."""

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

# description as logged, getter, SSM locator env, plaintext local env, error class, parameter name
SECRETS = {
    "youtube": ("YouTube Data API key", get_api_key, "YOUTUBE_API_KEY_SSM_PARAMETER", "YOUTUBE_API_KEY", MissingAPIKeyError, "/yobi-analytics/youtube-api-key"),
    "holodex": ("Holodex API key", get_holodex_api_key, "HOLODEX_SSM_PARAMETER", "HOLODEX_API_KEY", MissingHolodexApiKeyError, "/yobi-analytics/holodex-api-key"),
    "admin": ("admin API key", get_admin_api_key, "YOBI_ADMIN_API_KEY_SSM_PARAMETER", "YOBI_ADMIN_API_KEY", MissingAdminApiKeyError, "/yobi-analytics/admin-api-key"),
    "vapid": ("VAPID private key", lambda: get_vapid_credentials()[0], "VAPID_PRIVATE_KEY_SSM_PARAMETER", "VAPID_PRIVATE_KEY", MissingVapidCredentialsError, "/yobi-analytics/vapid-private-key"),
}
LEGACY_SECRET_NAME_ENVS = ["YOUTUBE_API_KEY_SECRET_NAME", "HOLODEX_SECRET_NAME", "YOBI_ADMIN_API_KEY_SECRET_NAME", "VAPID_PRIVATE_KEY_SECRET_NAME"]


@pytest.fixture(autouse=True)
def clean_state(monkeypatch):
    """No locator set, no memoized key, no remembered log lines -- and a fixed region so moto and the fakes agree."""
    for _description, _getter, ssm_env, plain_env, *_ in SECRETS.values():
        monkeypatch.delenv(ssm_env, raising=False)
        monkeypatch.delenv(plain_env, raising=False)
    for name in LEGACY_SECRET_NAME_ENVS + ["VAPID_PRIVATE_KEY_PATH"]:
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


def _use(monkeypatch, key):
    entry = SECRETS[key]
    monkeypatch.setenv(entry[2], entry[5])
    return entry


class FakeSsm:
    """Replaces boto3.client inside ops.config: SSM raises `error` or returns `value`; any other service is a test failure."""

    def __init__(self, *, error=None, value=VALUE):
        self.error, self.value, self.calls = error, value, 0

    def __call__(self, service, **kwargs):
        assert service == "ssm", f"the runtime must only talk to SSM, not {service!r}"
        fake = self

        class _SSM:
            def get_parameter(self, Name, WithDecryption):  # noqa: N803 -- boto3's own keywords
                assert WithDecryption is True
                fake.calls += 1
                if fake.error is not None:
                    raise fake.error
                return {"Parameter": {"Value": fake.value}}

        return _SSM()


def client_error(code):
    return ClientError({"Error": {"Code": code, "Message": f"{code} (simulated)"}}, "GetParameter")


@pytest.mark.parametrize("key", list(SECRETS))
def test_the_ssm_parameter_is_read_with_decryption_and_the_source_is_logged_without_the_value(monkeypatch, capsys, key):
    description, getter, *_rest, parameter = _use(monkeypatch, key)
    with mock_aws():
        boto3.client("ssm", region_name=REGION).put_parameter(Name=parameter, Value=VALUE, Type="SecureString")

        assert getter() == VALUE

    captured = capsys.readouterr()
    assert f"secret source: {description} source=ssm" in captured.out
    assert VALUE not in captured.out + captured.err


@pytest.mark.parametrize("code", ["ParameterNotFound", "AccessDeniedException", "ThrottlingException", "InvalidKeyId"])
@pytest.mark.parametrize("key", list(SECRETS))
def test_an_unreadable_parameter_is_an_error_naming_the_parameter(monkeypatch, key, code):
    _description, getter, _s, _p, error_class, parameter = _use(monkeypatch, key)
    monkeypatch.setattr(config.boto3, "client", FakeSsm(error=client_error(code)))

    with pytest.raises(error_class, match=parameter):
        getter()


@pytest.mark.parametrize("key", list(SECRETS))
def test_a_network_level_failure_is_an_error(monkeypatch, key):
    _description, getter, _s, _p, error_class, _parameter = _use(monkeypatch, key)
    monkeypatch.setattr(config.boto3, "client", FakeSsm(error=EndpointConnectionError(endpoint_url="https://ssm.example")))

    with pytest.raises(error_class):
        getter()


@pytest.mark.parametrize("key", list(SECRETS))
def test_an_empty_parameter_value_is_an_error(monkeypatch, key):
    _description, getter, _s, _p, error_class, _parameter = _use(monkeypatch, key)
    monkeypatch.setattr(config.boto3, "client", FakeSsm(value=""))

    with pytest.raises(error_class, match="no value"):
        getter()


@pytest.mark.parametrize("key", list(SECRETS))
def test_the_retired_secrets_manager_locators_are_ignored_and_secrets_manager_is_never_called(monkeypatch, key):
    """Secrets Manager is gone from the runtime: a stale *_SECRET_NAME variable changes nothing (the fake fails the test on any non-SSM client)."""
    _description, getter, _s, _p, error_class, _parameter = SECRETS[key]
    for name in LEGACY_SECRET_NAME_ENVS:
        monkeypatch.setenv(name, "yobi-analytics/old-secret")
    monkeypatch.setattr(config.boto3, "client", FakeSsm())

    with pytest.raises(error_class):  # no SSM locator and no plaintext variable: nothing to read
        getter()


@pytest.mark.parametrize("key", list(SECRETS))
def test_neither_the_value_nor_the_error_text_of_a_failure_leaks_a_secret(monkeypatch, key):
    _description, getter, _s, _p, error_class, _parameter = _use(monkeypatch, key)
    monkeypatch.setattr(config.boto3, "client", FakeSsm(error=client_error("ThrottlingException"), value=VALUE))

    with pytest.raises(error_class) as raised:
        getter()

    assert VALUE not in str(raised.value)


@pytest.mark.parametrize("key", list(SECRETS))
def test_with_no_ssm_locator_the_local_plaintext_variable_is_used(monkeypatch, key):
    _description, getter, _s, plain_env, *_ = SECRETS[key]
    monkeypatch.setenv(plain_env, "local-dev-value")

    assert getter() == "local-dev-value"


@pytest.mark.parametrize("key", list(SECRETS))
def test_with_nothing_configured_every_getter_raises(monkeypatch, key):
    _description, getter, _s, _p, error_class, _parameter = SECRETS[key]

    with pytest.raises(error_class):
        getter()


def test_the_source_line_is_printed_once_per_process_not_on_every_call(monkeypatch, capsys):
    """get_admin_api_key / get_vapid_credentials are deliberately uncached (read on every request/run); their log must not repeat."""
    _use(monkeypatch, "admin")
    monkeypatch.setattr(config.boto3, "client", FakeSsm())

    for _ in range(3):
        assert get_admin_api_key() == VALUE

    assert capsys.readouterr().out.count("source=ssm") == 1


def test_a_rotated_admin_key_is_picked_up_on_the_very_next_call(monkeypatch):
    _use(monkeypatch, "admin")
    fake = FakeSsm(value="first")
    monkeypatch.setattr(config.boto3, "client", fake)
    assert get_admin_api_key() == "first"

    fake.value = "rotated"

    assert get_admin_api_key() == "rotated"


@pytest.mark.parametrize("key", ["youtube", "holodex"])
def test_the_cached_getters_remember_a_success_and_never_a_failure(monkeypatch, key):
    _description, getter, *_ = _use(monkeypatch, key)
    failing = FakeSsm(error=client_error("ThrottlingException"))
    monkeypatch.setattr(config.boto3, "client", failing)
    with pytest.raises((MissingAPIKeyError, MissingHolodexApiKeyError)):
        getter()  # the failure must not be remembered

    ok = FakeSsm(value="first-value")
    monkeypatch.setattr(config.boto3, "client", ok)
    assert getter() == "first-value"
    assert getter() == "first-value"
    assert ok.calls == 1  # the second call came from the cache


def test_the_vapid_private_key_comes_from_ssm_and_the_claims_stay_a_plain_setting(monkeypatch):
    _use(monkeypatch, "vapid")
    monkeypatch.setattr(config.boto3, "client", FakeSsm(value="-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"))

    private_key, claims = get_vapid_credentials()

    assert private_key.startswith("-----BEGIN PRIVATE KEY-----")
    assert claims == {"sub": "mailto:test@example.com"}


def test_the_vapid_claims_subject_is_still_required(monkeypatch):
    _use(monkeypatch, "vapid")
    monkeypatch.delenv("VAPID_CLAIMS_SUB")
    monkeypatch.setattr(config.boto3, "client", FakeSsm(value="pem"))

    with pytest.raises(MissingVapidCredentialsError, match="VAPID_CLAIMS_SUB"):
        get_vapid_credentials()
