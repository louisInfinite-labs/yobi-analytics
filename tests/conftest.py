import json
from pathlib import Path

import pytest

from tracking import video_topics

_CATALOG_FIXTURE = Path(__file__).parent / "fixtures" / "topic_catalog_global.json"


def load_global_topic_catalog_fixture() -> list[dict]:
    """The production GLOBAL Topic Catalog snapshot (tests/fixtures/topic_catalog_global.json): what GET /topics, classification and
    topic validation read in tests, so they see production-shaped data and never touch DynamoDB."""
    return json.loads(_CATALOG_FIXTURE.read_text(encoding="utf-8"))["items"]


# Installed at import time (before any test module is collected), because some modules read the live topic ids while parametrizing.
video_topics.set_catalog_loader(load_global_topic_catalog_fixture)


@pytest.fixture(autouse=True)
def topic_catalog_fixture():
    """Every test starts on the GLOBAL snapshot with an empty taxonomy cache; a test that needs a different catalog calls
    video_topics.set_catalog_loader(...) itself (this fixture restores the default afterwards)."""
    video_topics.set_catalog_loader(load_global_topic_catalog_fixture)
    yield
    video_topics.set_catalog_loader(load_global_topic_catalog_fixture)

@pytest.fixture(autouse=True)
def premiere_archive_times_cache_is_reset():
    """The API caches the durable Premiere availability times per warm Lambda; no test may see another test's cached record."""
    from api import read_api

    read_api.clear_premiere_archive_times_cache()
    yield
    read_api.clear_premiere_archive_times_cache()


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
def no_real_provisional_discovery_sources(monkeypatch):
    """Home's provisional new-video overlay reads discovery events and Video Master records; no test may reach DynamoDB through it. A test
    that exercises the overlay patches api.provisional_discoveries._events_for_date / _records_for itself."""
    from api import provisional_discoveries

    provisional_discoveries.clear_cache()
    monkeypatch.setattr(provisional_discoveries, "_events_for_date", lambda event_date, moment: [])
    monkeypatch.setattr(provisional_discoveries, "_records_for", lambda video_ids, moment: {})
    yield
    provisional_discoveries.clear_cache()


@pytest.fixture(autouse=True)
def unknown_live_snapshot_freshness_for_the_dispatcher(monkeypatch):
    """The notification dispatcher asks the shared live snapshot how fresh it is (one small DynamoDB read) to decide whether its derived stream
    schedule is current. Its tests stub the stores at module level, so that read would reach for a real table: default it to "unknown", which
    selects the time-based fallback rule. A test of the snapshot-following behaviour overrides _read_source_refreshed_at itself."""
    from notifications import notification_dispatcher
    from stores import notification_delivery_log_store

    monkeypatch.setattr(notification_dispatcher, "_read_source_refreshed_at", lambda: None)
    # Same reason for the legacy-row check (a delivery-log read): default "no recent legacy row"; a test about it overrides handled_within.
    monkeypatch.setattr(notification_delivery_log_store, "handled_within", lambda *args, **kwargs: False)


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
