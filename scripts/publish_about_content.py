"""Publish the About/Information area's canonical content (src/content/about/)
to its remote S3 store (yobi-analytics-history bucket, "about/" prefix).

This is the ONLY step an ordinary content edit needs: edit a .md file or
manifest.json locally, run this script, done. No Lambda redeploy, no
Terraform apply, no frontend rebuild, no native app release -- the deployed
API Lambda (api.about_content_api.get_about_content) reads this same S3
location on every request.

    .venv/bin/python scripts/publish_about_content.py --dry-run
    .venv/bin/python scripts/publish_about_content.py
    .venv/bin/python scripts/publish_about_content.py --bucket my-test-bucket

PUBLISH ORDER IS EXPLICIT, NOT ALPHABETICAL: every expected Markdown object
(derived from the LOCAL manifest's own locale/page list, not a directory
listing) is uploaded first, in manifest order. manifest.json is uploaded
only after every one of those uploads has succeeded. If any Markdown upload
fails, this script stops immediately with a non-zero exit code and never
touches manifest.json -- a reader hitting the live API mid-publish always
sees either the complete old manifest + old content, or the complete new
manifest + new content, never a manifest that references a page that
isn't there yet. See publish() below for the actual enforcement.

Validates the local manifest.json + referenced Markdown files with
api.about_content_api.validate_about_content, and separately confirms the
exact expected shape (3 locales, 5 pages each, every declared file present
on disk) before uploading anything -- a structurally broken or incomplete
local edit is refused rather than partially published.
"""

from __future__ import annotations

import argparse
import mimetypes
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
CONTENT_DIR = ROOT / "src" / "content" / "about"

sys.path.insert(0, str(ROOT / "src"))

from api.about_content_api import AboutContentValidationError, validate_about_content  # noqa: E402
from stores.about_content_store import LocalAboutContentStore, S3AboutContentStore  # noqa: E402
from stores.history_bucket import resolve_history_bucket  # noqa: E402

# This script's own guardrail, deliberately stricter than
# api.about_content_api.validate_about_content (which intentionally doesn't
# hardcode a fixed locale set -- adding a locale there is an ordinary
# content change, not a schema change). Here, for a human doing a content
# edit, catching "I only updated 2 of 3 locales" or "I forgot a page"
# before anything is uploaded is exactly the point.
REQUIRED_LOCALES = ("zh-TW", "en", "ja")
REQUIRED_PAGE_COUNT = 5


class AboutPublishError(RuntimeError):
    """Raised when local content fails validation, the expected Markdown
    set is incomplete, or a Markdown upload fails mid-publish. In every
    case the caller must stop and must not upload manifest.json."""


def _content_type(path: Path) -> str:
    if path.suffix == ".md":
        return "text/markdown; charset=utf-8"
    if path.suffix == ".json":
        return "application/json; charset=utf-8"
    return mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def _read_local_manifest(content_dir: Path) -> dict[str, Any]:
    return LocalAboutContentStore(content_dir).read_manifest()


def _validate_local_content(content_dir: Path) -> None:
    """Assembles the local manifest + markdown into the same shape
    get_about_content() would return, and runs it through
    validate_about_content() -- catches a broken local edit before it's
    ever uploaded."""
    store = LocalAboutContentStore(content_dir)
    manifest = store.read_manifest()
    locales = {}
    for locale, locale_value in manifest["locales"].items():
        pages = []
        for page in locale_value["pages"]:
            markdown = store.read_page_markdown(page["file"])
            pages.append({"id": page["id"], "title": page["title"], "markdown": markdown})
        locales[locale] = {"pages": pages}
    payload = {"schemaVersion": manifest["schemaVersion"], "contentVersion": manifest["contentVersion"], "locales": locales}
    try:
        validate_about_content(payload)
    except AboutContentValidationError as exc:
        raise AboutPublishError(f"local content failed validation: {exc}") from exc


def _expected_markdown_files(manifest: dict[str, Any], content_dir: Path) -> list[tuple[str, str, str]]:
    """Returns (locale, pageId, relativeFile) for every Markdown object this
    publish must upload, in manifest order -- the EXACT expected set (3
    required locales, REQUIRED_PAGE_COUNT pages each, every declared file
    present on disk), not a directory listing and not alphabetical. Raises
    AboutPublishError on any shortfall -- a missing locale, a locale with
    the wrong page count, or a declared file that doesn't exist -- before
    a single upload happens."""
    locales = manifest.get("locales", {})
    if set(locales) != set(REQUIRED_LOCALES):
        raise AboutPublishError(f"manifest locales must be exactly {REQUIRED_LOCALES}, got {sorted(locales)}")

    expected: list[tuple[str, str, str]] = []
    for locale in REQUIRED_LOCALES:
        pages = locales[locale].get("pages", [])
        if len(pages) != REQUIRED_PAGE_COUNT:
            raise AboutPublishError(f"locale {locale!r} must declare exactly {REQUIRED_PAGE_COUNT} pages, got {len(pages)}")
        for page in pages:
            relative_file = page["file"]
            if not (content_dir / relative_file).exists():
                raise AboutPublishError(f"expected markdown file is missing: {relative_file} (locale={locale}, page={page['id']})")
            expected.append((locale, page["id"], relative_file))

    if len(expected) != len(REQUIRED_LOCALES) * REQUIRED_PAGE_COUNT:
        raise AboutPublishError(f"expected {len(REQUIRED_LOCALES) * REQUIRED_PAGE_COUNT} markdown files, resolved {len(expected)}")
    return expected


def publish(client: Any, bucket: str, *, content_dir: Path = CONTENT_DIR, dry_run: bool = False) -> dict[str, Any]:
    """Validates local content, then uploads every expected Markdown object
    FIRST (in manifest order), and manifest.json LAST -- only if every
    Markdown upload succeeded. dry_run performs zero S3 calls (client may be
    None): it still runs every validation step and returns the exact same
    report shape, so --dry-run output always matches what a real publish
    would do.

    Raises AboutPublishError on any failure. On a mid-publish Markdown
    upload failure, the exception message reports how many of the expected
    Markdown files already succeeded and makes explicit that manifest.json
    was never touched -- the caller stops with a non-zero exit code.

    Returns {"markdownFiles": [...], "manifestUploaded": bool,
    "contentVersion": str} -- "markdownFiles" lists every relative path
    that was (or, in dry-run, would be) uploaded, in upload order.
    """
    _validate_local_content(content_dir)
    manifest = _read_local_manifest(content_dir)
    expected = _expected_markdown_files(manifest, content_dir)

    uploaded: list[str] = []
    for locale, page_id, relative_file in expected:
        path = content_dir / relative_file
        if not dry_run:
            try:
                client.put_object(
                    Bucket=bucket,
                    Key=f"{S3AboutContentStore.PREFIX}/{relative_file}",
                    Body=path.read_bytes(),
                    ContentType=_content_type(path),
                )
            except Exception as exc:  # noqa: BLE001 - re-raised as AboutPublishError below
                raise AboutPublishError(
                    f"upload failed for {relative_file} (locale={locale}, page={page_id}) after "
                    f"{len(uploaded)}/{len(expected)} markdown file(s) already succeeded -- "
                    f"stopping now; manifest.json was NOT uploaded: {exc}"
                ) from exc
        uploaded.append(relative_file)

    manifest_path = content_dir / "manifest.json"
    if not dry_run:
        client.put_object(
            Bucket=bucket,
            Key=S3AboutContentStore.MANIFEST_KEY,
            Body=manifest_path.read_bytes(),
            ContentType=_content_type(manifest_path),
        )

    return {"markdownFiles": uploaded, "manifestUploaded": not dry_run, "contentVersion": manifest["contentVersion"]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bucket", default=None, help="override target bucket (default: resolve_history_bucket())")
    parser.add_argument("--dry-run", action="store_true", help="validate and list what would be uploaded, without calling S3")
    args = parser.parse_args()

    bucket = args.bucket or resolve_history_bucket()

    if args.dry_run:
        try:
            report = publish(None, bucket, dry_run=True)
        except AboutPublishError as exc:
            print(f"Validation failed: {exc}", file=sys.stderr)
            sys.exit(1)
        print(f"Validated OK. Would publish {len(report['markdownFiles'])} Markdown object(s), then manifest.json LAST, to s3://{bucket}/{S3AboutContentStore.PREFIX}/:")
        for relative_file in report["markdownFiles"]:
            path = CONTENT_DIR / relative_file
            print(f"  {S3AboutContentStore.PREFIX}/{relative_file}  ({_content_type(path)}, {path.stat().st_size} bytes)")
        manifest_path = CONTENT_DIR / "manifest.json"
        print(
            f"  {S3AboutContentStore.MANIFEST_KEY}  (application/json, {manifest_path.stat().st_size} bytes)  "
            f"<- uploaded LAST, only if every Markdown object above succeeds (contentVersion={report['contentVersion']})"
        )
        return

    import boto3

    client = boto3.client("s3")
    try:
        report = publish(client, bucket, dry_run=False)
    except AboutPublishError as exc:
        print(f"FAILED: {exc}", file=sys.stderr)
        sys.exit(1)
    print(
        f"Done -- {len(report['markdownFiles'])} Markdown object(s) + manifest.json "
        f"(contentVersion={report['contentVersion']}) published to s3://{bucket}/{S3AboutContentStore.PREFIX}/"
    )


if __name__ == "__main__":
    main()
