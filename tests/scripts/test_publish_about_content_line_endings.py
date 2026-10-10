"""Line-ending normalization for scripts/publish_about_content.py.

A Windows checkout (git core.autocrlf=true) holds the About Markdown files with CRLF, and the publisher used to
upload those raw bytes -- production then served CRLF Markdown (V1 localhost validation, 2026-10-09). These
tests pin that every uploaded Markdown object is LF-only regardless of the local file's line endings, without
disturbing the ordering / ContentType / dry-run guarantees covered in test_publish_about_content.py.
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
PAGE_IDS = ["about", "dataSources", "privacy", "terms", "acknowledgements"]


class FakeS3Client:
    """Records every put_object call in order."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def put_object(self, **kwargs: Any) -> None:
        self.calls.append(kwargs)


def _make_content_dir(tmp_path: Path, body: bytes) -> Path:
    """A 3-locale x 5-page content tree whose Markdown files all contain exactly `body` (written as raw bytes)."""
    content_dir = tmp_path / "about"
    manifest: dict[str, Any] = {"schemaVersion": 1, "contentVersion": "crlf-test", "locales": {}}
    for locale in ("zh-TW", "en", "ja"):
        (content_dir / locale).mkdir(parents=True, exist_ok=True)
        pages = []
        for page_id in PAGE_IDS:
            (content_dir / locale / f"{page_id}.md").write_bytes(body)
            pages.append({"id": page_id, "title": f"{locale} {page_id}", "file": f"{locale}/{page_id}.md"})
        manifest["locales"][locale] = {"pages": pages}
    (content_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return content_dir


def _markdown_bodies(client: FakeS3Client) -> list[bytes]:
    """Bodies of every Markdown upload, in upload order."""
    return [call["Body"] for call in client.calls if call["Key"].endswith(".md")]


def test_crlf_markdown_is_uploaded_as_lf(tmp_path):
    content_dir = _make_content_dir(tmp_path, "## Title\r\n\r\nFirst paragraph.\r\n\r\n- one\r\n- two\r\n".encode("utf-8"))
    client = FakeS3Client()

    publish_about_content.publish(client, BUCKET, content_dir=content_dir, dry_run=False)

    bodies = _markdown_bodies(client)
    assert len(bodies) == 15
    for body in bodies:
        assert b"\r" not in body
        assert body == b"## Title\n\nFirst paragraph.\n\n- one\n- two\n"


def test_bare_cr_markdown_is_uploaded_as_lf(tmp_path):
    content_dir = _make_content_dir(tmp_path, "## Title\r\rBody.\r".encode("utf-8"))
    client = FakeS3Client()

    publish_about_content.publish(client, BUCKET, content_dir=content_dir, dry_run=False)

    for body in _markdown_bodies(client):
        assert body == b"## Title\n\nBody.\n"


def test_mixed_line_endings_are_all_normalized(tmp_path):
    content_dir = _make_content_dir(tmp_path, "## Title\r\n\nBody\rmore\r\n".encode("utf-8"))
    client = FakeS3Client()

    publish_about_content.publish(client, BUCKET, content_dir=content_dir, dry_run=False)

    for body in _markdown_bodies(client):
        assert body == b"## Title\n\nBody\nmore\n"


def test_lf_markdown_and_multibyte_text_are_preserved_byte_for_byte(tmp_path):
    original = "## 關於\n\n這是日本語のテスト。\n".encode("utf-8")
    content_dir = _make_content_dir(tmp_path, original)
    client = FakeS3Client()

    publish_about_content.publish(client, BUCKET, content_dir=content_dir, dry_run=False)

    assert all(body == original for body in _markdown_bodies(client))


def test_content_type_ordering_and_manifest_last_are_unchanged_for_crlf_input(tmp_path):
    content_dir = _make_content_dir(tmp_path, b"## T\r\n\r\nBody\r\n")
    client = FakeS3Client()

    publish_about_content.publish(client, BUCKET, content_dir=content_dir, dry_run=False)

    keys = [call["Key"] for call in client.calls]
    assert keys[-1] == "about/manifest.json"
    assert all(key.endswith(".md") for key in keys[:-1])
    for call in client.calls[:-1]:
        assert call["ContentType"] == "text/markdown; charset=utf-8"
    assert client.calls[-1]["ContentType"] == "application/json; charset=utf-8"


def test_dry_run_with_crlf_input_makes_zero_s3_calls(tmp_path):
    content_dir = _make_content_dir(tmp_path, b"## T\r\n\r\nBody\r\n")

    report = publish_about_content.publish(None, BUCKET, content_dir=content_dir, dry_run=True)

    assert report["manifestUploaded"] is False
    assert len(report["markdownFiles"]) == 15


def test_markdown_failure_still_blocks_the_manifest_with_crlf_input(tmp_path):
    content_dir = _make_content_dir(tmp_path, b"## T\r\n\r\nBody\r\n")

    class FailingClient(FakeS3Client):
        """Fails on the 4th Markdown put."""

        def put_object(self, **kwargs: Any) -> None:
            if len(self.calls) == 3:
                raise RuntimeError("boom")
            super().put_object(**kwargs)

    client = FailingClient()
    with pytest.raises(publish_about_content.AboutPublishError):
        publish_about_content.publish(client, BUCKET, content_dir=content_dir, dry_run=False)

    assert all(call["Key"] != "about/manifest.json" for call in client.calls)


def test_the_committed_content_uploads_without_any_carriage_return():
    """Whatever this checkout's line endings are, every committed page is published LF-only."""
    client = FakeS3Client()

    publish_about_content.publish(client, BUCKET, dry_run=False)

    bodies = _markdown_bodies(client)
    assert len(bodies) == 15
    assert all(b"\r" not in body for body in bodies)
