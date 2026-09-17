"""One-time production upload: local validated history Parquet staging -> S3.

Uploads the 240 already-validated Parquet files staged by
scripts/backfill_history_parquet.py (15 dates, 2026-08-30..2026-09-13) to
s3://yobi-analytics-history/history/daily/... key-for-key. Never rebuilds,
transforms, or rescans DynamoDB -- purely a byte-for-byte S3 upload of
already-produced local files, at the same key layout
(history_store.daily_history_key) the production S3 pipeline uses, gated by a
read-only pre-check before and a read-only reconciliation after.

STAGE_DATES is the fixed, explicit set this script is scoped to. 2026-09-14
(confirmed partial -- see backfill_history_parquet.py) and any later date are
never uploaded here, and their mere presence in the bucket (e.g. from the new
S3 history pipeline already running in production for "today") is reported,
never treated as this script's own problem to fix or delete.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

import boto3
from botocore.exceptions import ClientError

from history_store import HISTORY_SHARD_COUNT, daily_history_key, deserialize_history_rows

HISTORY_BUCKET = "yobi-analytics-history"
HISTORY_DAILY_PREFIX = "history/daily/"
STAGING_ROOT = Path("history_backfill_staging")

APPROVED_ROW_COUNTS: dict[str, int] = {
    "2026-08-30": 5_659,
    "2026-08-31": 35_528,
    "2026-09-01": 64_325,
    "2026-09-02": 64_362,
    "2026-09-03": 64_378,
    "2026-09-04": 65_132,
    "2026-09-05": 64_440,
    "2026-09-06": 70_084,
    "2026-09-07": 8_764,
    "2026-09-08": 69_978,
    "2026-09-09": 12_795,
    "2026-09-10": 25_825,
    "2026-09-11": 12_983,
    "2026-09-12": 24_801,
    "2026-09-13": 13_771,
}
STAGE_DATES: list[str] = sorted(APPROVED_ROW_COUNTS)
EXPECTED_TOTAL_ROWS = sum(APPROVED_ROW_COUNTS.values())


def _target_key_index() -> dict[str, tuple[str, int]]:
    """Every expected S3 key -> (collection_date, shard)."""
    return {
        daily_history_key(date.fromisoformat(collection_date), shard): (collection_date, shard)
        for collection_date in STAGE_DATES
        for shard in range(HISTORY_SHARD_COUNT)
    }


def _local_path_for(collection_date: str, shard: int) -> Path:
    return STAGING_ROOT / daily_history_key(date.fromisoformat(collection_date), shard)


def _date_from_key(key: str) -> str | None:
    """Extract the date= partition value from a history/daily/... key, or
    None if the key doesn't match that layout at all."""
    if not key.startswith(HISTORY_DAILY_PREFIX):
        return None
    remainder = key[len(HISTORY_DAILY_PREFIX):]
    if not remainder.startswith("date="):
        return None
    return remainder.split("/", 1)[0][len("date="):]


def _list_all_history_daily_objects(s3_client) -> list[tuple[str, int]]:
    """Single paginated listing of the whole history/daily/ prefix -- used by
    both the pre-check and the post-upload verification so neither misses an
    object under a date this script doesn't know about (2026-09-14, or a
    later date the live pipeline may already be writing)."""
    objects: list[tuple[str, int]] = []
    kwargs: dict[str, Any] = {"Bucket": HISTORY_BUCKET, "Prefix": HISTORY_DAILY_PREFIX}
    while True:
        response = s3_client.list_objects_v2(**kwargs)
        for obj in response.get("Contents", []):
            objects.append((obj["Key"], obj["Size"]))
        if not response.get("IsTruncated"):
            break
        kwargs["ContinuationToken"] = response["NextContinuationToken"]
    return objects


@dataclass
class PreCheckResult:
    existing_target_keys: list[str] = field(default_factory=list)
    other_observed_dates: dict[str, int] = field(default_factory=dict)

    @property
    def clean(self) -> bool:
        return not self.existing_target_keys


def pre_check(s3_client) -> PreCheckResult:
    """Read-only. Confirms none of the 240 target keys already exist. Also
    reports (never blocks on) any object found under a date outside
    STAGE_DATES -- e.g. production's live history pipeline already writing
    today's date -- purely for visibility."""
    target_keys = set(_target_key_index())
    result = PreCheckResult()
    for key, _size in _list_all_history_daily_objects(s3_client):
        if key in target_keys:
            result.existing_target_keys.append(key)
        else:
            collection_date = _date_from_key(key) or "(unparseable key)"
            result.other_observed_dates[collection_date] = result.other_observed_dates.get(collection_date, 0) + 1
    return result


@dataclass
class UploadResult:
    succeeded: list[str] = field(default_factory=list)
    failed: list[tuple[str, str]] = field(default_factory=list)  # (key, error)

    @property
    def ok(self) -> bool:
        return not self.failed


def upload_all(s3_client) -> UploadResult:
    """Uploads the 240 staged files byte-for-byte, in deterministic
    (date, shard) order. Stops at the first failure -- deterministic keys
    make a retry safe, so there is no reason to keep going past one -- and
    never deletes or retries an already-successful object."""
    result = UploadResult()
    for collection_date in STAGE_DATES:
        for shard in range(HISTORY_SHARD_COUNT):
            key = daily_history_key(date.fromisoformat(collection_date), shard)
            try:
                body = _local_path_for(collection_date, shard).read_bytes()
                s3_client.put_object(
                    Bucket=HISTORY_BUCKET,
                    Key=key,
                    Body=body,
                    ContentType="application/vnd.apache.parquet",
                )
            except (ClientError, OSError) as exc:
                result.failed.append((key, str(exc)))
                return result
            result.succeeded.append(key)
    return result


@dataclass
class VerificationReport:
    object_count: int
    per_date_shard_count: dict[str, int]
    per_date_row_count: dict[str, int]
    total_rows: int
    representative_checks: dict[str, bool]
    other_observed_dates: dict[str, int] = field(default_factory=dict)
    anomalies: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.anomalies


def verify(s3_client) -> VerificationReport:
    """Read-only. Lists the whole history/daily/ prefix once, HeadObjects and
    GetObjects every one of the 240 expected keys (row reconciliation is done
    from the uploaded Parquet bytes themselves, never from DynamoDB), and
    flags any date outside STAGE_DATES found in the bucket -- including
    2026-09-14 -- without treating it as this script's object to fix."""
    target_index = _target_key_index()
    anomalies: list[str] = []
    other_observed_dates: dict[str, int] = {}
    per_date_shard_count: dict[str, int] = {collection_date: 0 for collection_date in STAGE_DATES}
    per_date_row_count: dict[str, int] = {collection_date: 0 for collection_date in STAGE_DATES}

    listed = _list_all_history_daily_objects(s3_client)
    seen_target_keys: set[str] = set()
    for key, size in listed:
        if key not in target_index:
            collection_date = _date_from_key(key) or "(unparseable key)"
            other_observed_dates[collection_date] = other_observed_dates.get(collection_date, 0) + 1
            if collection_date == "2026-09-14":
                anomalies.append(f"2026-09-14 object found in S3 (must not exist): {key}")
            continue
        seen_target_keys.add(key)
        collection_date, _shard = target_index[key]
        if size <= 0:
            anomalies.append(f"Zero-size object (list): {key}")

    missing = set(target_index) - seen_target_keys
    for key in sorted(missing):
        anomalies.append(f"Missing expected key: {key}")

    for key in sorted(seen_target_keys):
        collection_date, shard = target_index[key]
        head = s3_client.head_object(Bucket=HISTORY_BUCKET, Key=key)
        if head["ContentLength"] <= 0:
            anomalies.append(f"HeadObject zero size: {key}")
        per_date_shard_count[collection_date] += 1
        body = s3_client.get_object(Bucket=HISTORY_BUCKET, Key=key)["Body"].read()
        try:
            rows = deserialize_history_rows(body)
        except Exception as exc:  # noqa: BLE001 -- any deserialization failure is itself the anomaly
            anomalies.append(f"Failed to deserialize {key} with the production reader: {exc}")
            continue
        per_date_row_count[collection_date] += len(rows)

    representative_dates = {
        "earliest": STAGE_DATES[0],
        "middle": STAGE_DATES[len(STAGE_DATES) // 2],
        "latest": STAGE_DATES[-1],
    }
    representative_checks: dict[str, bool] = {}
    for label, collection_date in representative_dates.items():
        key = daily_history_key(date.fromisoformat(collection_date), 0)
        check_label = f"{label} ({collection_date}, shard=00)"
        try:
            body = s3_client.get_object(Bucket=HISTORY_BUCKET, Key=key)["Body"].read()
            deserialize_history_rows(body)
            representative_checks[check_label] = True
        except Exception as exc:  # noqa: BLE001
            representative_checks[check_label] = False
            anomalies.append(f"Representative production-reader check failed for {key}: {exc}")

    for collection_date in STAGE_DATES:
        if per_date_shard_count[collection_date] != HISTORY_SHARD_COUNT:
            anomalies.append(
                f"{collection_date}: shard count {per_date_shard_count[collection_date]} != {HISTORY_SHARD_COUNT}"
            )
        if per_date_row_count[collection_date] != APPROVED_ROW_COUNTS[collection_date]:
            anomalies.append(
                f"{collection_date}: S3 row count {per_date_row_count[collection_date]} "
                f"!= approved {APPROVED_ROW_COUNTS[collection_date]}"
            )

    total_rows = sum(per_date_row_count.values())
    if total_rows != EXPECTED_TOTAL_ROWS:
        anomalies.append(f"Total S3 row count {total_rows} != approved {EXPECTED_TOTAL_ROWS}")

    return VerificationReport(
        object_count=len(seen_target_keys),
        per_date_shard_count=per_date_shard_count,
        per_date_row_count=per_date_row_count,
        total_rows=total_rows,
        representative_checks=representative_checks,
        other_observed_dates=other_observed_dates,
        anomalies=anomalies,
    )


def main() -> int:
    s3 = boto3.client("s3")

    print("=== T2.8.2: S3 pre-check (read-only, ListObjectsV2 only) ===")
    print(f"Target: s3://{HISTORY_BUCKET}/{HISTORY_DAILY_PREFIX}  scope: {STAGE_DATES[0]}..{STAGE_DATES[-1]}\n")
    check = pre_check(s3)
    if check.other_observed_dates:
        print("Other dates already present in the bucket (not our target range, not touched):")
        for collection_date, count in sorted(check.other_observed_dates.items()):
            print(f"  {collection_date}: {count} object(s)")
    if not check.clean:
        print(f"\nABORTED -- {len(check.existing_target_keys)} unexpected existing target object(s) found:")
        for key in check.existing_target_keys:
            print(f"  {key}")
        print("\nNo upload attempted.")
        return 1
    print("Pre-check clean: 0 existing target objects for 2026-08-30..2026-09-13.\n")

    print("=== T2.8.3: upload (up to 240 PutObject calls) ===")
    result = upload_all(s3)
    print(f"Succeeded: {len(result.succeeded)}")
    print(f"Failed:    {len(result.failed)}")
    if not result.ok:
        print("\nFAILED KEYS:")
        for key, err in result.failed:
            print(f"  {key}: {err}")
        print(f"\n{len(result.succeeded)} object(s) already uploaded successfully and were left in place (not deleted).")
        print("STOPPED -- no further action taken.")
        return 1

    print("\n=== T2.8.4: S3 verification (read-only: List/Head/GetObject) ===")
    report = verify(s3)
    print(f"Object count: {report.object_count}")
    for collection_date in STAGE_DATES:
        print(
            f"  {collection_date}: shards={report.per_date_shard_count[collection_date]} "
            f"rows={report.per_date_row_count[collection_date]}"
        )
    print(f"Total S3 rows: {report.total_rows}")
    print("\nRepresentative production-reader checks:")
    for label, ok in report.representative_checks.items():
        print(f"  {label}: {'OK' if ok else 'FAILED'}")
    if report.other_observed_dates:
        print("\nOther dates observed in the bucket (outside this migration's scope):")
        for collection_date, count in sorted(report.other_observed_dates.items()):
            print(f"  {collection_date}: {count} object(s)")
    if report.anomalies:
        print("\nANOMALIES:")
        for a in report.anomalies:
            print(f"  - {a}")

    print(f"\nOVERALL: {'PASS' if report.ok else 'FAIL'}")
    return 0 if report.ok else 1


if __name__ == "__main__":
    sys.exit(main())
