"""Seed script + dataset checks for the CreatorMilestones table: validation, dry-run safety, idempotency, and the 110-creator dataset."""

import json
import os
from collections import Counter
from datetime import date
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

from scripts.migration import build_creator_milestones_dataset as builder
from scripts.migration import seed_creator_milestones_dynamodb as seed
from tracking.creator_master import load_creators

AWS_REGION = "ap-northeast-1"
TODAY = date(2026, 10, 18)
TABLE = seed.CREATOR_MILESTONES_TABLE
OTHER_TABLE = "YobiRemoteConfig"
MASTER_IDS = {creator.creator_id for creator in load_creators()}


def _dataset() -> list[dict]:
    """The committed seed dataset's records."""
    return seed.load_dataset(seed.DEFAULT_DATASET_PATH)


def _record(**overrides) -> dict:
    fields = {"creatorId": "hakos_baelz", "birthday": "02-29", "debutDate": "2021-08-23"}
    fields.update(overrides)
    return fields


@pytest.fixture
def tables(aws_credentials, monkeypatch):
    """A moto account with the milestones table plus an unrelated table that must never be touched."""
    monkeypatch.setenv("AWS_DEFAULT_REGION", AWS_REGION)
    with mock_aws():
        client = boto3.client("dynamodb", region_name=AWS_REGION)
        client.create_table(
            TableName=TABLE,
            AttributeDefinitions=[{"AttributeName": "creatorId", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "creatorId", "KeyType": "HASH"}],
            BillingMode="PAY_PER_REQUEST",
        )
        client.create_table(
            TableName=OTHER_TABLE,
            AttributeDefinitions=[{"AttributeName": "clientId", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "clientId", "KeyType": "HASH"}],
            BillingMode="PAY_PER_REQUEST",
        )
        client.put_item(TableName=OTHER_TABLE, Item={"clientId": {"S": "keep-me"}})
        resource = boto3.resource("dynamodb", region_name=AWS_REGION)
        yield resource.Table(TABLE), resource.Table(OTHER_TABLE)


# --- dataset -------------------------------------------------------------------------------------------------------------------------


def test_dataset_has_110_records_and_all_are_valid():
    """All 110 rows are accepted by the seed's own validation, none rejected."""
    records, rejected = seed.validate_records(_dataset(), MASTER_IDS, today=TODAY)
    assert rejected == []
    assert len(records) == 110


def test_dataset_creator_ids_are_unique_and_all_in_creator_master():
    """No duplicate id, and every id is an existing Creator Master id (nothing generated)."""
    ids = [row["creatorId"] for row in _dataset()]
    assert len(ids) == len(set(ids))
    assert set(ids) <= MASTER_IDS


def test_dataset_covers_every_individual_member_by_branch():
    """25 VSPO JP + 7 VSPO EN + 52 hololive JP + 17 EN + 9 ID, and every member channel of Creator Master has a row."""
    creators = {creator.creator_id: creator for creator in load_creators()}
    per_branch = Counter(creators[row["creatorId"]].branch for row in _dataset())
    assert per_branch == {"vspo_jp": 25, "vspo_en": 7, "holo_jp": 52, "holo_en": 17, "holo_id": 9}
    members = {cid for cid, creator in creators.items() if creator.channel_type == "member"}
    assert {row["creatorId"] for row in _dataset()} == members


def test_dataset_formats_birthday_mm_dd_and_debut_with_year():
    """Birthday has no year; debut is a full ISO date with a four-digit year."""
    for row in _dataset():
        assert len(row["birthday"]) == 5 and row["birthday"][2] == "-", row
        assert len(row["debutDate"]) == 10 and row["debutDate"][4] == "-" and row["debutDate"][7] == "-", row


def test_graduated_creators_are_retained_with_original_debut_dates():
    """Lifecycle never filters rows: every graduated creator is present, and debuted before they graduated."""
    rows = {row["creatorId"]: row for row in _dataset()}
    graduated = [creator for creator in load_creators() if creator.lifecycle_stage == "graduated"]
    assert len(graduated) == 13
    for creator in graduated:
        assert creator.creator_id in rows
        assert rows[creator.creator_id]["debutDate"] < creator.graduated_at
    assert rows["mano_aloe"]["debutDate"] == "2020-08-15"


def test_feb_29_birthday_is_present_in_dataset():
    """Hakos Baelz's Feb 29 birthday survives into the dataset."""
    assert {row["creatorId"]: row["birthday"] for row in _dataset()}["hakos_baelz"] == "02-29"


# --- the Markdown build (parsing + Creator Master mapping) -----------------------------------------------------------------------------

_SAMPLE_MARKDOWN = """# t

## VSPO! EN（1 人）

| 成員 | 生日（MM/DD） | 原出道日（YYYY/MM/DD） |
|---|---|---|
| Remia Aotsuki | 02/03 | 2024/06/30 |

## hololive EN / Promise（2 人）

| 成員 | 生日（MM/DD） | 原出道日（YYYY/MM/DD） |
|---|---|---|
| Hakos Baelz | 02/29 | 2021/08/23 |
| Somebody Unknown | 01/01 | 2021/08/23 |
"""


def test_markdown_rows_are_parsed_with_converted_formats():
    """MM/DD -> MM-DD and YYYY/MM/DD -> YYYY-MM-DD, every row under its section."""
    records = builder.parse_markdown(_SAMPLE_MARKDOWN)
    assert [(r.name, r.birthday, r.debut_date) for r in records] == [
        ("Remia Aotsuki", "02-03", "2024-06-30"),
        ("Hakos Baelz", "02-29", "2021-08-23"),
        ("Somebody Unknown", "01-01", "2021-08-23"),
    ]


def test_mapping_reports_unmatched_rows_instead_of_inventing_ids():
    """A romanised VSPO EN name maps by slug; an unknown name is reported unmatched with no creator."""
    mappings = builder.map_records(builder.parse_markdown(_SAMPLE_MARKDOWN), load_creators())
    assert [(m.status, m.creator.creator_id if m.creator else None) for m in mappings] == [
        ("slug", "remia_aotsuki"),
        ("name", "hakos_baelz"),
        ("unmatched", None),
    ]


def test_malformed_table_row_is_reported_not_skipped():
    """A row with a mistyped date is listed by find_malformed_rows; the header and separator rows are not."""
    text = _SAMPLE_MARKDOWN + "| Broken Row | 1/01 | 2021/08/23 |\n"
    found = builder.find_malformed_rows(text)
    assert len(found) == 1 and "Broken Row" in found[0]
    assert builder.find_malformed_rows(_SAMPLE_MARKDOWN) == []


def test_build_refuses_to_write_the_dataset_when_a_row_is_malformed(tmp_path, capsys):
    """A malformed row is written into the report and blocks the dataset output."""
    markdown = tmp_path / "source.md"
    markdown.write_text(_SAMPLE_MARKDOWN + "| Broken Row | 1/01 | 2021/08/23 |\n", encoding="utf-8")
    out, report = tmp_path / "dataset.json", tmp_path / "report.md"
    code = builder.main(["--markdown", str(markdown), "--dataset-out", str(out), "--report-out", str(report)])
    assert code == 1 and not out.exists()
    assert "Broken Row" in report.read_text(encoding="utf-8")


def test_apostrophe_variants_map_to_the_same_creator():
    """A curly apostrophe in the Markdown still matches Creator Master's straight one."""
    record = builder.MarkdownRecord("hololive EN / Myth", 1, "Ninomae Ina’nis", "05-20", "2020-09-13", 1)
    assert builder.map_records([record], load_creators())[0].creator.creator_id == "ninomae_inanis"


@pytest.mark.skipif(not os.environ.get("YOBI_MILESTONES_MARKDOWN"), reason="set YOBI_MILESTONES_MARKDOWN to the source Markdown path")
def test_real_markdown_parses_110_rows_all_mapped_and_matches_the_dataset():
    """The source Markdown (outside the repo) parses to 110 rows, all mapped, and equals the committed dataset."""
    text = Path(os.environ["YOBI_MILESTONES_MARKDOWN"]).read_text(encoding="utf-8")
    mappings = builder.map_records(builder.parse_markdown(text), load_creators())
    assert len(mappings) == 110
    assert all(m.creator is not None for m in mappings)
    assert builder.build_dataset(mappings)["records"] == _dataset()


# --- validation ------------------------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("value", ["01-01", "02-29", "12-31"])
def test_valid_birthdays(value):
    """Plain MM-DD days are accepted, including Feb 29."""
    assert seed.valid_birthday(value)


@pytest.mark.parametrize("value", ["02-30", "04-31", "13-01", "00-10", "1-1", "2000-02-29", "02/29", "", None, 229, "02-29\n", "٠٢-٢٩"])
def test_invalid_birthdays_are_rejected(value):
    """Non-calendar days, wrong shapes and a year-bearing value are rejected."""
    assert not seed.valid_birthday(value)


@pytest.mark.parametrize("value", ["2018-10-20", "2020-02-29", "2026-10-18"])
def test_valid_debut_dates(value):
    """A full past or present YYYY-MM-DD is accepted (2020 is a leap year)."""
    assert seed.valid_debut_date(value, today=TODAY)


@pytest.mark.parametrize("value", ["2021-02-29", "2020-13-01", "2018-10", "18-10-20", "2018/10/20", "2026-10-19", "", None, "2020-02-29\n", "٢٠٢٠-٠٢-٢٩"])
def test_invalid_debut_dates_are_rejected(value):
    """Impossible dates, missing year/day, other separators and future dates are rejected."""
    assert not seed.valid_debut_date(value, today=TODAY)


def test_validation_rejects_unknown_ids_duplicates_and_bad_values_without_dropping_silently():
    """Each bad row is reported with its reason; a duplicated id is rejected on every occurrence."""
    rows = [
        _record(),
        _record(creatorId="not_in_master"),
        _record(creatorId="gigi_murin", birthday="02-30"),
        _record(creatorId="gigi_murin", birthday="10-18"),
        _record(creatorId="irys", debutDate="2021/07/11"),
        _record(creatorId="ouro_kronii", extra="x"),
        "not an object",
    ]
    valid, rejected = seed.validate_records(rows, MASTER_IDS, today=TODAY)
    assert [r.creator_id for r in valid] == ["hakos_baelz"]
    reasons = dict(rejected)
    assert "not in Creator Master" in reasons["not_in_master"]
    assert len(rejected) == 6
    assert sum("duplicate creatorId" in reason for _, reason in rejected) == 2


# --- seed behaviour --------------------------------------------------------------------------------------------------------------------


def test_offline_dry_run_makes_no_aws_call():
    """With no table the run validates only: no boto3 resource is ever created."""
    report = seed.run(_dataset(), MASTER_IDS, today=TODAY)
    assert report.total == 110 and not report.rejected
    assert report.inserted == [] and report.mode == "offline dry run"


def test_read_only_dry_run_against_a_table_writes_nothing(tables):
    """A table without apply reports what would be inserted but stores zero items."""
    table, _ = tables
    report = seed.run(_dataset(), MASTER_IDS, table=table, apply=False, today=TODAY)
    assert len(report.inserted) == 110
    assert table.scan()["Items"] == []


def test_apply_inserts_all_110_then_rerun_is_idempotent(tables):
    """First apply inserts 110 items of exactly {creatorId, birthday, debutDate}; the second changes nothing."""
    table, _ = tables
    first = seed.run(_dataset(), MASTER_IDS, table=table, apply=True, today=TODAY)
    assert len(first.inserted) == 110
    items = table.scan()["Items"]
    assert len(items) == 110
    assert all(set(item) == {"creatorId", "birthday", "debutDate"} for item in items)
    assert table.get_item(Key={"creatorId": "hakos_baelz"})["Item"]["birthday"] == "02-29"
    assert table.get_item(Key={"creatorId": "mano_aloe"})["Item"]["debutDate"] == "2020-08-15"

    second = seed.run(_dataset(), MASTER_IDS, table=table, apply=True, today=TODAY)
    assert second.inserted == [] and len(second.unchanged) == 110 and second.conflicting == []
    assert len(table.scan()["Items"]) == 110


def test_conflicting_stored_value_is_reported_and_not_overwritten(tables):
    """A differing stored date is a conflict and stays untouched without --update-conflicts."""
    table, _ = tables
    table.put_item(Item={"creatorId": "hakos_baelz", "birthday": "02-28", "debutDate": "2021-08-23"})
    report = seed.run([_record()], MASTER_IDS, table=table, apply=True, today=TODAY)
    assert [c[0] for c in report.conflicting] == ["hakos_baelz"]
    assert table.get_item(Key={"creatorId": "hakos_baelz"})["Item"]["birthday"] == "02-28"


def test_update_conflicts_overwrites_only_the_two_milestone_attributes(tables):
    """With update_conflicts the two values are corrected and an unrelated attribute survives."""
    table, _ = tables
    table.put_item(Item={"creatorId": "hakos_baelz", "birthday": "02-28", "debutDate": "2021-08-23", "note": "keep"})
    report = seed.run([_record()], MASTER_IDS, table=table, apply=True, update_conflicts=True, today=TODAY)
    assert report.updated == ["hakos_baelz"]
    item = table.get_item(Key={"creatorId": "hakos_baelz"})["Item"]
    assert (item["birthday"], item["note"]) == ("02-29", "keep")


def test_insert_never_clobbers_an_item_created_concurrently(tables):
    """The conditional insert leaves an item that appeared after the read untouched."""
    table, _ = tables
    table.put_item(Item={"creatorId": "hakos_baelz", "birthday": "09-09", "debutDate": "2000-01-01"})
    assert seed._insert(table, seed.MilestoneRecord("hakos_baelz", "02-29", "2021-08-23")) is False
    assert table.get_item(Key={"creatorId": "hakos_baelz"})["Item"]["birthday"] == "09-09"


def test_lost_insert_race_is_reclassified_not_reported_as_inserted(tables, monkeypatch):
    """If the conditional insert loses a race, the item that is there now is classified (conflicting here), never counted as inserted."""
    table, _ = tables
    real_insert = seed._insert

    def _lose_race(tbl, record):
        tbl.put_item(Item={"creatorId": record.creator_id, "birthday": "09-09", "debutDate": record.debut_date})
        return real_insert(tbl, record)

    monkeypatch.setattr(seed, "_insert", _lose_race)
    report = seed.run([_record()], MASTER_IDS, table=table, apply=True, today=TODAY)
    assert report.inserted == []
    assert [c[0] for c in report.conflicting] == ["hakos_baelz"]
    assert table.get_item(Key={"creatorId": "hakos_baelz"})["Item"]["birthday"] == "09-09"


def test_lost_insert_race_with_identical_values_is_unchanged(tables, monkeypatch):
    """A race that left identical values is reported unchanged, not inserted."""
    table, _ = tables
    real_insert = seed._insert

    def _lose_race(tbl, record):
        tbl.put_item(Item={"creatorId": record.creator_id, "birthday": record.birthday, "debutDate": record.debut_date})
        return real_insert(tbl, record)

    monkeypatch.setattr(seed, "_insert", _lose_race)
    report = seed.run([_record()], MASTER_IDS, table=table, apply=True, today=TODAY)
    assert report.inserted == [] and report.unchanged == ["hakos_baelz"]


def test_rejected_record_aborts_before_any_write(tables):
    """One bad row means nothing at all is written, even for the valid rows."""
    table, _ = tables
    report = seed.run([_record(), _record(creatorId="irys", birthday="02-30")], MASTER_IDS, table=table, apply=True, today=TODAY)
    assert len(report.rejected) == 1 and "ABORTED" in report.mode
    assert table.scan()["Items"] == []


def test_seeding_leaves_other_tables_untouched(tables):
    """An unrelated existing table keeps exactly its items through a full apply."""
    table, other = tables
    seed.run(_dataset(), MASTER_IDS, table=table, apply=True, today=TODAY)
    assert other.scan()["Items"] == [{"clientId": "keep-me"}]


# --- CLI gates -------------------------------------------------------------------------------------------------------------------------


def test_cli_default_never_touches_aws(monkeypatch, capsys):
    """No flags: offline validation, and the AWS resource factory is never reached."""
    monkeypatch.setattr(seed, "_table", lambda *a, **k: pytest.fail("default run must not contact AWS"))
    assert seed.main([]) == 0
    assert "offline dry run" in capsys.readouterr().out


def test_cli_apply_without_explicit_production_target_is_refused(monkeypatch):
    """--apply alone is a usage error (exit 2), and nothing is written."""
    monkeypatch.setattr(seed, "_table", lambda *a, **k: pytest.fail("must not contact AWS"))
    with pytest.raises(SystemExit) as exc:
        seed.main(["--apply"])
    assert exc.value.code == 2


def test_cli_production_target_without_apply_writes_nothing(tables, monkeypatch):
    """--target production alone reads only: the table stays empty and the run reports the inserts it would do."""
    table, _ = tables
    monkeypatch.setattr(seed, "_table", lambda *a, **k: table)
    assert seed.main(["--target", "production"]) == 0
    assert table.scan()["Items"] == []


def test_cli_target_production_with_apply_writes(tables, monkeypatch):
    """Both flags together write the 110 items."""
    table, _ = tables
    monkeypatch.setattr(seed, "_table", lambda *a, **k: table)
    assert seed.main(["--target", "production", "--apply"]) == 0
    assert len(table.scan()["Items"]) == 110


def test_cli_fails_safely_when_dataset_is_missing(tmp_path, capsys):
    """A missing dataset is a config error (exit 2), not a traceback."""
    assert seed.main(["--dataset", str(tmp_path / "nope.json")]) == 2
    assert "Dataset not found" in capsys.readouterr().err


def test_cli_fails_safely_without_aws_region_or_credentials(monkeypatch, capsys):
    """No region/credentials on a production run is a config error (exit 2) before any write."""
    for name in ("AWS_DEFAULT_REGION", "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_PROFILE", "AWS_CONFIG_FILE"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("AWS_CONFIG_FILE", os.devnull)
    monkeypatch.setenv("AWS_SHARED_CREDENTIALS_FILE", os.devnull)
    assert seed.main(["--target", "production", "--apply"]) == 2
    assert "CONFIG ERROR" in capsys.readouterr().err


def test_dataset_file_is_plain_json_with_a_records_list():
    """Guards the on-disk shape the seed expects."""
    payload = json.loads(seed.DEFAULT_DATASET_PATH.read_text(encoding="utf-8"))
    assert isinstance(payload["records"], list)


def test_cli_reports_a_missing_table_clearly_and_writes_nothing(aws_credentials, monkeypatch, capsys):
    """Before Terraform has created the table, a production run ends with a clear message (exit 2), not a traceback."""
    monkeypatch.setenv("AWS_DEFAULT_REGION", AWS_REGION)
    with mock_aws():
        assert seed.main(["--target", "production", "--apply"]) == 2
    assert "TABLE MISSING" in capsys.readouterr().err
