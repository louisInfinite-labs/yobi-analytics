import importlib.util
import json
import sys
from datetime import date
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

_MODULE_PATH = Path(__file__).resolve().parents[3] / "scripts" / "backfill" / "realign_video_ranking_topics.py"
_spec = importlib.util.spec_from_file_location("realign_video_ranking_topics", _MODULE_PATH)
realign_mod = importlib.util.module_from_spec(_spec)
sys.modules.setdefault("realign_video_ranking_topics", realign_mod)
_spec.loader.exec_module(realign_mod)

from stores.history_store import shard_for_video  # noqa: E402
from stores.video_ranking_store import video_ranking_key  # noqa: E402
from tracking.tracking_manifest import ManifestEntry, S3TrackingManifestStore  # noqa: E402

AWS_REGION = "ap-northeast-1"
BUCKET = "test-history-bucket"
DATE = "2026-10-05"
OLDER_DATE = "2026-10-04"


@pytest.fixture
def s3(aws_credentials, monkeypatch):
    monkeypatch.delenv("YOBI_HISTORY_BUCKET", raising=False)
    with mock_aws():
        client = boto3.client("s3", region_name=AWS_REGION)
        client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": AWS_REGION})
        yield client


def _entry(video_id, topic):
    return ManifestEntry(
        video_id, "c1", active=True, discovered_at="2026-07-01T00:00:00Z", published_at="2026-06-01T00:00:00Z",
        activity_state="Hot", title="t", thumbnail_url=None, content_type="upload", live_status=None, topic=topic,
    )


def _seed_manifest(s3, topics):
    store = S3TrackingManifestStore(BUCKET, s3_client=s3)
    by_shard = {}
    for video_id, topic in topics.items():
        by_shard.setdefault(shard_for_video(video_id), []).append(_entry(video_id, topic))
    for shard, entries in by_shard.items():
        store.write_shard(shard, entries)
    return store


def _row(video_id, topic, **extra):
    return {"videoId": video_id, "creatorId": "c1", "topic": topic, "title": video_id, "currentViewCount": 10, **extra}


def _put_result(s3, report_date, creator, rows, **extra):
    payload = {"schemaVersion": 2, "reportDate": report_date, "creatorId": creator, "generatedAt": "g", "videos": rows, **extra}
    s3.put_object(Bucket=BUCKET, Key=video_ranking_key(date.fromisoformat(report_date), creator), Body=json.dumps(payload).encode())
    return payload


def _read(s3, report_date, creator):
    key = video_ranking_key(date.fromisoformat(report_date), creator)
    return json.loads(s3.get_object(Bucket=BUCKET, Key=key)["Body"].read())


def _run(s3, store, **kwargs):
    kwargs.setdefault("report_dates", None)
    return realign_mod.realign(s3_client=s3, bucket=BUCKET, manifest_store=store, **kwargs)


def test_dry_run_reports_transitions_and_writes_nothing(s3):
    store = _seed_manifest(s3, {"a": "mv", "b": "mv", "c": "singing"})
    original = _put_result(s3, DATE, "c1", [_row("a", "other"), _row("b", "singing"), _row("c", "singing")])

    summary = _run(s3, store, execute=False, only_topic="mv")

    assert summary["topicTransitions"] == {"other->mv": 1, "singing->mv": 1}
    assert (summary["resultsScanned"], summary["resultsChanged"], summary["rowsChanged"], summary["written"]) == (1, 1, 2, 0)
    assert summary["status"] == "DRY RUN"
    assert _read(s3, DATE, "c1") == original


def test_execute_rewrites_only_the_topic_of_changed_rows_and_is_idempotent(s3):
    store = _seed_manifest(s3, {"a": "mv", "b": "singing", "c": "valorant"})
    _put_result(s3, DATE, "c1", [_row("a", "other", publishedAt="p"), _row("b", "singing"), _row("c", "chatting")])

    first = _run(s3, store, execute=True, only_topic="mv")
    after = _read(s3, DATE, "c1")

    assert [row["topic"] for row in after["videos"]] == ["mv", "singing", "chatting"]  # c: unrelated, untouched
    assert after["videos"][0] == _row("a", "mv", publishedAt="p")  # no other field changed
    assert (after["schemaVersion"], after["generatedAt"], after["reportDate"]) == (2, "g", DATE)
    assert first["status"] == "COMPLETE" and first["written"] == 1

    second = _run(s3, store, execute=True, only_topic="mv")

    assert second["rowsChanged"] == 0 and second["written"] == 0 and second["topicTransitions"] == {}
    assert _read(s3, DATE, "c1") == after


def test_only_the_newest_report_date_is_touched_by_default(s3):
    store = _seed_manifest(s3, {"a": "mv"})
    _put_result(s3, OLDER_DATE, "c1", [_row("a", "other")])
    _put_result(s3, DATE, "c1", [_row("a", "other")])

    summary = _run(s3, store, execute=True)

    assert summary["reportDates"] == [DATE]
    assert _read(s3, DATE, "c1")["videos"][0]["topic"] == "mv"
    assert _read(s3, OLDER_DATE, "c1")["videos"][0]["topic"] == "other"


def test_an_explicit_report_date_is_honoured(s3):
    store = _seed_manifest(s3, {"a": "mv"})
    _put_result(s3, OLDER_DATE, "c1", [_row("a", "other")])
    _put_result(s3, DATE, "c1", [_row("a", "other")])

    _run(s3, store, execute=True, report_dates=[OLDER_DATE])

    assert _read(s3, OLDER_DATE, "c1")["videos"][0]["topic"] == "mv"
    assert _read(s3, DATE, "c1")["videos"][0]["topic"] == "other"


def test_a_row_without_a_valid_manifest_topic_is_never_downgraded(s3):
    store = _seed_manifest(s3, {"a": None, "b": "mv"})  # a: manifest not backfilled; c: not in the manifest at all
    _put_result(s3, DATE, "c1", [_row("a", "singing"), _row("c", "valorant"), _row("b", "other")])

    _run(s3, store, execute=True)

    assert [row["topic"] for row in _read(s3, DATE, "c1")["videos"]] == ["singing", "valorant", "mv"]


def test_an_object_with_nothing_to_change_is_not_written(s3, monkeypatch):
    store = _seed_manifest(s3, {"a": "mv"})
    _put_result(s3, DATE, "c1", [_row("a", "mv")])
    puts = []
    real_put = s3.put_object
    monkeypatch.setattr(s3, "put_object", lambda **kw: puts.append(kw) or real_put(**kw))

    summary = _run(s3, store, execute=True)

    assert puts == [] and summary["resultsChanged"] == 0


def test_a_concurrently_rewritten_result_is_skipped_not_overwritten(s3, monkeypatch):
    store = _seed_manifest(s3, {"a": "mv"})
    _put_result(s3, DATE, "c1", [_row("a", "other")])
    real_get = s3.get_object

    def racing_get(**kwargs):
        response = real_get(**kwargs)
        if kwargs["Key"].startswith("video-ranking/"):
            _put_result(s3, DATE, "c1", [_row("a", "other")], generatedAt="newer")  # the reducer rewrote it meanwhile
        return response

    monkeypatch.setattr(s3, "get_object", racing_get)

    summary = _run(s3, store, execute=True)

    assert summary["skippedConcurrent"] == 1 and summary["written"] == 0
    assert summary["status"].startswith("PARTIAL")
    assert _read(s3, DATE, "c1")["generatedAt"] == "newer"


def test_an_empty_manifest_aborts_with_zero_writes(s3):
    store = S3TrackingManifestStore(BUCKET, s3_client=s3)
    _put_result(s3, DATE, "c1", [_row("a", "other")])

    summary = _run(s3, store, execute=True)

    assert summary["status"] == "FAILED" and "preflight" in summary["abortedReason"]
    assert _read(s3, DATE, "c1")["videos"][0]["topic"] == "other"


def test_main_requires_an_explicit_bucket_and_yes_for_execute(s3, monkeypatch, capsys):
    assert realign_mod.main([]) == 2
    assert "never defaults to a bucket" in capsys.readouterr().out

    monkeypatch.setenv("YOBI_HISTORY_BUCKET", BUCKET)
    assert realign_mod.main(["--execute"]) == 2
    assert "without --yes" in capsys.readouterr().out


def test_main_rejects_a_report_file_inside_the_repo_and_a_malformed_date(s3, monkeypatch, capsys):
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", BUCKET)

    assert realign_mod.main(["--report-file", str(realign_mod.REPO_ROOT / "report.json")]) == 2
    assert "outside the repository" in capsys.readouterr().out
    assert realign_mod.main(["--report-date", "10/05/2026"]) == 2
