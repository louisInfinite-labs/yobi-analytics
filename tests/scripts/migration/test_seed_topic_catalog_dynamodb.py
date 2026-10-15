import boto3
import pytest
from moto import mock_aws

from scripts.migration import seed_topic_catalog_dynamodb as seed
from stores.topic_catalog_store import TOPIC_CATALOG_TABLE, query_global_topics
from tracking.video_topics import TOPICS

AWS_REGION = "ap-northeast-1"


@pytest.fixture
def catalog_table(aws_credentials):
    with mock_aws():
        client = boto3.client("dynamodb", region_name=AWS_REGION)
        client.create_table(
            TableName=TOPIC_CATALOG_TABLE,
            AttributeDefinitions=[
                {"AttributeName": "catalog_id", "AttributeType": "S"},
                {"AttributeName": "topic_tag", "AttributeType": "S"},
            ],
            KeySchema=[
                {"AttributeName": "catalog_id", "KeyType": "HASH"},
                {"AttributeName": "topic_tag", "KeyType": "RANGE"},
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        yield


def test_main_seeds_every_topics_entry_with_all_four_mandatory_fields(catalog_table):
    assert seed.main() == 0

    items = {item["topic_tag"]: item for item in query_global_topics()}
    assert set(items) == {topic.id for topic in TOPICS}
    for topic in TOPICS:
        item = items[topic.id]
        assert item["topic_zh"] == topic.labels["zh-TW"]
        assert item["topic_en"] == topic.labels["en"]
        assert item["topic_ja"] == topic.labels["ja"]


def test_main_preserves_the_canonical_display_order(catalog_table):
    seed.main()

    items = sorted(query_global_topics(), key=lambda item: item["display_order"])
    assert [item["topic_tag"] for item in items] == [topic.id for topic in TOPICS]


def test_main_is_idempotent_rerunning_does_not_duplicate_or_drift(catalog_table):
    seed.main()
    seed.main()

    items = query_global_topics()
    assert len(items) == len(TOPICS)


def test_main_returns_nonzero_when_a_topic_ends_up_missing(catalog_table, monkeypatch):
    """Simulates a catalog that fell out of sync with TOPICS (e.g. a manual edit) --
    main()'s own post-seed verification must fail loudly, not report success."""
    from stores import topic_catalog_store

    original_query = topic_catalog_store.query_global_topics
    monkeypatch.setattr(seed, "query_global_topics", lambda: [item for item in original_query() if item["topic_tag"] != "other"])

    assert seed.main() == 1
