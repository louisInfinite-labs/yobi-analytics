"""Real-S3 (moto) tests for stores.subscriber_ranking_store (ranking-
simplification, R4) -- one deterministic JSON object per report date, S3
only, no DynamoDB/TrendingCache involvement at all.
"""

from datetime import date

import boto3
import pytest
from moto import mock_aws

from stores.subscriber_ranking_store import (
    S3SubscriberRankingStore,
    SubscriberRankingStoreError,
    subscriber_ranking_key,
)

BUCKET = "test-history-bucket"
REGION = "ap-northeast-1"
DAY = date(2026, 9, 29)


@pytest.fixture
def s3_store(aws_credentials):
    with mock_aws():
        client = boto3.client("s3", region_name=REGION)
        client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})
        yield S3SubscriberRankingStore(BUCKET, s3_client=client)


def test_subscriber_ranking_key_has_no_shard_or_metric_or_org_segment():
    assert subscriber_ranking_key(DAY) == "subscriber-ranking/date=2026-09-29.json"


def test_read_returns_none_when_absent(s3_store):
    assert s3_store.read_result(DAY) is None


def test_write_then_read_roundtrips_the_payload(s3_store):
    payload = {"reportDate": "2026-09-29", "total": {"rows": [], "ineligible": {}}}

    key = s3_store.write_result(DAY, payload)

    assert key == "subscriber-ranking/date=2026-09-29.json"
    read_back = s3_store.read_result(DAY)
    assert read_back["reportDate"] == "2026-09-29"
    assert read_back["schemaVersion"] == 1


def test_same_date_rebuild_deterministically_replaces_not_appends(s3_store):
    s3_store.write_result(DAY, {"reportDate": "2026-09-29", "observedCreatorCount": 100})
    s3_store.write_result(DAY, {"reportDate": "2026-09-29", "observedCreatorCount": 118})

    read_back = s3_store.read_result(DAY)
    assert read_back["observedCreatorCount"] == 118  # improved rebuild replaced the stale one


def test_two_different_dates_are_independent_objects(s3_store):
    other_day = date(2026, 9, 28)
    s3_store.write_result(DAY, {"reportDate": "2026-09-29"})
    s3_store.write_result(other_day, {"reportDate": "2026-09-28"})

    assert s3_store.read_result(DAY)["reportDate"] == "2026-09-29"
    assert s3_store.read_result(other_day)["reportDate"] == "2026-09-28"


def test_from_environment_requires_the_history_bucket_env_var(monkeypatch):
    monkeypatch.delenv("YOBI_HISTORY_BUCKET", raising=False)

    with pytest.raises(SubscriberRankingStoreError, match="YOBI_HISTORY_BUCKET"):
        S3SubscriberRankingStore.from_environment()
