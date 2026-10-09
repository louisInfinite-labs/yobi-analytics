"""Tests for scripts/publish_about_content.py's real-publish ordering
guarantee: every expected Markdown object must upload before manifest.json,
and any Markdown upload failure must stop the publish before manifest.json
is ever touched. Mocks S3 entirely -- no real AWS, no moto (a hand-rolled
fake client gives deterministic control over exactly which call fails,
which moto's real-S3-semantics can't easily do for "fail on the Nth put").
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import pytest

_MODULE_PATH = Path(__file__).resolve().parents[2] / "scripts" / "publish_about_content.py"
_spec = importlib.util.spec_from_file_location("publish_about_content", _MODULE_PATH)
publish_about_content = importlib.util.module_from_spec(_spec)
sys.modules.setdefault("publish_about_content", publish_about_content)
_spec.loader.exec_module(publish_about_content)

BUCKET = "test-history-bucket"


class FakeS3Client:
    """Records every put_object call in order; can be told to raise on a
    specific call index (0-based, across ALL put_object calls -- Markdown
    uploads happen before manifest.json, so a failing index inside the
    Markdown range never reaches the manifest upload)."""

    def __init__(self, fail_at_call_index: int | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self.fail_at_call_index = fail_at_call_index

    def put_object(self, **kwargs: Any) -> None:
        index = len(self.calls)
        if self.fail_at_call_index == index:
            self.calls.append({**kwargs, "Body": "<failed>"})
            raise RuntimeError(f"simulated S3 failure on call #{index}")
        self.calls.append(kwargs)


def _make_content_dir(tmp_path: Path, *, locales: tuple[str, ...] = ("zh-TW", "en", "ja"), pages_per_locale: int = 5) -> Path:
    content_dir = tmp_path / "about"
    manifest: dict[str, Any] = {"schemaVersion": 1, "contentVersion": "test-1", "locales": {}}
    page_ids = ["about", "dataSources", "privacy", "terms", "acknowledgements"][:pages_per_locale]
    for locale in locales:
        (content_dir / locale).mkdir(parents=True, exist_ok=True)
        pages = []
        for page_id in page_ids:
            file_name = f"{page_id}.md"
            (content_dir / locale / file_name).write_text(f"## {page_id}\n\nBody for {locale}/{page_id}.\n", encoding="utf-8")
            pages.append({"id": page_id, "title": f"{locale} {page_id}", "file": f"{locale}/{file_name}"})
        manifest["locales"][locale] = {"pages": pages}
    (content_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return content_dir


def test_dry_run_performs_no_aws_writes(tmp_path):
    content_dir = _make_content_dir(tmp_path)

    report = publish_about_content.publish(None, BUCKET, content_dir=content_dir, dry_run=True)

    assert report["manifestUploaded"] is False
    assert len(report["markdownFiles"]) == 15


def test_real_publish_uploads_all_markdown_before_manifest(tmp_path):
    content_dir = _make_content_dir(tmp_path)
    client = FakeS3Client()

    publish_about_content.publish(client, BUCKET, content_dir=content_dir, dry_run=False)

    keys = [call["Key"] for call in client.calls]
    manifest_index = keys.index("about/manifest.json")
    assert manifest_index == len(keys) - 1  # manifest is the LAST call
    assert all(key.endswith(".md") for key in keys[:manifest_index])


def test_successful_publish_uploads_exactly_15_markdown_files_plus_1_manifest(tmp_path):
    content_dir = _make_content_dir(tmp_path)
    client = FakeS3Client()

    report = publish_about_content.publish(client, BUCKET, content_dir=content_dir, dry_run=False)

    assert len(report["markdownFiles"]) == 15
    assert report["manifestUploaded"] is True
    md_keys = [c["Key"] for c in client.calls if c["Key"].endswith(".md")]
    assert len(md_keys) == 15
    manifest_keys = [c["Key"] for c in client.calls if c["Key"] == "about/manifest.json"]
    assert len(manifest_keys) == 1


@pytest.mark.parametrize("fail_at_call_index", [0, 7, 14])
def test_markdown_upload_failure_prevents_manifest_upload(tmp_path, fail_at_call_index):
    """Failure on the first, a middle, and the last Markdown upload -- in
    every case manifest.json must never be uploaded."""
    content_dir = _make_content_dir(tmp_path)
    client = FakeS3Client(fail_at_call_index=fail_at_call_index)

    with pytest.raises(publish_about_content.AboutPublishError, match="manifest.json was NOT uploaded"):
        publish_about_content.publish(client, BUCKET, content_dir=content_dir, dry_run=False)

    assert all(call["Key"] != "about/manifest.json" for call in client.calls)
    assert len(client.calls) == fail_at_call_index + 1  # stopped immediately, no further attempts


def test_manifest_upload_failure_is_also_reported_as_a_publish_error(tmp_path):
    content_dir = _make_content_dir(tmp_path)
    client = FakeS3Client(fail_at_call_index=15)  # the 16th call -- manifest.json itself

    with pytest.raises(publish_about_content.AboutPublishError, match="manifest.json upload failed"):
        publish_about_content.publish(client, BUCKET, content_dir=content_dir, dry_run=False)

    md_keys = [c["Key"] for c in client.calls if c["Key"].endswith(".md")]
    assert len(md_keys) == 15  # all markdown already succeeded before the manifest call failed


def _set_first_page_file(content_dir: Path, file_value: Any) -> None:
    manifest_path = content_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["locales"]["en"]["pages"][0]["file"] = file_value
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")


@pytest.mark.parametrize("bad_file", ["../zh-TW/about.md", "../../outside.md", "en/../../outside.md", "en/about.txt", "", 5, None])
def test_a_manifest_page_path_that_escapes_its_locale_or_is_not_markdown_is_rejected_before_any_upload(tmp_path, bad_file):
    content_dir = _make_content_dir(tmp_path)
    (tmp_path / "outside.md").write_text("secret\n", encoding="utf-8")
    (content_dir / "en" / "about.txt").write_text("not markdown\n", encoding="utf-8")
    _set_first_page_file(content_dir, bad_file)
    client = FakeS3Client()

    with pytest.raises(publish_about_content.AboutPublishError):
        publish_about_content.publish(client, BUCKET, content_dir=content_dir, dry_run=False)

    assert client.calls == []


def test_an_unreadable_declared_markdown_file_is_a_publish_error_not_a_crash(tmp_path):
    content_dir = _make_content_dir(tmp_path)
    (content_dir / "en" / "privacy.md").write_bytes(b"\xff\xfe not utf-8 \x80")
    client = FakeS3Client()

    with pytest.raises(publish_about_content.AboutPublishError):
        publish_about_content.publish(client, BUCKET, content_dir=content_dir, dry_run=False)

    assert client.calls == []


def test_expected_markdown_files_rejects_a_missing_locale(tmp_path):
    content_dir = _make_content_dir(tmp_path, locales=("zh-TW", "en"))  # ja missing entirely
    manifest = publish_about_content._read_local_manifest(content_dir)

    with pytest.raises(publish_about_content.AboutPublishError, match="locales must be exactly"):
        publish_about_content._expected_markdown_files(manifest, content_dir)


def test_expected_markdown_files_rejects_wrong_page_count(tmp_path):
    content_dir = _make_content_dir(tmp_path, pages_per_locale=3)

    manifest = publish_about_content._read_local_manifest(content_dir)
    with pytest.raises(publish_about_content.AboutPublishError, match="must declare exactly 5 pages"):
        publish_about_content._expected_markdown_files(manifest, content_dir)


def test_expected_markdown_files_rejects_a_declared_file_that_does_not_exist(tmp_path):
    content_dir = _make_content_dir(tmp_path)
    manifest = publish_about_content._read_local_manifest(content_dir)
    manifest["locales"]["en"]["pages"][0]["file"] = "en/does-not-exist.md"

    with pytest.raises(publish_about_content.AboutPublishError, match="is missing"):
        publish_about_content._expected_markdown_files(manifest, content_dir)


def test_broken_manifest_content_is_rejected_by_existing_validation_before_any_upload(tmp_path):
    content_dir = _make_content_dir(tmp_path)
    manifest_path = content_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["schemaVersion"] = "not-an-int"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    client = FakeS3Client()

    with pytest.raises(publish_about_content.AboutPublishError):
        publish_about_content.publish(client, BUCKET, content_dir=content_dir, dry_run=False)

    assert client.calls == []  # validation runs before any upload is attempted


def test_the_actually_committed_content_resolves_to_exactly_15_markdown_files():
    """Guards the real src/content/about/ tree this repo ships, not just a tmp fixture."""
    manifest = publish_about_content._read_local_manifest(publish_about_content.CONTENT_DIR)
    expected = publish_about_content._expected_markdown_files(manifest, publish_about_content.CONTENT_DIR)
    assert len(expected) == 15
    assert {locale for locale, _, _ in expected} == {"zh-TW", "en", "ja"}
