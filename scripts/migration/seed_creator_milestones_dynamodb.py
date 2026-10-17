"""Seed the CreatorMilestones table (YobiCreatorMilestones) with every creator's birthday and ORIGINAL debut date.

One item per Creator Master creatorId: {creatorId, birthday "MM-DD" (no year), debutDate "YYYY-MM-DD"}. Both are plain strings, never
timestamps. The input is the version-controlled dataset scripts/migration/creator_milestones_seed.json (built from
oshiyobi_member_birthdays_debuts.md by build_creator_milestones_dataset.py). Graduated, retired and terminated creators are seeded like
everyone else and keep their ORIGINAL debut date: lifecycle status never decides whether a record is imported.

SAFE BY DEFAULT: the default run is an OFFLINE dry run -- it validates the whole dataset against Creator Master and touches no AWS service.
Contacting the production table needs --target production; WRITING to it additionally needs --apply. Neither flag alone writes:
    python scripts/migration/seed_creator_milestones_dynamodb.py                                  # offline validation only
    python scripts/migration/seed_creator_milestones_dynamodb.py --target production              # read-only: inserted/unchanged/conflicting
    python scripts/migration/seed_creator_milestones_dynamodb.py --target production --apply      # insert the missing items

Everything is validated before the first write; one rejected record aborts the run with nothing written. Re-running is safe: an item that
already holds the same values is "unchanged"; an item whose stored values DIFFER is "conflicting" and is left alone unless
--update-conflicts is also given. Writes are an UpdateItem that sets only birthday and debutDate, so any other attribute on an item is
never overwritten, and inserts are conditional so a concurrent run can never duplicate or clobber an item.

Exit codes: 0 ok, 1 rejected or conflicting records (or a write failure), 2 missing configuration (dataset, Creator Master, region/credentials, or the table itself).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))

from botocore.exceptions import ClientError  # noqa: E402

from tracking.creator_master import DEFAULT_CREATORS_PATH, CreatorMasterError, load_creators  # noqa: E402

CREATOR_MILESTONES_TABLE = os.environ.get("YOBI_CREATOR_MILESTONES_TABLE") or "YobiCreatorMilestones"
DEFAULT_DATASET_PATH = Path(__file__).parent / "creator_milestones_seed.json"
PRODUCTION_TARGET = "production"

# displayName is a human-readable label in the dataset; it is never written to DynamoDB.
_ALLOWED_RECORD_KEYS = frozenset({"creatorId", "birthday", "debutDate", "displayName"})
_BIRTHDAY_PATTERN = re.compile(r"^(\d{2})-(\d{2})$")
_DEBUT_PATTERN = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
# 2000 is a leap year, so a Feb 29 birthday is accepted while Feb 30 / Apr 31 / month 13 are not.
_LEAP_YEAR = 2000


class SeedConfigError(Exception):
    """Raised when the dataset, Creator Master, or AWS configuration needed to run is missing or unreadable."""


@dataclass(frozen=True)
class MilestoneRecord:
    """One validated dataset row."""

    creator_id: str
    birthday: str
    debut_date: str


@dataclass
class SeedReport:
    """What a run did, or (offline/read-only/dry run) would do."""

    total: int = 0
    inserted: list[str] = field(default_factory=list)
    unchanged: list[str] = field(default_factory=list)
    updated: list[str] = field(default_factory=list)
    conflicting: list[tuple[str, dict, dict]] = field(default_factory=list)  # (creatorId, stored, dataset)
    rejected: list[tuple[str, str]] = field(default_factory=list)  # (creatorId or row label, reason)
    mode: str = ""

    def lines(self) -> list[str]:
        """Human-readable summary, one finding per line."""
        out = [
            f"Mode: {self.mode}",
            f"Dataset records:  {self.total}",
            f"Rejected:         {len(self.rejected)}",
            f"Inserted:         {len(self.inserted)}",
            f"Unchanged:        {len(self.unchanged)}",
            f"Updated:          {len(self.updated)}",
            f"Conflicting:      {len(self.conflicting)}",
        ]
        out += [f"  rejected {label}: {reason}" for label, reason in self.rejected]
        for creator_id, stored, wanted in self.conflicting:
            out.append(f"  conflict {creator_id}: stored {stored} != dataset {wanted}")
        return out


def valid_birthday(value: object) -> bool:
    """True for a real "MM-DD" calendar day; Feb 29 is valid, there is no year."""
    match = _BIRTHDAY_PATTERN.match(value) if isinstance(value, str) else None
    if not match:
        return False
    try:
        date(_LEAP_YEAR, int(match.group(1)), int(match.group(2)))
    except ValueError:
        return False
    return True


def valid_debut_date(value: object, *, today: date | None = None) -> bool:
    """True for a real "YYYY-MM-DD" calendar date that is not in the future (a debut that has not happened is not an original debut)."""
    match = _DEBUT_PATTERN.match(value) if isinstance(value, str) else None
    if not match:
        return False
    try:
        parsed = date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return False
    return parsed <= (today or date.today())


def load_dataset(path: Path = DEFAULT_DATASET_PATH) -> list[dict]:
    """Read the dataset's records list; raises SeedConfigError when the file is missing or is not the expected shape."""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SeedConfigError(f"Dataset not found: {path}") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise SeedConfigError(f"Dataset unreadable: {path}: {exc}") from exc
    records = payload.get("records") if isinstance(payload, dict) else None
    if not isinstance(records, list):
        raise SeedConfigError(f"Dataset {path} must be an object with a 'records' list")
    return records


def load_master_ids(creators_path: Path = DEFAULT_CREATORS_PATH) -> set[str]:
    """Every creatorId in Creator Master; raises SeedConfigError when it cannot be loaded."""
    try:
        return {creator.creator_id for creator in load_creators(creators_path)}
    except (CreatorMasterError, OSError) as exc:
        raise SeedConfigError(f"Creator Master unreadable: {creators_path}: {exc}") from exc


def validate_records(
    raw_records: list[dict], master_ids: set[str], *, today: date | None = None
) -> tuple[list[MilestoneRecord], list[tuple[str, str]]]:
    """Validate every row; returns (valid records, rejected (label, reason) pairs). Nothing is dropped silently.

    Checks: an object with only the known keys, creatorId present in Creator Master, birthday MM-DD, debutDate YYYY-MM-DD, and no
    creatorId appearing twice (every occurrence of a duplicated id is rejected, so which row is right is never guessed).
    """
    rejected: list[tuple[str, str]] = []
    counts: dict[str, int] = {}
    for raw in raw_records:
        if isinstance(raw, dict) and isinstance(raw.get("creatorId"), str):
            counts[raw["creatorId"]] = counts.get(raw["creatorId"], 0) + 1

    valid: list[MilestoneRecord] = []
    for index, raw in enumerate(raw_records):
        if not isinstance(raw, dict):
            rejected.append((f"row {index}", "record is not an object"))
            continue
        creator_id = raw.get("creatorId")
        label = creator_id if isinstance(creator_id, str) and creator_id else f"row {index}"
        problems: list[str] = []
        unknown = sorted(set(raw) - _ALLOWED_RECORD_KEYS)
        if unknown:
            problems.append(f"unknown keys {unknown}")
        if not isinstance(creator_id, str) or not creator_id:
            problems.append("creatorId missing")
        else:
            if creator_id not in master_ids:
                problems.append("creatorId not in Creator Master")
            if counts[creator_id] > 1:
                problems.append("duplicate creatorId")
        if not valid_birthday(raw.get("birthday")):
            problems.append(f"invalid birthday {raw.get('birthday')!r} (want MM-DD)")
        if not valid_debut_date(raw.get("debutDate"), today=today):
            problems.append(f"invalid debutDate {raw.get('debutDate')!r} (want a past YYYY-MM-DD)")
        if problems:
            rejected.append((label, "; ".join(problems)))
        else:
            valid.append(MilestoneRecord(creator_id, raw["birthday"], raw["debutDate"]))
    return valid, rejected


def _table(table_name: str = CREATOR_MILESTONES_TABLE):
    """The DynamoDB Table resource for table_name, using the ambient AWS credentials; raises SeedConfigError without a region/credentials."""
    import boto3
    from botocore.exceptions import BotoCoreError

    try:
        session = boto3.session.Session()
        if not session.region_name:
            raise SeedConfigError("No AWS region configured (set AWS_REGION or AWS_DEFAULT_REGION)")
        if session.get_credentials() is None:
            raise SeedConfigError("No AWS credentials found")
        return session.resource("dynamodb").Table(table_name)
    except BotoCoreError as exc:
        raise SeedConfigError(f"AWS configuration error: {exc}") from exc


def run(
    raw_records: list[dict],
    master_ids: set[str],
    *,
    table=None,
    apply: bool = False,
    update_conflicts: bool = False,
    today: date | None = None,
) -> SeedReport:
    """Validate the dataset, then (given a table) compare it with stored items and, only with apply, write.

    table=None is the offline dry run: validation only, no AWS call of any kind. With a table but apply=False every write is skipped
    (reads only). Any rejected record stops the run before the first write.
    """
    report = SeedReport(total=len(raw_records), mode="offline dry run")
    records, report.rejected = validate_records(raw_records, master_ids, today=today)
    if table is None:
        return report
    report.mode = "APPLY" if apply else "read-only dry run (nothing written)"
    if report.rejected:
        report.mode += " -- ABORTED, dataset has rejected records"
        return report

    for record in records:
        wanted = {"birthday": record.birthday, "debutDate": record.debut_date}
        item = table.get_item(Key={"creatorId": record.creator_id}, ConsistentRead=True).get("Item")
        if item is None:
            report.inserted.append(record.creator_id)
            if apply:
                _insert(table, record)
            continue
        stored = {key: item.get(key) for key in wanted}
        if stored == wanted:
            report.unchanged.append(record.creator_id)
        elif update_conflicts:
            report.updated.append(record.creator_id)
            if apply:
                _set_values(table, record)
        else:
            report.conflicting.append((record.creator_id, stored, wanted))
    return report


def _insert(table, record: MilestoneRecord) -> None:
    """Create the item only if absent; a concurrent insert of the same id is skipped, never duplicated or overwritten."""
    from botocore.exceptions import ClientError

    try:
        table.update_item(
            Key={"creatorId": record.creator_id},
            UpdateExpression="SET birthday = :b, debutDate = :d",
            ConditionExpression="attribute_not_exists(creatorId)",
            ExpressionAttributeValues={":b": record.birthday, ":d": record.debut_date},
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise


def _set_values(table, record: MilestoneRecord) -> None:
    """Overwrite only birthday and debutDate on an existing item, leaving every other attribute alone."""
    table.update_item(
        Key={"creatorId": record.creator_id},
        UpdateExpression="SET birthday = :b, debutDate = :d",
        ExpressionAttributeValues={":b": record.birthday, ":d": record.debut_date},
    )


def main(argv: list[str] | None = None) -> int:
    """CLI entry point; see the module docstring for usage and exit codes."""
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET_PATH, help="dataset JSON (default: the version-controlled seed)")
    parser.add_argument("--creators", type=Path, default=DEFAULT_CREATORS_PATH, help="Creator Master JSON (default: src/creators.json)")
    parser.add_argument("--target", choices=[PRODUCTION_TARGET], help="contact the production table (read-only unless --apply)")
    parser.add_argument("--apply", action="store_true", help="with --target production: actually write (default: nothing is written)")
    parser.add_argument("--update-conflicts", action="store_true", help="with --target production: also overwrite differing stored values")
    args = parser.parse_args(argv)
    if (args.apply or args.update_conflicts) and args.target != PRODUCTION_TARGET:
        parser.error("--apply / --update-conflicts need an explicit --target production")
    if args.update_conflicts and not args.apply:
        parser.error("--update-conflicts only makes sense with --apply")

    try:
        records = load_dataset(args.dataset)
        master_ids = load_master_ids(args.creators)
        table = _table() if args.target == PRODUCTION_TARGET else None
        report = run(records, master_ids, table=table, apply=args.apply, update_conflicts=args.update_conflicts)
    except SeedConfigError as exc:
        print(f"CONFIG ERROR: {exc}", file=sys.stderr)
        return 2
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ResourceNotFoundException":
            print(f"TABLE MISSING: {CREATOR_MILESTONES_TABLE} does not exist yet; create it with Terraform first. Nothing was written.", file=sys.stderr)
            return 2
        print(f"FAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # other AWS failures (ClientError, EndpointConnectionError, ...) must end as a clear failure, not a traceback
        print(f"FAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    print("\n".join(report.lines()))
    return 1 if report.rejected or report.conflicting else 0


if __name__ == "__main__":
    sys.exit(main())
