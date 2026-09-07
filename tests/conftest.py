import pytest

import config


@pytest.fixture(autouse=True)
def aws_credentials(monkeypatch):
    """moto still requires boto3 to resolve *some* credentials; these never reach real AWS.

    Shared across every test module that mocks AWS (DynamoDB, Secrets Manager, etc.) via
    moto — previously copy-pasted byte-for-byte into 8 separate test files.
    """
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_SECURITY_TOKEN", "testing")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "ap-northeast-1")


@pytest.fixture(autouse=True)
def reset_admin_api_key_cache():
    """get_admin_api_key() is @functools.cache'd (Secrets Manager calls are worth memoizing
    within a warm Lambda container) — without clearing it here, whichever test in the whole
    suite happens to call it successfully first would silently poison every later test that
    expects a fresh env-var/Secrets-Manager read, since pytest runs all tests in one process.
    """
    config.get_admin_api_key.cache_clear()
    yield
    config.get_admin_api_key.cache_clear()
