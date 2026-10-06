"""Realign the `topic` of already-persisted per-creator video-ranking S3 results with the tracking manifest.

Why this exists: `scripts/backfill/backfill_video_topics.py --reclassify` corrects the authoritative topics (Video
Master and the tracking manifest), but the API serves `GET /creators/{id}/videos/ranking` and `/videos/recent` from
the per-(report date, creator) result objects under `video-ranking/`, which `analytics.ranking_reducer` only rebuilds
on the next SUCCESSFUL daily ReduceRankings run. Until then the API would keep serving the old topic. This script
brings the already-persisted results of the chosen report date(s) in line immediately, without waiting for that run
and without running the reducer out of band (which needs the execution lock).

What --execute writes, and nothing else: the `topic` value of video rows whose manifest topic differs, inside the
result object that holds them. Every other row field, row order, `generatedAt`, `schemaVersion`, and every object with
nothing to change are left exactly as they are. Each write is conditional on the object's ETag still being the one
read (a concurrent rewrite by the reducer is counted in skippedConcurrent and never overwritten). A row whose video has
no valid manifest topic is left unchanged (the script never downgrades a row to a guess). The tracking manifest is read
only. It is idempotent: a second run finds nothing to change.

Defaults to a dry run (report only). --execute needs --yes, an explicit YOBI_HISTORY_BUCKET (this script never
defaults to the production bucket), and aborts with zero writes if the manifest cannot be read in full or is empty.
--only-topic TOPIC limits changes to rows whose old or new topic is TOPIC. --report-file PATH writes the summary as
JSON and must be OUTSIDE this repository. Without --report-date the newest report date present is used.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT / "src"))

from botocore.exceptions import ClientError  # noqa: E402

from stores.history_store import HISTORY_SHARD_COUNT  # noqa: E402
from stores.video_ranking_store import VIDEO_RANKING_PREFIX  # noqa: E402
from tracking.tracking_manifest import S3TrackingManifestStore  # noqa: E402
from tracking.video_topics import TOPIC_IDS  # noqa: E402

_DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
STATUS_COMPLETE = "COMPLETE"
STATUS_PARTIAL = "PARTIAL (recoverable: re-run --execute)"
STATUS_FAILED = "FAILED"
STATUS_DRY_RUN = "DRY RUN"


class PreflightError(RuntimeError):
    """The manifest could not be read in full, so no write may start."""


def _safe_error(exc: BaseException) -> str:
    """Exception class plus AWS error code only; raw AWS text can carry ARNs and account ids."""
    cause: BaseException | None = exc
    while cause is not None and not isinstance(cause, ClientError):
        cause = cause.__cause__ or cause.__context__
    if isinstance(cause, ClientError):
        return f"{type(exc).__name__}, AWS error code {cause.response.get('Error', {}).get('Code') or 'unknown'}"
    return type(exc).__name__


def load_manifest_topics(store: S3TrackingManifestStore) -> dict[str, str]:
    """videoId -> valid manifest topic for every entry that has one; raises PreflightError if unreadable or empty."""
    topics: dict[str, str] = {}
    total = 0
    for shard in range(HISTORY_SHARD_COUNT):
        try:
            entries, _version = store.read_shard_for_patch(shard)
        except Exception as exc:
            raise PreflightError(f"manifest shard {shard:02d} could not be read ({_safe_error(exc)})") from exc
        total += len(entries)
        topics.update({entry.video_id: entry.topic for entry in entries if entry.topic in TOPIC_IDS})
    if total == 0:
        raise PreflightError("manifest has zero entries across all shards; refusing to continue")
    return topics


def latest_report_date(s3_client: Any, bucket: str) -> str | None:
    """The newest `date=YYYY-MM-DD` partition under the video-ranking prefix, or None when there is none."""
    dates: list[str] = []
    paginator = s3_client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=f"{VIDEO_RANKING_PREFIX}/", Delimiter="/"):
        for common in page.get("CommonPrefixes", []):
            match = re.search(r"date=(\d{4}-\d{2}-\d{2})/$", common["Prefix"])
            if match:
                dates.append(match.group(1))
    return max(dates) if dates else None


def _result_keys(s3_client: Any, bucket: str, report_date: str) -> list[str]:
    """Every result object key under one report date's partition."""
    keys: list[str] = []
    paginator = s3_client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=f"{VIDEO_RANKING_PREFIX}/date={report_date}/"):
        keys.extend(obj["Key"] for obj in page.get("Contents", []) if obj["Key"].endswith(".json"))
    return keys


def _realigned_rows(
    payload: dict[str, Any], topic_by_video: dict[str, str], only_topic: str | None, transitions: Counter[str]
) -> int:
    """Set each row's topic from the manifest in place; return how many rows changed (and tally old->new)."""
    changed = 0
    for row in payload.get("videos", []):
        target = topic_by_video.get(row.get("videoId"))
        current = row.get("topic")
        if target is None or target == current:
            continue
        if only_topic is not None and only_topic not in (current, target):
            continue
        transitions[f"{current}->{target}"] += 1
        row["topic"] = target
        changed += 1
    return changed


def realign(
    *,
    s3_client: Any,
    bucket: str,
    manifest_store: S3TrackingManifestStore,
    report_dates: list[str] | None,
    execute: bool,
    only_topic: str | None = None,
) -> dict[str, Any]:
    """Compare (and, with execute=True, rewrite) result rows' topics against the manifest; always returns a summary."""
    if only_topic is not None and only_topic not in TOPIC_IDS:
        raise ValueError(f"Unknown topic id for only_topic: {only_topic!r}")
    transitions: Counter[str] = Counter()
    summary: dict[str, Any] = {
        "reportDates": [],
        "resultsScanned": 0,
        "resultsChanged": 0,
        "rowsScanned": 0,
        "rowsChanged": 0,
        "written": 0,
        "skippedConcurrent": 0,
        "errors": 0,
        "topicTransitions": {},
    }
    try:
        topic_by_video = load_manifest_topics(manifest_store)
    except PreflightError as exc:
        print(f"Preflight failed: {exc}")
        summary["abortedReason"] = f"manifest preflight failed: {exc}"
        summary["status"] = STATUS_FAILED
        return summary

    dates = report_dates or ([latest] if (latest := latest_report_date(s3_client, bucket)) else [])
    summary["reportDates"] = dates
    for report_date in dates:
        for key in _result_keys(s3_client, bucket, report_date):
            summary["resultsScanned"] += 1
            try:
                response = s3_client.get_object(Bucket=bucket, Key=key)
                etag = response["ETag"]
                payload = json.loads(response["Body"].read())
            except Exception as exc:
                summary["errors"] += 1
                print(f"Error: could not read a ranking result ({_safe_error(exc)})")
                continue
            summary["rowsScanned"] += len(payload.get("videos", []))
            changed = _realigned_rows(payload, topic_by_video, only_topic, transitions)
            if not changed:
                continue
            summary["resultsChanged"] += 1
            summary["rowsChanged"] += changed
            if not execute:
                continue
            try:
                s3_client.put_object(
                    Bucket=bucket,
                    Key=key,
                    Body=json.dumps(payload).encode("utf-8"),
                    ContentType="application/json",
                    IfMatch=etag,
                )
            except ClientError as exc:
                if exc.response.get("Error", {}).get("Code") in {"PreconditionFailed", "ConditionalRequestConflict"}:
                    summary["skippedConcurrent"] += 1
                else:
                    summary["errors"] += 1
                    print(f"Error: could not write a ranking result ({_safe_error(exc)})")
                continue
            summary["written"] += 1
    summary["topicTransitions"] = {name: transitions[name] for name in sorted(transitions)}
    if not execute:
        summary["status"] = STATUS_DRY_RUN
    elif summary["errors"] or summary["skippedConcurrent"] or summary["written"] != summary["resultsChanged"]:
        summary["status"] = STATUS_PARTIAL
    else:
        summary["status"] = STATUS_COMPLETE
    return summary


def main(argv: list[str] | None = None) -> int:
    """CLI entry point: dry run by default; --execute --yes rewrites topic values in the chosen result objects."""
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter, allow_abbrev=False)
    parser.add_argument("--execute", action="store_true", help="Write the realigned results. Without it, report only.")
    parser.add_argument("--yes", action="store_true", help="Required with --execute: confirm writing to the printed target.")
    parser.add_argument("--report-date", action="append", help="YYYY-MM-DD partition to realign (repeatable). Default: the newest present.")
    parser.add_argument("--only-topic", choices=sorted(TOPIC_IDS), help="Only change rows whose old or new topic is this one.")
    parser.add_argument("--report-file", type=Path, help="Write the summary as JSON here. Must be outside the repository.")
    args = parser.parse_args(argv)

    for value in args.report_date or []:
        if not _DATE_PATTERN.match(value):
            print(f"--report-date must be YYYY-MM-DD, got {value!r} (nothing was written).")
            return 2
    if args.report_file is not None and args.report_file.resolve().is_relative_to(REPO_ROOT):
        print("--report-file must be outside the repository; nothing was written.")
        return 2
    bucket = os.environ.get("YOBI_HISTORY_BUCKET")
    mode = "EXECUTE (writes)" if args.execute else "DRY RUN (no writes)"
    print(f"=== Video-ranking topic realign -- {mode} ===\n")
    print("Targets (non-secret names only):")
    print(f"  Results bucket : {bucket or 'NOT CONFIGURED'}")
    print(f"  Prefix         : {VIDEO_RANKING_PREFIX}/date=<report date>/")
    print(f"  Mode           : {mode}\n")
    if not bucket:
        print("YOBI_HISTORY_BUCKET is not configured; this script never defaults to a bucket (nothing was written).")
        return 2
    if args.execute and not args.yes:
        print("Refusing to write without --yes. Re-run with --yes to write to the target above (nothing was written).")
        return 2

    import boto3

    s3_client = boto3.client("s3")
    summary = realign(
        s3_client=s3_client,
        bucket=bucket,
        manifest_store=S3TrackingManifestStore(bucket, s3_client=s3_client),
        report_dates=args.report_date,
        execute=args.execute,
        only_topic=args.only_topic,
    )
    for key, value in summary.items():
        print(f"{key}: {value}")
    if args.report_file is not None:
        args.report_file.parent.mkdir(parents=True, exist_ok=True)
        args.report_file.write_text(json.dumps({"mode": mode, **summary}, indent=2, sort_keys=True), encoding="utf-8")
        print(f"Report written to {args.report_file}")
    print(f"\nRESULT: {summary['status']}")
    if summary["status"] == STATUS_FAILED:
        return 2
    return 0 if summary["status"] in (STATUS_COMPLETE, STATUS_DRY_RUN) and not summary["errors"] else 1


if __name__ == "__main__":
    sys.exit(main())
