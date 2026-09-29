import boto3
import pytest
from moto import mock_aws

from stores.trending_cache_archive_store import (
    S3TrendingCacheArchiveStore,
    TrendingCacheArchiveError,
    archive_key,
    get_archived_trending,
)

BUCKET = "test-history-bucket"
REGION = "ap-northeast-1"


@pytest.fixture
def archive_store(aws_credentials):
    with mock_aws():
        client = boto3.client("s3", region_name=REGION)
        client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})
        yield S3TrendingCacheArchiveStore(BUCKET, s3_client=client)


def test_archive_key_mirrors_the_dynamodb_cache_key_exactly():
    key = archive_key("org:vspo:1d:daily_trending:2026-09-01:Asia/Tokyo")

    assert key == "trending-cache-archive/org:vspo:1d:daily_trending:2026-09-01:Asia/Tokyo.json"


def test_put_then_get_round_trips_the_payload(archive_store):
    payload = {"organization": "vspo", "results": [{"rank": 1, "videoId": "v1"}]}

    archive_store.put("org:vspo:1d:daily_trending:2026-09-01:Asia/Tokyo", payload, computed_at="2026-09-01T18:00:00+09:00")

    assert archive_store.get("org:vspo:1d:daily_trending:2026-09-01:Asia/Tokyo") == payload


def test_get_returns_none_for_a_missing_key(archive_store):
    assert archive_store.get("no-such-key") is None


def test_put_overwrites_an_existing_key(archive_store):
    key = "creator:c1:1d:daily_trending:2026-09-01:Asia/Tokyo"
    archive_store.put(key, {"results": ["old"]}, computed_at="2026-09-01T18:00:00+09:00")

    archive_store.put(key, {"results": ["new"]}, computed_at="2026-09-02T18:00:00+09:00")

    assert archive_store.get(key) == {"results": ["new"]}


def test_from_environment_returns_none_when_bucket_not_configured(monkeypatch):
    monkeypatch.delenv("YOBI_HISTORY_BUCKET", raising=False)

    assert S3TrendingCacheArchiveStore.from_environment() is None


def test_from_environment_returns_a_store_when_bucket_configured(monkeypatch, aws_credentials):
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", BUCKET)

    store = S3TrendingCacheArchiveStore.from_environment()

    assert store is not None
    assert store.bucket_name == BUCKET


def test_get_archived_trending_is_none_when_not_configured(monkeypatch):
    monkeypatch.delenv("YOBI_HISTORY_BUCKET", raising=False)

    assert get_archived_trending("any-key") is None


def test_get_archived_trending_reads_a_real_archived_payload(monkeypatch, archive_store):
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", BUCKET)
    monkeypatch.setattr(
        "stores.trending_cache_archive_store.S3TrendingCacheArchiveStore.from_environment",
        classmethod(lambda cls, **kwargs: archive_store),
    )
    archive_store.put("k1", {"results": ["archived"]}, computed_at="2026-08-01T18:00:00+09:00")

    assert get_archived_trending("k1") == {"results": ["archived"]}


def test_put_raises_trending_cache_archive_error_when_bucket_is_missing(aws_credentials):
    with mock_aws():
        client = boto3.client("s3", region_name=REGION)
        store = S3TrendingCacheArchiveStore("does-not-exist-bucket", s3_client=client)
        with pytest.raises(TrendingCacheArchiveError):
            store.put("k1", {}, computed_at="2026-08-01T18:00:00+09:00")
