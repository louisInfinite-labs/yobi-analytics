"""Real-S3 (moto) tests for stores.video_ranking_store (video-ranking Phase
C) -- one deterministic JSON object per (report date, creator), S3 only.
"""

from datetime import date

import boto3
import pytest
from moto import mock_aws

from stores.video_ranking_store import S3VideoRankingStore, video_ranking_key

BUCKET = "test-history-bucket"
REGION = "ap-northeast-1"
DAY = date(2026, 9, 29)


@pytest.fixture
def s3_store(aws_credentials):
    with mock_aws():
        client = boto3.client("s3", region_name=REGION)
        client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})
        yield S3VideoRankingStore(BUCKET, s3_client=client)


def test_video_ranking_key_is_one_object_per_date_and_creator():
    assert video_ranking_key(DAY, "aizawa_ema") == "video-ranking/date=2026-09-29/creator=aizawa_ema.json"


def test_read_returns_none_when_absent(s3_store):
    assert s3_store.read_result(DAY, "aizawa_ema") is None


def test_write_then_read_roundtrips_the_payload(s3_store):
    payload = {"reportDate": "2026-09-29", "creatorId": "aizawa_ema", "total": {"rows": []}}

    key = s3_store.write_result(DAY, "aizawa_ema", payload)

    assert key == "video-ranking/date=2026-09-29/creator=aizawa_ema.json"
    read_back = s3_store.read_result(DAY, "aizawa_ema")
    assert read_back["creatorId"] == "aizawa_ema"
    assert read_back["schemaVersion"] == 2


def test_same_date_rebuild_deterministically_replaces_not_appends(s3_store):
    s3_store.write_result(DAY, "aizawa_ema", {"reportDate": "2026-09-29", "observedVideoCount": 10})
    s3_store.write_result(DAY, "aizawa_ema", {"reportDate": "2026-09-29", "observedVideoCount": 12})

    read_back = s3_store.read_result(DAY, "aizawa_ema")
    assert read_back["observedVideoCount"] == 12  # rebuild replaced the stale one, no second object


def test_two_creators_on_the_same_date_are_independent_objects(s3_store):
    other_day_creator = "usada_pekora"
    s3_store.write_result(DAY, "aizawa_ema", {"reportDate": "2026-09-29", "creatorId": "aizawa_ema"})
    s3_store.write_result(DAY, other_day_creator, {"reportDate": "2026-09-29", "creatorId": other_day_creator})

    assert s3_store.read_result(DAY, "aizawa_ema")["creatorId"] == "aizawa_ema"
    assert s3_store.read_result(DAY, other_day_creator)["creatorId"] == other_day_creator


def test_two_different_dates_for_the_same_creator_are_independent_objects(s3_store):
    other_day = date(2026, 9, 28)
    s3_store.write_result(DAY, "aizawa_ema", {"reportDate": "2026-09-29"})
    s3_store.write_result(other_day, "aizawa_ema", {"reportDate": "2026-09-28"})

    assert s3_store.read_result(DAY, "aizawa_ema")["reportDate"] == "2026-09-29"
    assert s3_store.read_result(other_day, "aizawa_ema")["reportDate"] == "2026-09-28"


def test_from_environment_returns_none_when_bucket_not_configured(monkeypatch):
    monkeypatch.delenv("YOBI_HISTORY_BUCKET", raising=False)

    assert S3VideoRankingStore.from_environment() is None


def test_from_environment_returns_a_store_when_bucket_configured(monkeypatch, aws_credentials):
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", BUCKET)
    with mock_aws():
        store = S3VideoRankingStore.from_environment()
        assert store is not None
        assert store.bucket_name == BUCKET
