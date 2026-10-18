"""Tests for stores.creator_milestones_store: the single-key GetItem read of the Creator Milestones table."""

import boto3
import pytest
from botocore.exceptions import EndpointConnectionError
from moto import mock_aws

from stores import creator_milestones_store as store

AWS_REGION = "ap-northeast-1"


@pytest.fixture
def table(aws_credentials, monkeypatch):
    """A moto account holding an empty YobiCreatorMilestones table, with the store resource cache reset."""
    monkeypatch.setenv("AWS_DEFAULT_REGION", AWS_REGION)
    monkeypatch.setattr(store, "_cached_resource", None)
    with mock_aws():
        client = boto3.client("dynamodb", region_name=AWS_REGION)
        client.create_table(
            TableName=store.CREATOR_MILESTONES_TABLE,
            AttributeDefinitions=[{"AttributeName": "creatorId", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "creatorId", "KeyType": "HASH"}],
            BillingMode="PAY_PER_REQUEST",
        )
        yield boto3.resource("dynamodb", region_name=AWS_REGION).Table(store.CREATOR_MILESTONES_TABLE)


def test_table_name_default_is_the_seeded_production_table():
    """The store reads the table the seed script and Terraform create."""
    assert store.CREATOR_MILESTONES_TABLE == "YobiCreatorMilestones"


def test_returns_the_three_stored_fields_exactly(table):
    """One item comes back as {creatorId, birthday, debutDate}, the dates as the stored strings."""
    table.put_item(Item={"creatorId": "hoshimachi_suisei", "birthday": "03-22", "debutDate": "2018-03-22"})
    assert store.get_creator_milestones("hoshimachi_suisei") == {"creatorId": "hoshimachi_suisei", "birthday": "03-22", "debutDate": "2018-03-22"}


def test_unknown_id_returns_none(table):
    """An id with no item is None (the API turns that into a 404), never an empty or made-up record."""
    assert store.get_creator_milestones("nobody") is None


def test_reads_only_the_requested_creator(table):
    """Other creators items are never returned for this id."""
    table.put_item(Item={"creatorId": "a", "birthday": "01-01", "debutDate": "2020-01-01"})
    table.put_item(Item={"creatorId": "b", "birthday": "02-02", "debutDate": "2021-02-02"})
    assert store.get_creator_milestones("b")["birthday"] == "02-02"


def test_uses_get_item_never_a_scan():
    """The lookup is one GetItem on the key: a stub table that only supports get_item is enough, so a Scan would fail."""
    calls = []

    class _Table:
        def get_item(self, **kwargs):
            calls.append(kwargs)
            return {"Item": {"creatorId": "a", "birthday": "01-01", "debutDate": "2020-01-01"}}

    class _Resource:
        def Table(self, name):
            return _Table()

    store._cached_resource = _Resource()
    try:
        assert store.get_creator_milestones("a")["debutDate"] == "2020-01-01"
    finally:
        store._cached_resource = None
    assert calls == [{"Key": {"creatorId": "a"}}]


@pytest.mark.parametrize(
    "item",
    [
        {"creatorId": "a", "birthday": "01-01"},
        {"creatorId": "a", "debutDate": "2020-01-01"},
        {"creatorId": "a", "birthday": 101, "debutDate": "2020-01-01"},
    ],
)
def test_malformed_item_raises_instead_of_being_passed_on(table, item):
    """An item missing a date or holding a non-string one is a store error."""
    table.put_item(Item=item)
    with pytest.raises(store.CreatorMilestonesStoreError):
        store.get_creator_milestones("a")


def test_missing_table_raises_store_error(aws_credentials, monkeypatch):
    """A table that cannot be read (here: absent) surfaces as the store's own error type."""
    monkeypatch.setenv("AWS_DEFAULT_REGION", AWS_REGION)
    monkeypatch.setattr(store, "_cached_resource", None)
    with mock_aws():
        with pytest.raises(store.CreatorMilestonesStoreError):
            store.get_creator_milestones("a")


def test_connection_failure_raises_store_error(monkeypatch):
    """A network-level failure is wrapped too."""

    class _Table:
        def get_item(self, **kwargs):
            raise EndpointConnectionError(endpoint_url="http://dynamodb")

    class _Resource:
        def Table(self, name):
            return _Table()

    monkeypatch.setattr(store, "_cached_resource", _Resource())
    with pytest.raises(store.CreatorMilestonesStoreError):
        store.get_creator_milestones("a")


# --- bulk read (GET /milestones): complete scan, pagination, warm-Lambda cache -------------------------------------------------------------


class _PagedTable:
    """A table whose scan() hands out the given pages in order, recording every call (LastEvaluatedKey marks "more")."""

    def __init__(self, pages):
        self.pages = list(pages)
        self.calls = []

    def scan(self, **kwargs):
        self.calls.append(kwargs)
        return self.pages[len(self.calls) - 1]


def _use_table(monkeypatch, table):
    class _Resource:
        def Table(self, name):
            return table

    monkeypatch.setattr(store, "_cached_resource", _Resource())
    store.clear_cache()


def _item(creator_id, birthday="01-01", debut="2020-01-01"):
    return {"creatorId": creator_id, "birthday": birthday, "debutDate": debut}


def test_scan_follows_every_page_until_no_last_evaluated_key(monkeypatch):
    """Three pages are all read, in order, each continuing from the previous LastEvaluatedKey, and their items are all returned."""
    table = _PagedTable(
        [
            {"Items": [_item("b"), _item("a")], "LastEvaluatedKey": {"creatorId": "a"}},
            {"Items": [_item("c")], "LastEvaluatedKey": {"creatorId": "c"}},
            {"Items": [_item("d")]},
        ]
    )
    _use_table(monkeypatch, table)
    records = store.get_all_creator_milestones(now=0.0)
    assert [r["creatorId"] for r in records] == ["a", "b", "c", "d"]
    assert len(table.calls) == 3
    assert "ExclusiveStartKey" not in table.calls[0]
    assert table.calls[1]["ExclusiveStartKey"] == {"creatorId": "a"}
    assert table.calls[2]["ExclusiveStartKey"] == {"creatorId": "c"}


def test_bulk_read_returns_exactly_the_three_fields_and_projects_only_them(monkeypatch):
    """Only creatorId, birthday and debutDate come back (an extra attribute is dropped) and the Scan projects only those."""
    table = _PagedTable([{"Items": [{**_item("a"), "note": "extra"}]}])
    _use_table(monkeypatch, table)
    assert store.get_all_creator_milestones(now=0.0) == [_item("a")]
    assert table.calls[0]["ProjectionExpression"] == "creatorId, birthday, debutDate"


def test_bulk_read_of_a_real_table_returns_all_110_seeded_records(aws_credentials, monkeypatch):
    """Against a moto table seeded with the production dataset every one of the 110 records comes back, sorted, with the stored values."""
    import json
    from pathlib import Path

    monkeypatch.setenv("AWS_DEFAULT_REGION", AWS_REGION)
    monkeypatch.setattr(store, "_cached_resource", None)
    store.clear_cache()
    seed = json.loads((Path(__file__).parent.parent.parent / "scripts" / "migration" / "creator_milestones_seed.json").read_text(encoding="utf-8"))["records"]
    with mock_aws():
        client = boto3.client("dynamodb", region_name=AWS_REGION)
        client.create_table(
            TableName=store.CREATOR_MILESTONES_TABLE,
            AttributeDefinitions=[{"AttributeName": "creatorId", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "creatorId", "KeyType": "HASH"}],
            BillingMode="PAY_PER_REQUEST",
        )
        resource = boto3.resource("dynamodb", region_name=AWS_REGION).Table(store.CREATOR_MILESTONES_TABLE)
        for row in seed:
            resource.put_item(Item={"creatorId": row["creatorId"], "birthday": row["birthday"], "debutDate": row["debutDate"]})
        records = store.get_all_creator_milestones(now=0.0)
    assert len(records) == 110
    assert [r["creatorId"] for r in records] == sorted(r["creatorId"] for r in seed)
    expected = {row["creatorId"]: (row["birthday"], row["debutDate"]) for row in seed}
    assert {r["creatorId"]: (r["birthday"], r["debutDate"]) for r in records} == expected
    assert expected["mano_aloe"] == ("10-28", "2020-08-15")  # a graduated creator keeps the original debut date


def test_cache_hit_does_no_dynamodb_call_until_the_ttl_expires(monkeypatch):
    """Within the TTL the cached roster is served with zero further scans; at the expiry instant the next request scans again."""
    table = _PagedTable([{"Items": [_item("a")]}, {"Items": [_item("a"), _item("b")]}])
    _use_table(monkeypatch, table)
    first = store.get_all_creator_milestones(now=1000.0)
    assert store.get_all_creator_milestones(now=1000.0 + 10) is first
    assert store.get_all_creator_milestones(now=1000.0 + store._ALL_TTL_SECONDS - 1) is first
    assert len(table.calls) == 1

    refreshed = store.get_all_creator_milestones(now=1000.0 + store._ALL_TTL_SECONDS)
    assert len(table.calls) == 2
    assert [r["creatorId"] for r in refreshed] == ["a", "b"]


def test_ttl_is_about_an_hour():
    """The warm-Lambda cache lifetime is one hour."""
    assert store._ALL_TTL_SECONDS == 3600.0


def test_failed_scan_raises_and_is_not_cached(monkeypatch):
    """A DynamoDB failure surfaces as the store error, caches nothing, and the next request tries again."""
    from botocore.exceptions import ClientError

    class _Flaky:
        def __init__(self):
            self.calls = 0

        def scan(self, **kwargs):
            self.calls += 1
            if self.calls == 1:
                raise ClientError({"Error": {"Code": "ProvisionedThroughputExceededException", "Message": "slow down"}}, "Scan")
            return {"Items": [_item("a")]}

    table = _Flaky()
    _use_table(monkeypatch, table)
    with pytest.raises(store.CreatorMilestonesStoreError):
        store.get_all_creator_milestones(now=0.0)
    assert store.get_all_creator_milestones(now=1.0) == [_item("a")]
    assert table.calls == 2


def test_malformed_items_are_skipped_not_passed_on(monkeypatch):
    """An item missing a date or holding a non-string one is dropped; the rest of the roster still comes back."""
    table = _PagedTable([{"Items": [_item("ok"), {"creatorId": "no_debut", "birthday": "01-01"}, {"creatorId": "bad", "birthday": 101, "debutDate": "2020-01-01"}, {"birthday": "01-01", "debutDate": "2020-01-01"}]}])
    _use_table(monkeypatch, table)
    assert store.get_all_creator_milestones(now=0.0) == [_item("ok")]