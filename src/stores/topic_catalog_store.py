"""DynamoDB-backed storage for the global video topic catalog (Home Topic Catalog).

One item per topic tag under a single partition ("GLOBAL") -- {catalog_id,
topic_tag, topic_zh, topic_en, topic_ja, legacy_label, search_aliases,
display_order}. GET /topics (api.dashboard_catalog_api.get_topics) queries
this table instead of iterating tracking.video_topics.TOPICS directly, so the
canonical topic list lives in one place a Lambda can read without a
YobiVideoMaster scan. The taxonomy itself (ids, match patterns, labels) still
lives in video_topics.TOPICS -- this store only holds what GET /topics needs
to serve, kept in sync by scripts/migration/seed_topic_catalog_dynamodb.py.
"""

from __future__ import annotations

import os
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import BotoCoreError, ClientError

TOPIC_CATALOG_TABLE = os.environ.get("YOBI_TOPIC_CATALOG_TABLE") or "YobiTopicCatalog"

GLOBAL_CATALOG_ID = "GLOBAL"


class TopicCatalogStoreError(Exception):
    """Raised when the DynamoDB Topic Catalog table is unreachable or malformed."""


_cached_resource = None


def _resource():
    """Return a cached boto3 DynamoDB resource, using the ambient AWS credentials/region.

    See client_credential_store.py's own _resource() for why this is cached
    at module level rather than constructed fresh per call.
    """
    global _cached_resource
    if _cached_resource is None:
        _cached_resource = boto3.resource("dynamodb")
    return _cached_resource


def query_global_topics() -> list[dict[str, Any]]:
    """Return every catalog_id=GLOBAL item, fully paginated, in insertion (not sort-key) order
    is NOT guaranteed here -- callers must sort by each item's own `display_order` attribute
    to recover the canonical display/match-precedence order (Query returns topic_tag's lexical
    sort-key order, which is unrelated)."""
    try:
        table = _resource().Table(TOPIC_CATALOG_TABLE)
        response = table.query(KeyConditionExpression=Key("catalog_id").eq(GLOBAL_CATALOG_ID))
        items = list(response.get("Items", []))
        while "LastEvaluatedKey" in response:
            response = table.query(
                KeyConditionExpression=Key("catalog_id").eq(GLOBAL_CATALOG_ID),
                ExclusiveStartKey=response["LastEvaluatedKey"],
            )
            items.extend(response.get("Items", []))
        return items
    except (ClientError, BotoCoreError) as exc:
        raise TopicCatalogStoreError(f"Failed to read {TOPIC_CATALOG_TABLE}: {exc}") from exc


def put_topic(
    topic_tag: str,
    topic_zh: str,
    topic_en: str,
    topic_ja: str,
    display_order: int,
    legacy_label: str | None = None,
    search_aliases: tuple[str, ...] = (),
) -> None:
    """Upsert one topic's catalog record. A plain PutItem, not conditional: re-running the seed
    script for an already-seeded topic must replace its item with the current labels/aliases/order
    rather than erroring, so this is idempotent by full-item overwrite on the same (catalog_id,
    topic_tag) key -- never a second, duplicate item."""
    item: dict[str, Any] = {
        "catalog_id": GLOBAL_CATALOG_ID,
        "topic_tag": topic_tag,
        "topic_zh": topic_zh,
        "topic_en": topic_en,
        "topic_ja": topic_ja,
        "display_order": display_order,
        "search_aliases": list(search_aliases),
    }
    if legacy_label is not None:
        item["legacy_label"] = legacy_label
    try:
        table = _resource().Table(TOPIC_CATALOG_TABLE)
        table.put_item(Item=item)
    except (ClientError, BotoCoreError) as exc:
        raise TopicCatalogStoreError(f"Failed to write to {TOPIC_CATALOG_TABLE}: {exc}") from exc
