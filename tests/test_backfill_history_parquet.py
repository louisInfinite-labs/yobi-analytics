"""Regression coverage for scripts/backfill_history_parquet.py.

Guards the safety properties this one-time local staging backfill is built
around: it reads YobiSnapshots exactly once, stages only the 15
confirmed-complete dates, measures (never stages, never repairs) the
known-partial 2026-09-14 date, tolerates -- without aborting or
contaminating the staged output -- any other date it encounters (e.g. later
collection days already in the table), refuses to trust its own scan if
YobiRunSummaries changed underneath it, never fabricates a row for a video
that was never actually collected, persists raw per-date scan forensics to
disk even when a later check aborts the run, and produces Parquet output
byte-identical in format to the production S3 history pipeline
(history_store.py).
"""

from __future__ import annotations

import importlib.util
import json
import sys
from datetime import date
from decimal import Decimal
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

_MODULE_PATH = Path(__file__).resolve().parent.parent / "scripts" / "backfill_history_parquet.py"
_spec = importlib.util.spec_from_file_location("backfill_history_parquet", _MODULE_PATH)
backfill_history_parquet = importlib.util.module_from_spec(_spec)
sys.modules.setdefault("backfill_history_parquet", backfill_history_parquet)
_spec.loader.exec_module(backfill_history_parquet)

from stores.history_store import HISTORY_SHARD_COUNT, daily_history_key, deserialize_history_rows, shard_for_video  # noqa: E402

AWS_REGION = "ap-northeast-1"
STAGE_DATES = sorted(backfill_history_parquet.stage_dates())
FIRST_DATE = STAGE_DATES[0]
SECOND_DATE = STAGE_DATES[1]
MEASURE_ONLY_DATE = backfill_history_parquet.MEASURE_ONLY_DATE
OUTSIDE_APPROVED_DATE = "2026-09-20"  # after MEASURE_ONLY_DATE: a later production day


@pytest.fixture
def dynamodb_tables(aws_credentials):
    with mock_aws():
        client = boto3.client("dynamodb", region_name=AWS_REGION)
        client.create_table(
            TableName=backfill_history_parquet.SNAPSHOTS_TABLE,
            AttributeDefinitions=[
                {"AttributeName": "videoId", "AttributeType": "S"},
                {"AttributeName": "snapshotDate", "AttributeType": "S"},
            ],
            KeySchema=[
                {"AttributeName": "videoId", "KeyType": "HASH"},
                {"AttributeName": "snapshotDate", "KeyType": "RANGE"},
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        client.create_table(
            TableName=backfill_history_parquet.RUN_SUMMARIES_TABLE,
            AttributeDefinitions=[{"AttributeName": "snapshotDate", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "snapshotDate", "KeyType": "HASH"}],
            BillingMode="PAY_PER_REQUEST",
        )
        resource = boto3.resource("dynamodb", region_name=AWS_REGION)
        yield resource


def _seed_all_approved_run_summaries(resource, *, overrides: dict[str, int] | None = None) -> None:
    """Every required date (15 stage dates + the measure-only date) needs a
    YobiRunSummaries row -- run_backfill refuses to even start scanning
    otherwise (UnexpectedDateError). Defaults every date's collectedCount to
    0; `overrides` sets specific dates."""
    overrides = overrides or {}
    table = resource.Table(backfill_history_parquet.RUN_SUMMARIES_TABLE)
    for collection_date in backfill_history_parquet.REQUIRED_RUN_SUMMARY_DATES:
        table.put_item(
            Item={
                "snapshotDate": collection_date,
                "requestedCount": overrides.get(collection_date, 0),
                "collectedCount": overrides.get(collection_date, 0),
                "skippedCount": 0,
                "skipped": [],
            }
        )


def _put_snapshot(resource, *, video_id, snapshot_date, creator_id="some_creator", view_count=100, observed_at="2026-08-30T12:00:00+09:00", title="t", published_at="2026-01-01T00:00:00Z", organization="org"):
    resource.Table(backfill_history_parquet.SNAPSHOTS_TABLE).put_item(
        Item={
            "videoId": video_id,
            "snapshotDate": snapshot_date,
            "creatorId": creator_id,
            "viewCount": Decimal(view_count),
            "observedAt": observed_at,
            "title": title,
            "publishedAt": published_at,
            "organization": organization,
        }
    )


def _new_forensics() -> "backfill_history_parquet.ScanForensics":
    return backfill_history_parquet.ScanForensics(
        stage_counts={collection_date: 0 for collection_date in backfill_history_parquet.stage_dates()}
    )


def test_snapshot_to_history_row_transformation():
    raw_item = {
        "videoId": "vidABC",
        "snapshotDate": FIRST_DATE,
        "creatorId": "some_creator",
        "viewCount": Decimal("4242"),
        "observedAt": "2026-08-30T18:00:00+09:00",
        "title": "irrelevant",
        "publishedAt": "2025-01-01T00:00:00Z",
        "organization": "org",
    }
    snapshot_date, row = backfill_history_parquet._history_row_from_snapshot_item(raw_item)
    assert snapshot_date == FIRST_DATE
    assert row.video_id == "vidABC"
    assert row.creator_id == "some_creator"
    assert row.view_count == 4242
    assert isinstance(row.view_count, int)
    assert row.observed_at == "2026-08-30T18:00:00+09:00"
    assert row.availability_status == "available"


def test_deterministic_shard_mapping(tmp_path, dynamodb_tables):
    """A video bucketed by scan_snapshots_into_spool must land in exactly the
    shard shard_for_video says it belongs to -- never a different one."""
    video_id = "shardCheckVideo"
    _put_snapshot(dynamodb_tables, video_id=video_id, snapshot_date=FIRST_DATE)
    _seed_all_approved_run_summaries(dynamodb_tables, overrides={FIRST_DATE: 1})

    spool_root = tmp_path / "_raw_spool"
    spool = backfill_history_parquet.RawSpool(spool_root, backfill_history_parquet.stage_dates())
    forensics = _new_forensics()
    try:
        backfill_history_parquet.scan_snapshots_into_spool(
            dynamodb_tables.Table(backfill_history_parquet.SNAPSHOTS_TABLE),
            spool,
            backfill_history_parquet.stage_dates(),
            forensics,
        )
    finally:
        spool.close_all()

    assert forensics.stage_counts[FIRST_DATE] == 1
    expected_shard = shard_for_video(video_id)
    populated_path = spool.path_for(FIRST_DATE, expected_shard)
    assert populated_path.read_text(encoding="utf-8").strip() != ""
    for shard in range(HISTORY_SHARD_COUNT):
        if shard != expected_shard:
            assert spool.path_for(FIRST_DATE, shard).read_text(encoding="utf-8") == ""
    spool.cleanup()


def test_parquet_round_trip_and_schema(tmp_path, dynamodb_tables):
    video_id = "roundTripVideo"
    _put_snapshot(dynamodb_tables, video_id=video_id, snapshot_date=FIRST_DATE, creator_id="creatorX", view_count=999, observed_at="2026-08-30T09:00:00+09:00")
    _seed_all_approved_run_summaries(dynamodb_tables, overrides={FIRST_DATE: 1})

    staging_root = tmp_path / "staging"
    report = backfill_history_parquet.run_backfill(staging_root, dynamodb_resource=dynamodb_tables)

    assert report.ok
    assert report.total_staged_rows == 1
    shard = shard_for_video(video_id)
    output_path = staging_root / daily_history_key(date.fromisoformat(FIRST_DATE), shard)
    assert output_path.exists()
    rows = deserialize_history_rows(output_path.read_bytes())
    assert len(rows) == 1
    assert rows[0].video_id == video_id
    assert rows[0].creator_id == "creatorX"
    assert rows[0].view_count == 999
    assert rows[0].availability_status == "available"


def test_missing_required_run_summary_date_refuses_to_scan(tmp_path, dynamodb_tables):
    """If YobiRunSummaries is missing a row for any required date (a stage
    date or the measure-only date), run_backfill must refuse to even begin
    scanning."""
    table = dynamodb_tables.Table(backfill_history_parquet.RUN_SUMMARIES_TABLE)
    for collection_date in backfill_history_parquet.REQUIRED_RUN_SUMMARY_DATES:
        if collection_date == MEASURE_ONLY_DATE:
            continue  # deliberately omit this one
        table.put_item(Item={"snapshotDate": collection_date, "requestedCount": 0, "collectedCount": 0, "skippedCount": 0, "skipped": []})

    staging_root = tmp_path / "staging"
    with pytest.raises(backfill_history_parquet.UnexpectedDateError):
        backfill_history_parquet.run_backfill(staging_root, dynamodb_resource=dynamodb_tables)


def test_extra_run_summary_dates_do_not_abort(tmp_path, dynamodb_tables):
    """YobiRunSummaries legitimately has rows beyond the required range once
    collection continues past 09-14 (e.g. 09-15). Their presence must not
    abort the run -- this is the real production state T2.7E must tolerate."""
    _seed_all_approved_run_summaries(dynamodb_tables)
    dynamodb_tables.Table(backfill_history_parquet.RUN_SUMMARIES_TABLE).put_item(
        Item={
            "snapshotDate": OUTSIDE_APPROVED_DATE,
            "requestedCount": 500,
            "collectedCount": 500,
            "skippedCount": 0,
            "skipped": [],
        }
    )

    staging_root = tmp_path / "staging"
    report = backfill_history_parquet.run_backfill(staging_root, dynamodb_resource=dynamodb_tables)

    assert report.ok


def test_source_count_changed_during_scan_marks_result_invalid(tmp_path, dynamodb_tables, monkeypatch):
    """Simulates a concurrent collection run committing between the pre-scan
    and post-scan YobiRunSummaries reads -- the defining race this backfill
    must refuse to silently accept."""
    _put_snapshot(dynamodb_tables, video_id="raceVideo", snapshot_date=FIRST_DATE)
    _seed_all_approved_run_summaries(dynamodb_tables, overrides={FIRST_DATE: 1})

    real_scan = backfill_history_parquet.scan_snapshots_into_spool

    def scan_then_mutate(table, spool, dates, forensics):
        real_scan(table, spool, dates, forensics)
        # Simulate a real collector run completing mid-backfill: bump this
        # date's collectedCount, exactly like a concurrent write would.
        dynamodb_tables.Table(backfill_history_parquet.RUN_SUMMARIES_TABLE).update_item(
            Key={"snapshotDate": FIRST_DATE},
            UpdateExpression="SET collectedCount = :c",
            ExpressionAttributeValues={":c": 2},
        )

    monkeypatch.setattr(backfill_history_parquet, "scan_snapshots_into_spool", scan_then_mutate)

    staging_root = tmp_path / "staging"
    with pytest.raises(backfill_history_parquet.SourceCountChangedError) as excinfo:
        backfill_history_parquet.run_backfill(staging_root, dynamodb_resource=dynamodb_tables)
    assert excinfo.value.forensics.stage_counts[FIRST_DATE] == 1


def test_never_fabricates_a_row_for_a_video_with_no_snapshots(tmp_path, dynamodb_tables):
    """The Elizabeth/Gigi case: a video that legitimately has zero YobiSnapshots
    rows across the whole staged range must produce zero HistoryRows in
    every date's shard -- never a viewCount=0 placeholder, never any row."""
    _seed_all_approved_run_summaries(dynamodb_tables)  # every date collectedCount=0, nothing to scan

    staging_root = tmp_path / "staging"
    report = backfill_history_parquet.run_backfill(staging_root, dynamodb_resource=dynamodb_tables)

    assert report.ok
    assert report.total_staged_rows == 0
    assert report.parquet_file_count == len(STAGE_DATES) * HISTORY_SHARD_COUNT

    for collection_date in STAGE_DATES:
        for shard in range(HISTORY_SHARD_COUNT):
            path = staging_root / daily_history_key(date.fromisoformat(collection_date), shard)
            assert path.exists()
            assert deserialize_history_rows(path.read_bytes()) == []


def test_duplicate_video_within_shard_is_rejected(tmp_path, dynamodb_tables):
    """Structurally impossible via a real DynamoDB scan (videoId+snapshotDate
    is the table's own primary key), but build_date_shard_parquet's own
    duplicate guard is tested directly against a hand-crafted spool file."""
    dates = backfill_history_parquet.stage_dates()
    spool_root = tmp_path / "_raw_spool"
    spool = backfill_history_parquet.RawSpool(spool_root, dates)
    video_id = "dupeVideo"
    shard = shard_for_video(video_id)
    row = backfill_history_parquet.HistoryRow(
        video_id=video_id, creator_id="c", view_count=1, observed_at="2026-08-30T00:00:00Z", availability_status="available"
    )
    spool.write(FIRST_DATE, shard, row)
    spool.write(FIRST_DATE, shard, row)
    spool.close_all()

    with pytest.raises(backfill_history_parquet.DuplicateVideoError):
        backfill_history_parquet.build_date_shard_parquet(spool, FIRST_DATE, shard, tmp_path / "staging")


def test_measure_only_date_reports_shortfall_without_staging(tmp_path, dynamodb_tables):
    """2026-09-14 (or whatever MEASURE_ONLY_DATE is): count actual rows, never
    stage them, never raise on the known mismatch, and report the exact
    shortfall against the RunSummaries-intended count."""
    _seed_all_approved_run_summaries(dynamodb_tables, overrides={MEASURE_ONLY_DATE: 5})
    for i in range(3):
        _put_snapshot(dynamodb_tables, video_id=f"partialVid{i}", snapshot_date=MEASURE_ONLY_DATE)

    staging_root = tmp_path / "staging"
    report = backfill_history_parquet.run_backfill(staging_root, dynamodb_resource=dynamodb_tables)

    assert report.ok
    assert report.measure_only_date == MEASURE_ONLY_DATE
    assert report.measure_only_intended_count == 5
    assert report.measure_only_actual_count == 3
    assert report.measure_only_shortfall == 2

    for shard in range(HISTORY_SHARD_COUNT):
        path = staging_root / daily_history_key(date.fromisoformat(MEASURE_ONLY_DATE), shard)
        assert not path.exists()


def test_dates_after_measure_only_are_reported_not_staged(tmp_path, dynamodb_tables):
    """A later production date (e.g. 2026-09-15+) found mid-scan must be
    counted and reported separately -- never staged, never aborting the run,
    never contaminating the 15-date staging baseline."""
    _seed_all_approved_run_summaries(dynamodb_tables)
    _put_snapshot(dynamodb_tables, video_id="futureVideo", snapshot_date=OUTSIDE_APPROVED_DATE)

    staging_root = tmp_path / "staging"
    report = backfill_history_parquet.run_backfill(staging_root, dynamodb_resource=dynamodb_tables)

    assert report.ok
    assert report.other_dates == {OUTSIDE_APPROVED_DATE: 1}
    assert report.date_count == len(STAGE_DATES)
    assert report.parquet_file_count == len(STAGE_DATES) * HISTORY_SHARD_COUNT
    assert report.total_staged_rows == 0


def test_forensics_log_persisted_even_when_mismatch_aborts(tmp_path, dynamodb_tables):
    """The 2026-09-14 incident this backfill must never repeat: a
    reconciliation failure must not destroy the evidence the scan already
    gathered. scan_forensics.json must exist, with the real raw counts, even
    though run_backfill raises."""
    _seed_all_approved_run_summaries(dynamodb_tables, overrides={FIRST_DATE: 1})
    _put_snapshot(dynamodb_tables, video_id="vidA", snapshot_date=FIRST_DATE)
    _put_snapshot(dynamodb_tables, video_id="vidB", snapshot_date=FIRST_DATE)

    staging_root = tmp_path / "staging"
    with pytest.raises(backfill_history_parquet.SourceCountMismatchError) as excinfo:
        backfill_history_parquet.run_backfill(staging_root, dynamodb_resource=dynamodb_tables)

    assert "delta=" in str(excinfo.value)
    assert excinfo.value.forensics.stage_counts[FIRST_DATE] == 2

    log_path = staging_root / backfill_history_parquet.FORENSICS_LOG_FILENAME
    assert log_path.exists()
    payload = json.loads(log_path.read_text(encoding="utf-8"))
    assert payload["stageDateRawCounts"][FIRST_DATE] == 2
    assert payload["totalScannedRowsAllDates"] == 2


def test_baseline_drift_reported_without_aborting(tmp_path, dynamodb_tables):
    """If the live YobiRunSummaries collectedCount for a stage date disagrees
    with the hardcoded approved baseline (T2.7E's given numbers), that's
    worth surfacing but must not by itself abort a run that is otherwise
    internally consistent (scanned == live RunSummaries)."""
    _put_snapshot(dynamodb_tables, video_id="driftVideo", snapshot_date=FIRST_DATE)
    _seed_all_approved_run_summaries(dynamodb_tables, overrides={FIRST_DATE: 1})

    staging_root = tmp_path / "staging"
    report = backfill_history_parquet.run_backfill(staging_root, dynamodb_resource=dynamodb_tables)

    assert report.ok
    assert report.baseline_drift[FIRST_DATE] == 1 - backfill_history_parquet.APPROVED_COMPLETE_ROW_COUNTS[FIRST_DATE]
