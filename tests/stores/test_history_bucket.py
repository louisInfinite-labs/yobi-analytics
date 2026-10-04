"""YOBI_HISTORY_BUCKET is an OPTIONAL OVERRIDE on the read side: unset/blank falls back to the fixed bucket.

Covers the shared resolver (stores.history_bucket), the two read-side store factories built on it, the guard
that the fallback literal has exactly one home, and that the write-side factories stay strict (no silent
default to the production bucket).
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from stores.history_bucket import DEFAULT_HISTORY_BUCKET, HISTORY_BUCKET_ENV_VAR, resolve_history_bucket
from stores.subscriber_ranking_store import S3SubscriberRankingStore
from stores.video_ranking_store import S3VideoRankingStore

REPO_ROOT = Path(__file__).resolve().parents[2]
SRC = REPO_ROOT / "src"
HISTORY_TF = REPO_ROOT / "terraform" / "history.tf"

READ_SIDE_FACTORIES = [S3VideoRankingStore, S3SubscriberRankingStore]


class _StubS3Client:
    """Stands in for boto3's client so factory tests never build (or call) a real one."""


# --- the resolver -----------------------------------------------------------------------------------------


def test_the_env_var_name_and_the_fallback_are_exactly_the_documented_values():
    """Pins the public contract: the override variable's name and the fixed default bucket."""
    assert HISTORY_BUCKET_ENV_VAR == "YOBI_HISTORY_BUCKET"
    assert DEFAULT_HISTORY_BUCKET == "yobi-analytics-history"


def test_the_fallback_is_the_bucket_terraform_actually_creates():
    """Drift guard: the code default must equal the `history` bucket's name in terraform/history.tf."""
    match = re.search(
        r'resource\s+"aws_s3_bucket"\s+"history"\s*\{[^}]*?\bbucket\s*=\s*"([^"]+)"', HISTORY_TF.read_text(encoding="utf-8")
    )
    assert match is not None, "aws_s3_bucket.history not found in terraform/history.tf"
    assert match.group(1) == DEFAULT_HISTORY_BUCKET


def test_an_explicit_env_value_overrides_the_fallback(monkeypatch):
    """A non-blank YOBI_HISTORY_BUCKET wins over the default."""
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", "some-other-bucket")

    assert resolve_history_bucket() == "some-other-bucket"


def test_an_unset_env_var_uses_the_fallback(monkeypatch):
    """No YOBI_HISTORY_BUCKET at all -> the fixed production bucket."""
    monkeypatch.delenv("YOBI_HISTORY_BUCKET", raising=False)

    assert resolve_history_bucket() == "yobi-analytics-history"


@pytest.mark.parametrize("blank", ["", " ", "   ", "\t", "\n"])
def test_an_empty_or_blank_env_var_also_uses_the_fallback(monkeypatch, blank):
    """The repo-wide convention is `if not os.environ.get(...)`: empty means unset, never an invalid bucket name."""
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", blank)

    assert resolve_history_bucket() == "yobi-analytics-history"


def test_surrounding_whitespace_on_an_override_is_ignored(monkeypatch):
    """A pasted value with stray spaces still resolves to the intended bucket name."""
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", "  some-other-bucket \n")

    assert resolve_history_bucket() == "some-other-bucket"


def test_the_resolver_reads_the_environment_at_call_time_not_import_time(monkeypatch):
    """Tests (and a Lambda env change) must be able to flip the override without reloading the module."""
    monkeypatch.delenv("YOBI_HISTORY_BUCKET", raising=False)
    assert resolve_history_bucket() == DEFAULT_HISTORY_BUCKET

    monkeypatch.setenv("YOBI_HISTORY_BUCKET", "flipped-bucket")
    assert resolve_history_bucket() == "flipped-bucket"


# --- the read-side store factories ------------------------------------------------------------------------


@pytest.mark.parametrize("store_class", READ_SIDE_FACTORIES)
def test_read_side_factory_uses_the_fallback_bucket_when_unset(monkeypatch, store_class):
    """The API Lambda has no env var: the store must target the fixed bucket."""
    monkeypatch.delenv("YOBI_HISTORY_BUCKET", raising=False)

    store = store_class.from_environment_or_default(s3_client=_StubS3Client())

    assert store.bucket_name == "yobi-analytics-history"


@pytest.mark.parametrize("store_class", READ_SIDE_FACTORIES)
def test_read_side_factory_uses_the_fallback_bucket_when_blank(monkeypatch, store_class):
    """An empty override (e.g. a blanked Lambda variable) must not reach the store as an invalid bucket."""
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", "")

    store = store_class.from_environment_or_default(s3_client=_StubS3Client())

    assert store.bucket_name == "yobi-analytics-history"


@pytest.mark.parametrize("store_class", READ_SIDE_FACTORIES)
def test_read_side_factory_honours_the_env_override(monkeypatch, store_class):
    """The override still wins, which is how moto/staging point the read path at another bucket."""
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", "override-bucket")

    store = store_class.from_environment_or_default(s3_client=_StubS3Client())

    assert store.bucket_name == "override-bucket"


@pytest.mark.parametrize("store_class", READ_SIDE_FACTORIES)
def test_read_side_factory_passes_the_injected_client_through(monkeypatch, store_class):
    """An injected client is used as-is (no boto3 client is created behind the caller's back)."""
    monkeypatch.delenv("YOBI_HISTORY_BUCKET", raising=False)
    client = _StubS3Client()

    assert store_class.from_environment_or_default(s3_client=client).s3_client is client


# --- the write side stays strict --------------------------------------------------------------------------


@pytest.mark.parametrize("store_class", READ_SIDE_FACTORIES)
def test_write_side_from_environment_still_has_no_default(monkeypatch, store_class):
    """from_environment() (used by the reducer's writer path) must keep returning None when unset."""
    monkeypatch.delenv("YOBI_HISTORY_BUCKET", raising=False)

    assert store_class.from_environment(s3_client=_StubS3Client()) is None


def test_write_side_modules_never_import_the_fallback():
    """Only the two read-side stores may import the resolver: writers/backfills must keep requiring an explicit bucket."""
    importers = sorted(
        path.relative_to(SRC).as_posix()
        for path in SRC.rglob("*.py")
        if "history_bucket import" in path.read_text(encoding="utf-8") and path.name != "history_bucket.py"
    )

    assert importers == ["stores/subscriber_ranking_store.py", "stores/video_ranking_store.py"]


def test_the_fallback_literal_has_exactly_one_home_in_src():
    """No other source file may hard-code the bucket name; everything goes through stores.history_bucket."""
    literal = re.compile(r"yobi-analytics-history(?![\w-])")
    offenders = sorted(
        path.relative_to(SRC).as_posix()
        for path in SRC.rglob("*.py")
        if literal.search(path.read_text(encoding="utf-8")) and path.name != "history_bucket.py"
    )

    assert offenders == []


def test_read_api_serves_only_through_the_read_side_factories():
    """Every serving path in read_api must use from_environment_or_default(); the strict factory would 503 forever."""
    source = (SRC / "api" / "read_api.py").read_text(encoding="utf-8")

    assert ".from_environment()" not in source
    assert source.count(".from_environment_or_default()") == 5
