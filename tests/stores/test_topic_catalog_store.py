import boto3
import pytest
from botocore.exceptions import EndpointConnectionError
from moto import mock_aws

from stores import topic_catalog_store
from stores.topic_catalog_store import (
    TOPIC_CATALOG_TABLE,
    TopicCatalogStoreError,
    put_topic,
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


def test_put_topic_makes_it_readable_with_all_four_mandatory_fields(catalog_table):
    put_topic("singing", "歌回", "Singing", "歌枠", display_order=4)

    [item] = query_global_topics()
    assert item["topic_tag"] == "singing"
    assert item["topic_zh"] == "歌回"
    assert item["topic_en"] == "Singing"
    assert item["topic_ja"] == "歌枠"


def test_put_topic_stores_optional_legacy_label_and_search_aliases(catalog_table):
    put_topic("apex", "Apex", "Apex", "Apex", display_order=2, legacy_label="APEX", search_aliases=("apex", "apex legends"))

    [item] = query_global_topics()
    assert item["legacy_label"] == "APEX"
    assert list(item["search_aliases"]) == ["apex", "apex legends"]


def test_put_topic_omits_legacy_label_entirely_when_not_given(catalog_table):
    put_topic("other", "其他", "Other", "その他", display_order=7)

    [item] = query_global_topics()
    assert "legacy_label" not in item
    assert list(item["search_aliases"]) == []


def test_put_topic_is_idempotent_a_second_call_overwrites_not_duplicates(catalog_table):
    put_topic("mv", "MV", "MV", "MV", display_order=5)
    put_topic("mv", "MV", "Music Video", "MV", display_order=5)

    items = query_global_topics()
    assert len(items) == 1
    assert items[0]["topic_en"] == "Music Video"


def test_query_global_topics_is_scoped_to_the_global_partition(catalog_table):
    put_topic("apex", "Apex", "Apex", "Apex", display_order=2)
    table = topic_catalog_store._resource().Table(TOPIC_CATALOG_TABLE)
    table.put_item(Item={"catalog_id": "SOME_OTHER_PARTITION", "topic_tag": "ignored", "topic_zh": "x", "topic_en": "x", "topic_ja": "x", "display_order": 0, "search_aliases": []})

    items = query_global_topics()
    assert [item["topic_tag"] for item in items] == ["apex"]


def test_query_global_topics_handles_full_pagination(catalog_table, monkeypatch):
    """Force the Query to paginate one item at a time (small Limit), so the while
    LastEvaluatedKey loop in query_global_topics is actually exercised, not just present."""
    for i, topic_tag in enumerate(["valorant", "sf6", "apex", "minecraft", "singing", "mv", "chatting", "other"]):
        put_topic(topic_tag, topic_tag, topic_tag, topic_tag, display_order=i)

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


def test_put_topic_raises_store_error_when_table_is_missing(aws_credentials):
    with mock_aws():
        with pytest.raises(TopicCatalogStoreError):
            put_topic("other", "其他", "Other", "その他", display_order=7)


def test_query_global_topics_converts_a_botocore_error_too(monkeypatch):
    monkeypatch.setattr(topic_catalog_store, "_resource", lambda: (_ for _ in ()).throw(EndpointConnectionError(endpoint_url="https://dynamodb.example.invalid")))

    with pytest.raises(TopicCatalogStoreError):
        query_global_topics()


def test_put_topic_converts_a_botocore_error_too(monkeypatch):
    monkeypatch.setattr(topic_catalog_store, "_resource", lambda: (_ for _ in ()).throw(EndpointConnectionError(endpoint_url="https://dynamodb.example.invalid")))

    with pytest.raises(TopicCatalogStoreError):
        put_topic("other", "其他", "Other", "その他", display_order=7)
