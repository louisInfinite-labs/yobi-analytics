import boto3
import pytest
from botocore.exceptions import EndpointConnectionError
from moto import mock_aws

from stores import topic_catalog_store
from stores.topic_catalog_store import (
    TOPIC_CATALOG_TABLE,
    TopicCatalogStoreError,
    query_global_topics,
)

AWS_REGION = "ap-northeast-1"


@pytest.fixture
def catalog_table(aws_credentials):
    """Create the production-shaped Topic Catalog table inside moto's fully mocked DynamoDB."""
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


def test_an_empty_catalog_has_no_topics(catalog_table):
    assert query_global_topics() == []


def _put(tag, partition="GLOBAL", **extra):
    """Insert a raw record. The store is read-only by design (the catalog is curated by hand), so tests write items directly."""
    item = {"catalog_id": partition, "topic_tag": tag, "topic_zh": tag, "topic_en": tag, "topic_ja": tag, "display_order": 0, "search_aliases": []}
    item.update(extra)
    topic_catalog_store._resource().Table(TOPIC_CATALOG_TABLE).put_item(Item=item)


def test_the_store_exposes_no_writer():
    assert not hasattr(topic_catalog_store, "put_topic")  # nothing in this repo may write, seed or promote catalog records


def test_query_global_topics_is_scoped_to_the_global_partition_and_never_returns_review_records(catalog_table):
    _put("apex")
    _put("some_candidate", partition="REVIEW", review_status="pending", matched_video_count=3)
    _put("ignored", partition="SOME_OTHER_PARTITION")

    items = query_global_topics()

    assert [item["topic_tag"] for item in items] == ["apex"]


def test_query_global_topics_returns_the_optional_catalog_attributes_untouched(catalog_table):
    _put("peak", translation_review_status="pending_review", review_note="en/zh best guess", search_aliases=["peak"])

    [item] = query_global_topics()

    assert item["translation_review_status"] == "pending_review" and item["search_aliases"] == ["peak"]


def test_query_global_topics_handles_full_pagination(catalog_table, monkeypatch):
    """Force the Query to paginate one item at a time (small Limit), so the while LastEvaluatedKey loop in query_global_topics is
    actually exercised, not just present."""
    for i, topic_tag in enumerate(["valorant", "sf6", "apex", "minecraft", "singing", "mv", "chatting", "other"]):
        _put(topic_tag, display_order=i)

    table = topic_catalog_store._resource().Table(TOPIC_CATALOG_TABLE)
    original_query = type(table).query

    def _paginated_query(self, **kwargs):
        kwargs["Limit"] = 1
        return original_query(self, **kwargs)

    monkeypatch.setattr(type(table), "query", _paginated_query)

    items = query_global_topics()
    assert len(items) == 8


def test_query_global_topics_raises_store_error_when_table_is_missing(aws_credentials):
    with mock_aws():
        with pytest.raises(TopicCatalogStoreError):
            query_global_topics()


def test_query_global_topics_converts_a_botocore_error_too(monkeypatch):
    monkeypatch.setattr(topic_catalog_store, "_resource", lambda: (_ for _ in ()).throw(EndpointConnectionError(endpoint_url="https://dynamodb.example.invalid")))

    with pytest.raises(TopicCatalogStoreError):
        query_global_topics()