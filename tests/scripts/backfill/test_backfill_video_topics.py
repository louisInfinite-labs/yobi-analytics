import importlib.util
import sys
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

_MODULE_PATH = Path(__file__).resolve().parents[3] / "scripts" / "backfill" / "backfill_video_topics.py"
_spec = importlib.util.spec_from_file_location("backfill_video_topics", _MODULE_PATH)
backfill_video_topics = importlib.util.module_from_spec(_spec)
sys.modules.setdefault("backfill_video_topics", backfill_video_topics)
_spec.loader.exec_module(backfill_video_topics)

from stores.dynamodb_store import VIDEO_MASTER_TABLE  # noqa: E402

AWS_REGION = "ap-northeast-1"


@pytest.fixture
def table(aws_credentials):
    with mock_aws():
        client = boto3.client("dynamodb", region_name=AWS_REGION)
        client.create_table(
            TableName=VIDEO_MASTER_TABLE,
            AttributeDefinitions=[{"AttributeName": "videoId", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "videoId", "KeyType": "HASH"}],
            BillingMode="PAY_PER_REQUEST",
        )
        yield boto3.resource("dynamodb", region_name=AWS_REGION).Table(VIDEO_MASTER_TABLE)


def _put(table, video_id, title, **extra):
    table.put_item(Item={"videoId": video_id, "creatorId": "c1", "title": title, "snapshotCount": 4, **extra})


def _topics(table):
    return {item["videoId"]: item.get("topic") for item in table.scan()["Items"]}


def _seed(table):
    _put(table, "v1", "【VALORANT】ランク")
    _put(table, "v2", "マイクラ建築")
    _put(table, "v3", "お知らせ")
    _put(table, "v4", "【VALORANT】already tagged as chatting", topic="chatting")


def test_dry_run_reports_and_writes_nothing(table):
    _seed(table)

    summary = backfill_video_topics.backfill_topics(execute=False, reclassify=False)

    assert _topics(table) == {"v1": None, "v2": None, "v3": None, "v4": "chatting"}
    assert summary["scanned"] == 4
    assert summary["alreadyClassified"] == 1
    assert summary["missingTopic"] == 3
    assert summary["wouldUpdate"] == 3
    assert summary["updated"] == 0
    assert summary["errors"] == 0


def test_execute_classifies_missing_topics_and_skips_valid_existing_ones(table):
    _seed(table)

    summary = backfill_video_topics.backfill_topics(execute=True, reclassify=False)

    assert _topics(table) == {"v1": "valorant", "v2": "minecraft", "v3": "other", "v4": "chatting"}
    assert summary["updated"] == 3
    assert summary["topicCounts"] == {"minecraft": 1, "other": 1, "valorant": 1}
    assert summary["otherCount"] == 1


def test_execute_leaves_every_other_field_untouched(table):
    _put(table, "v1", "【VALORANT】ランク", lastViewCount=99)

    backfill_video_topics.backfill_topics(execute=True, reclassify=False)

    item = table.get_item(Key={"videoId": "v1"})["Item"]
    assert (item["snapshotCount"], item["lastViewCount"], item["creatorId"]) == (4, 99, "c1")


def test_second_execute_run_rewrites_nothing(table):
    _seed(table)
    backfill_video_topics.backfill_topics(execute=True, reclassify=False)

    second = backfill_video_topics.backfill_topics(execute=True, reclassify=False)

    assert (second["alreadyClassified"], second["missingTopic"], second["wouldUpdate"], second["updated"]) == (4, 0, 0, 0)
    assert second["topicCounts"] == {}


def test_malformed_records_are_counted_and_do_not_stop_the_run(table):
    _put(table, "v1", "【VALORANT】ランク")
    table.put_item(Item={"videoId": "no_title", "creatorId": "c1"})
    _put(table, "blank_title", "   ")
    _put(table, "bad_topic", "雑談", topic="not_a_topic")

    summary = backfill_video_topics.backfill_topics(execute=True, reclassify=False)

    assert summary["errors"] == 3
    assert summary["updated"] == 1
    assert _topics(table)["v1"] == "valorant"
    assert _topics(table)["bad_topic"] == "not_a_topic"


def test_reclassify_rewrites_only_topics_that_change(table):
    _put(table, "changes", "【VALORANT】ランク", topic="chatting")
    _put(table, "same", "マイクラ建築", topic="minecraft")
    _put(table, "invalid", "雑談", topic="not_a_topic")

    first = backfill_video_topics.backfill_topics(execute=True, reclassify=True)

    assert _topics(table) == {"changes": "valorant", "same": "minecraft", "invalid": "chatting"}
    assert (first["wouldUpdate"], first["updated"], first["alreadyClassified"], first["errors"]) == (2, 2, 1, 0)

    second = backfill_video_topics.backfill_topics(execute=True, reclassify=True)

    assert (second["wouldUpdate"], second["updated"], second["alreadyClassified"]) == (0, 0, 3)


def test_main_defaults_to_a_dry_run(table, capsys):
    _seed(table)

    assert backfill_video_topics.main([]) == 0

    assert "DRY RUN" in capsys.readouterr().out
    assert _topics(table)["v1"] is None
