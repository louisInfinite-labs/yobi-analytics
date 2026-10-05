import pytest


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


class _InMemoryLiveStreamsStore:
    """A per-test, in-memory stand-in for the shared /live-streams cache so no test ever reaches S3."""

    last_read_source = "l1"

    def __init__(self):
        self.entry = None

    def read(self):
        return self.entry

    def write(self, entry):
        self.entry = entry


@pytest.fixture(autouse=True)
def isolated_live_streams_cache(monkeypatch):
    """Each test gets a fresh, empty /live-streams cache (SEC-API-005); production uses the S3-backed shared store."""
    from api import read_api

    monkeypatch.setattr(read_api, "_LIVE_STREAMS_STORE", _InMemoryLiveStreamsStore())
