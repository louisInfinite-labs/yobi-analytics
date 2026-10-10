import pytest


@pytest.fixture(autouse=True)
def no_real_youtube_classification(monkeypatch):
    """GET /live-streams asks the YouTube Data API about unclassified upcoming streams; no test may ever do that for real (a local .env
    may hold a real key). A test that needs the lookup patches api.livestream_classification._fetch_classifications itself."""
    from api import livestream_classification

    def _blocked(video_ids):
        raise RuntimeError("the real YouTube Data API is not available in tests")

    livestream_classification.clear_cache()
    monkeypatch.setattr(livestream_classification, "_fetch_classifications", _blocked)
    yield
    livestream_classification.clear_cache()


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
