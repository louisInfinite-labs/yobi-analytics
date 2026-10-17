"""Build the CreatorMilestones seed dataset from oshiyobi_member_birthdays_debuts.md, and report how every record maps to Creator Master.

The Markdown was reconstructed from an older roster and is NOT verified against the live site, so nothing in it is trusted blindly: every
row is mapped to an existing Creator Master creatorId (never a new one), and anything that does not map one-to-one, or whose dates look
inconsistent with Creator Master, is listed in the report instead of being fixed or dropped. The dataset is only written when every row
mapped cleanly; the report is always written. Lifecycle status never decides whether a row is kept, and no date is ever replaced.

Matching, strictest first: (1) the NFKC/case-folded display name equals exactly one Creator Master displayName; (2) when the name does not
match (the VSPO! EN members are romanised in the Markdown but Japanese in Creator Master) the romanised name's slug equals exactly one
creatorId -- reported separately as a slug match. Anything else is unmatched; more than one candidate is ambiguous.

Usage (read-only on the Markdown; writes the two output files):
    python scripts/migration/build_creator_milestones_dataset.py --markdown <path>/oshiyobi_member_birthdays_debuts.md
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))

from tracking.creator_master import DEFAULT_CREATORS_PATH, Creator, load_creators  # noqa: E402

sys.path.insert(0, str(Path(__file__).parent))
from seed_creator_milestones_dynamodb import DEFAULT_DATASET_PATH, valid_birthday, valid_debut_date  # noqa: E402

DEFAULT_REPORT_PATH = Path(__file__).parent.parent.parent / "docs" / "creator-milestones-mapping-report.md"
_ROW = re.compile(r"^\|\s*(?P<name>.+?)\s*\|\s*(?P<birthday>\d{2}/\d{2})\s*\|\s*(?P<debut>\d{4}/\d{2}/\d{2})\s*\|\s*$")
_SECTION = re.compile(r"^##\s+(?P<title>.+?)（(?P<count>\d+) 人）\s*$")
_SECTION_BRANCH = {"VSPO! JP": "vspo_jp", "VSPO! EN": "vspo_en", "hololive JP": "holo_jp", "hololive EN": "holo_en", "hololive ID": "holo_id"}
EXPECTED_TOTAL = 110


@dataclass(frozen=True)
class MarkdownRecord:
    """One table row of the Markdown, dates already converted to the dataset's formats."""

    section: str
    declared_count: int
    name: str
    birthday: str  # MM-DD
    debut_date: str  # YYYY-MM-DD
    line: int


@dataclass
class Mapping:
    """The outcome of mapping one Markdown row onto Creator Master."""

    record: MarkdownRecord
    status: str  # name | slug | ambiguous | unmatched
    creator: Creator | None = None
    candidates: list[str] = field(default_factory=list)


def parse_markdown(text: str) -> list[MarkdownRecord]:
    """Every member row under a '## <section>（N 人）' heading, with MM/DD -> MM-DD and YYYY/MM/DD -> YYYY-MM-DD."""
    records: list[MarkdownRecord] = []
    section, declared = "", 0
    for number, line in enumerate(text.splitlines(), start=1):
        heading = _SECTION.match(line)
        if heading:
            section, declared = heading["title"], int(heading["count"])
            continue
        row = _ROW.match(line)
        if row and section:
            records.append(
                MarkdownRecord(section, declared, row["name"], row["birthday"].replace("/", "-"), row["debut"].replace("/", "-"), number)
            )
    return records


def _fold(name: str) -> str:
    """Comparison form of a display name: NFKC, curly apostrophes straightened, case-folded."""
    return unicodedata.normalize("NFKC", name).replace("’", "'").casefold().strip()


def _slug(name: str) -> str:
    """The creatorId-style slug of a romanised name ("Ninomae Ina'nis" -> "ninomae_inanis")."""
    return re.sub(r"[^a-z0-9]+", "_", _fold(name).replace("'", "")).strip("_")


def map_records(records: list[MarkdownRecord], creators: list[Creator]) -> list[Mapping]:
    """Map each row to exactly one Creator Master creator, or mark it ambiguous/unmatched; individual members only."""
    members = [creator for creator in creators if creator.channel_type == "member"]
    mappings: list[Mapping] = []
    for record in records:
        by_name = [creator for creator in members if _fold(creator.display_name) == _fold(record.name)]
        if len(by_name) == 1:
            mappings.append(Mapping(record, "name", by_name[0]))
        elif len(by_name) > 1:
            mappings.append(Mapping(record, "ambiguous", None, [creator.creator_id for creator in by_name]))
        else:
            by_slug = [creator for creator in members if creator.creator_id == _slug(record.name)]
            if len(by_slug) == 1:
                mappings.append(Mapping(record, "slug", by_slug[0]))
            else:
                mappings.append(Mapping(record, "unmatched"))
    return mappings


def find_issues(mappings: list[Mapping], creators: list[Creator], *, today: date) -> dict[str, list[str]]:
    """Everything a human should look at, grouped; an empty group means that check passed."""
    issues: dict[str, list[str]] = {
        "unmatched or ambiguous rows": [],
        "Creator Master members absent from the Markdown": [],
        "creatorId used by more than one row": [],
        "section does not agree with Creator Master branch": [],
        "invalid date format or calendar date": [],
        "debut date after graduatedAt in Creator Master": [],
        "lifecycle in Creator Master contradicts the debut date": [],
        "section row count differs from its declared count": [],
    }
    seen: dict[str, str] = {}
    for mapping in mappings:
        record = mapping.record
        if mapping.creator is None:
            issues["unmatched or ambiguous rows"].append(f"line {record.line} {record.name!r}: {mapping.status} {mapping.candidates}")
            continue
        creator = mapping.creator
        if creator.creator_id in seen:
            issues["creatorId used by more than one row"].append(f"{creator.creator_id}: {seen[creator.creator_id]!r} and {record.name!r}")
        seen[creator.creator_id] = record.name
        if _SECTION_BRANCH.get(record.section.split(" / ")[0]) != creator.branch:
            issues["section does not agree with Creator Master branch"].append(f"{creator.creator_id}: {record.section!r} vs {creator.branch}")
        if not valid_birthday(record.birthday) or not valid_debut_date(record.debut_date, today=today):
            issues["invalid date format or calendar date"].append(f"{creator.creator_id}: {record.birthday} / {record.debut_date}")
        if creator.graduated_at and record.debut_date > creator.graduated_at:
            issues["debut date after graduatedAt in Creator Master"].append(
                f"{creator.creator_id}: debut {record.debut_date} > graduatedAt {creator.graduated_at}"
            )
        if creator.lifecycle_stage == "pre_debut" and record.debut_date <= today.isoformat():
            issues["lifecycle in Creator Master contradicts the debut date"].append(
                f"{creator.creator_id}: Master says pre_debut, Markdown debut {record.debut_date} is already past"
            )
    for creator in creators:
        if creator.channel_type == "member" and creator.creator_id not in seen:
            issues["Creator Master members absent from the Markdown"].append(f"{creator.creator_id} ({creator.display_name})")
    per_section: dict[tuple[str, int], int] = {}
    for mapping in mappings:
        key = (mapping.record.section, mapping.record.declared_count)
        per_section[key] = per_section.get(key, 0) + 1
    for (section, declared), count in per_section.items():
        if count != declared:
            issues["section row count differs from its declared count"].append(f"{section}: {count} rows, heading says {declared}")
    return issues


def build_dataset(mappings: list[Mapping]) -> dict:
    """The seed JSON: matched rows only, in Markdown order, each keyed by its Creator Master creatorId."""
    return {
        "schemaVersion": 1,
        "description": "Birthday (MM-DD, no year) and ORIGINAL debut date (YYYY-MM-DD) per Creator Master creatorId. "
        "Source: oshiyobi_member_birthdays_debuts.md (reconstructed, not verified against the live site). "
        "Graduated creators keep their original debut date.",
        "records": [
            {
                "creatorId": mapping.creator.creator_id,
                "displayName": mapping.creator.display_name,
                "birthday": mapping.record.birthday,
                "debutDate": mapping.record.debut_date,
            }
            for mapping in mappings
            if mapping.creator is not None
        ],
    }


def render_report(mappings: list[Mapping], issues: dict[str, list[str]], today: date) -> str:
    """The Markdown mapping report: counts, every mapping, and each issue group."""
    count = lambda status: sum(1 for mapping in mappings if mapping.status == status)  # noqa: E731
    lines = [
        "# CreatorMilestones mapping report",
        "",
        f"Generated {today.isoformat()} by `scripts/migration/build_creator_milestones_dataset.py` from `oshiyobi_member_birthdays_debuts.md`.",
        "The Markdown is a reconstruction from an older roster and is **not verified against the live site**; no date below was changed or replaced.",
        "",
        "## Summary",
        "",
        f"- Markdown rows parsed: {len(mappings)} (expected {EXPECTED_TOTAL})",
        f"- Matched by exact display name: {count('name')}",
        f"- Matched by creatorId slug (display name differs): {count('slug')}",
        f"- Ambiguous: {count('ambiguous')}",
        f"- Unmatched: {count('unmatched')}",
        "",
        "## Issues",
        "",
    ]
    for title, items in issues.items():
        lines.append(f"### {title}: {len(items)}")
        lines += [f"- {item}" for item in items] or ["- none"]
        lines.append("")
    normalized = [m for m in mappings if m.status == "name" and m.creator and m.creator.display_name != m.record.name]
    graduated = [m for m in mappings if m.creator and m.creator.lifecycle_stage == "graduated"]
    lines += [
        "## Notes",
        "",
        f"- Matched only after normalisation (e.g. curly vs straight apostrophe): {[m.record.name for m in normalized]}",
        f"- Feb 29 birthdays (accepted): {[m.creator.creator_id for m in mappings if m.creator and m.record.birthday == '02-29']}",
        f"- Graduated creators retained with their original debut date: {len(graduated)}",
        "- Non-member Creator Master channels (group/staff/official) are out of scope and have no row; the Markdown covers individual members only.",
        "- Every debut date follows the Markdown's own rule (earliest VTuber identity; the official anniversary date wins over the first stream). "
        "That convention was applied by the source, not re-checked here, and no row was confirmed against an official page.",
        "",
    ]
    lines += ["## Mapping", "", "| Markdown name | creatorId | match | lifecycle | birthday | debutDate |", "|---|---|---|---|---|---|"]
    for mapping in mappings:
        creator = mapping.creator
        lines.append(
            f"| {mapping.record.name} | {creator.creator_id if creator else '-'} | {mapping.status} | "
            f"{creator.lifecycle_stage if creator else '-'} | {mapping.record.birthday} | {mapping.record.debut_date} |"
        )
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    """CLI entry point: parse, map, always write the report, write the dataset only if every row mapped cleanly."""
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--markdown", type=Path, required=True, help="path to oshiyobi_member_birthdays_debuts.md (only read)")
    parser.add_argument("--creators", type=Path, default=DEFAULT_CREATORS_PATH)
    parser.add_argument("--dataset-out", type=Path, default=DEFAULT_DATASET_PATH)
    parser.add_argument("--report-out", type=Path, default=DEFAULT_REPORT_PATH)
    args = parser.parse_args(argv)

    try:
        text = args.markdown.read_text(encoding="utf-8")
    except OSError as exc:
        print(f"CONFIG ERROR: cannot read {args.markdown}: {exc}", file=sys.stderr)
        return 2
    today = date.today()
    mappings = map_records(parse_markdown(text), load_creators(args.creators))
    issues = find_issues(mappings, load_creators(args.creators), today=today)
    args.report_out.write_text(render_report(mappings, issues, today), encoding="utf-8", newline="\n")
    print(f"Report written: {args.report_out}")

    blocking = ("unmatched or ambiguous rows", "creatorId used by more than one row", "invalid date format or calendar date")
    if len(mappings) != EXPECTED_TOTAL or any(issues[key] for key in blocking):
        print("Dataset NOT written: rows are unmatched/ambiguous/duplicated/invalid, or the row count is not 110. See the report.", file=sys.stderr)
        return 1
    args.dataset_out.write_text(json.dumps(build_dataset(mappings), ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"Dataset written: {args.dataset_out} ({len(mappings)} records)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
