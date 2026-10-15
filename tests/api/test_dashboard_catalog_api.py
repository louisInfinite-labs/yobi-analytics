import json

import boto3
import pytest
from moto import mock_aws

from api import dashboard_catalog_api
from api.api_handler import lambda_handler
from stores.topic_catalog_store import TOPIC_CATALOG_TABLE, put_topic
from tracking.video_topics import TOPICS

AWS_REGION = "ap-northeast-1"

# Backward compatibility only -- see api.dashboard_catalog_api.get_topics' own
# docstring. Kept here (as the seed script also does) only to seed the mocked
# catalog with the same historical `label` values production has.
_LEGACY_TOPIC_LABELS: dict[str, str] = {
    "valorant": "VALORANT",
    "sf6": "SF6",
    "apex": "APEX",
    "minecraft": "Minecraft",
    "singing": "Singing",
    "mv": "MV",
    "chatting": "Chatting",
    "other": "Other",
}


@pytest.fixture
def topic_catalog_table(aws_credentials):
    """Create the production-shaped Topic Catalog table, seeded exactly like
    scripts/migration/seed_topic_catalog_dynamodb.py seeds the real one from TOPICS,
    so GET /topics' DynamoDB-backed response can be exercised end to end."""
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
        for display_order, topic in enumerate(TOPICS):
            put_topic(
                topic_tag=topic.id,
                topic_zh=topic.labels["zh-TW"],
                topic_en=topic.labels["en"],
                topic_ja=topic.labels["ja"],
                display_order=display_order,
                legacy_label=_LEGACY_TOPIC_LABELS.get(topic.id),
                search_aliases=topic.search_aliases,
            )
        yield


def _event(route_key, *, query=None):
    return {"routeKey": route_key, "queryStringParameters": query, "pathParameters": None, "body": None, "headers": {}}


def _body(response):
    return json.loads(response["body"])


# --- GET /dashboard/chart-catalog -----------------------------------------


def test_chart_catalog_returns_200_with_the_current_addable_charts_in_order():
    response = lambda_handler(_event("GET /dashboard/chart-catalog"), None)

    assert response["statusCode"] == 200
    assert response["headers"]["Content-Type"] == "application/json"
    assert _body(response) == {
        "charts": [
            {"chartDefinitionId": "subscriber-leaderboard", "title": "Subscriber Leaderboard"},
            {"chartDefinitionId": "creator-video-ranking", "title": "Creator Video Ranking"},
        ]
    }


def test_chart_catalog_is_deterministic_across_calls():
    first = lambda_handler(_event("GET /dashboard/chart-catalog"), None)
    second = lambda_handler(_event("GET /dashboard/chart-catalog"), None)

    assert first["body"] == second["body"]


def test_chart_catalog_ids_are_unique_and_non_empty():
    ids = [chart["chartDefinitionId"] for chart in _body(lambda_handler(_event("GET /dashboard/chart-catalog"), None))["charts"]]

    assert len(ids) == len(set(ids))
    assert all(ids)


def test_chart_catalog_exposes_only_the_fields_the_add_ui_needs():
    for chart in dashboard_catalog_api.get_chart_catalog()["charts"]:
        assert set(chart) == {"chartDefinitionId", "title"}


def test_unsupported_method_or_path_on_the_catalog_is_a_404():
    assert lambda_handler(_event("POST /dashboard/chart-catalog"), None)["statusCode"] == 404
    assert lambda_handler(_event("GET /dashboard/chart-catalogs"), None)["statusCode"] == 404


# R8B (AWS Cost Recovery): GET /dashboard/comparison-items/comparison-data
# coverage removed here -- see test_api_gateway_routes.py's own
# test_removed_comparison_routes_are_no_longer_exposed for the route-removal
# regression guard.


# --- GET /topics -------------------------------------------------------------


def test_topics_returns_the_canonical_list_in_display_order(topic_catalog_table):
    """Shape/order/content check against the REAL, current TOPICS (however large it has grown) --
    deliberately not a hardcoded literal, since that would need editing every time a topic is
    added. The original-8 byte-for-byte backward-compat pin lives in its own isolated test below,
    independent of how large TOPICS grows."""
    response = lambda_handler(_event("GET /topics"), None)

    assert response["statusCode"] == 200
    assert response["headers"]["Content-Type"] == "application/json"
    expected = {
        "topics": [
            {
                "id": topic.id,
                "label": _LEGACY_TOPIC_LABELS.get(topic.id, topic.labels["en"]),
                "labels": dict(topic.labels),
                "searchAliases": list(topic.search_aliases),
            }
            for topic in TOPICS
        ]
    }
    assert _body(response) == expected
    # Pinned against the real TOPICS source itself too, so this test cannot drift from it silently.
    assert [t["id"] for t in _body(response)["topics"]] == [topic.id for topic in TOPICS]


def test_topics_label_matches_the_endpoints_pre_labels_contract_byte_for_byte(aws_credentials):
    """`label` is additive-only backward compatibility (see this file's own
    _LEGACY_TOPIC_LABELS, which the seed script also uses) -- this pins it to
    the exact strings the endpoint returned before `labels` existed, for the
    original 8 topics specifically. Seeds its OWN isolated table with just
    those 8 (not the shared topic_catalog_table fixture, which seeds every
    current TOPICS entry) so this pin stays meaningful no matter how large
    the taxonomy grows later."""
    original_eight = [topic for topic in TOPICS if topic.id in _LEGACY_TOPIC_LABELS]
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
        for display_order, topic in enumerate(original_eight):
            put_topic(
                topic_tag=topic.id,
                topic_zh=topic.labels["zh-TW"],
                topic_en=topic.labels["en"],
                topic_ja=topic.labels["ja"],
                display_order=display_order,
                legacy_label=_LEGACY_TOPIC_LABELS.get(topic.id),
                search_aliases=topic.search_aliases,
            )

        response = lambda_handler(_event("GET /topics"), None)
        labels_by_id = {topic["id"]: topic["label"] for topic in _body(response)["topics"]}

    assert labels_by_id == {
        "valorant": "VALORANT",
        "sf6": "SF6",
        "apex": "APEX",
        "minecraft": "Minecraft",
        "singing": "Singing",
        "mv": "MV",
        "chatting": "Chatting",
        "other": "Other",
    }


def test_topics_label_is_never_the_frontends_source_and_falls_back_safely_for_an_unmapped_future_topic(aws_credentials):
    """A topic added after `labels` existed has no historical `legacy_label` stored for it --
    confirms the fallback (English label, else id) rather than a KeyError."""
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
        put_topic("asmr", "ASMR", "ASMR", "ASMR", display_order=0)

        response = lambda_handler(_event("GET /topics"), None)
        assert _body(response) == {"topics": [{"id": "asmr", "label": "ASMR", "labels": {"zh-TW": "ASMR", "en": "ASMR", "ja": "ASMR"}, "searchAliases": []}]}


def test_topics_is_stable_across_calls(topic_catalog_table):
    assert dashboard_catalog_api.get_topics() == dashboard_catalog_api.get_topics({"ignored": "x"})


def test_topics_raises_when_the_catalog_table_is_missing(aws_credentials):
    from stores.topic_catalog_store import TopicCatalogStoreError

    with mock_aws():
        with pytest.raises(TopicCatalogStoreError):
            dashboard_catalog_api.get_topics()
