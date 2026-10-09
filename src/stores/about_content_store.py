"""Storage for the About/Information area's canonical Markdown content.

S3AboutContentStore mirrors stores.video_ranking_store's own S3 JSON
conventions (bucket-wide client, from_environment_or_default() for the
read-side factory, a store-specific error on a missing/unreadable object)
-- same bucket as the existing history stores (see
stores.history_bucket.DEFAULT_HISTORY_BUCKET), a new "about/" prefix, no
new infrastructure (see api.about_content_api's own module docstring for
the read-only audit that established this).

Layout under the "about/" prefix:
  about/manifest.json                 -- {schemaVersion, contentVersion,
                                           locales: {locale: {pages: [{id,
                                           title, file}]}}}
  about/<locale>/<page-file>.md       -- one Markdown file per page

LocalAboutContentStore reads the same layout from a local directory --
used by scripts/local_api_server.py (Playwright) and a few tests that
exercise the committed authoring copy (src/content/about/) directly,
without moto or real AWS credentials.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Protocol

from botocore.exceptions import ClientError as BotoClientError

from stores.history_bucket import resolve_history_bucket


class AboutContentStoreError(RuntimeError):
    """Raised when the manifest or a page's Markdown can't be read."""


class AboutContentStore(Protocol):
    def read_manifest(self) -> dict[str, Any]: ...

    def read_page_markdown(self, relative_file: str) -> str: ...


class S3AboutContentStore:
    """Reads the About content manifest and per-page Markdown from S3."""

    PREFIX = "about"
    MANIFEST_KEY = f"{PREFIX}/manifest.json"

    def __init__(self, bucket_name: str, *, s3_client: Any = None) -> None:
        if not bucket_name:
            raise ValueError("bucket_name must not be empty")
        if s3_client is None:
            import boto3

            s3_client = boto3.client("s3")
        self.bucket_name = bucket_name
        self.s3_client = s3_client

    @classmethod
    def from_environment_or_default(cls, *, s3_client: Any = None) -> "S3AboutContentStore":
        """Read-side factory: YOBI_HISTORY_BUCKET when set (override), else
        the fixed production history bucket. Used by the API Lambda, which
        has no bucket env var -- same convention as
        S3VideoRankingStore.from_environment_or_default()."""
        return cls(resolve_history_bucket(), s3_client=s3_client)

    def _read_text(self, key: str) -> str:
        try:
            response = self.s3_client.get_object(Bucket=self.bucket_name, Key=key)
        except BotoClientError as exc:
            code = exc.response.get("Error", {}).get("Code")
            if code in ("NoSuchKey", "404"):
                raise AboutContentStoreError(f"missing object: s3://{self.bucket_name}/{key}") from exc
            raise AboutContentStoreError(f"failed to read s3://{self.bucket_name}/{key}: {exc}") from exc
        return response["Body"].read().decode("utf-8")

    def read_manifest(self) -> dict[str, Any]:
        try:
            return json.loads(self._read_text(self.MANIFEST_KEY))
        except json.JSONDecodeError as exc:
            raise AboutContentStoreError(f"manifest is not valid JSON: {exc}") from exc

    def read_page_markdown(self, relative_file: str) -> str:
        return self._read_text(f"{self.PREFIX}/{relative_file}")


class LocalAboutContentStore:
    """Reads the manifest and per-page Markdown from a local directory (the
    committed authoring copy under src/content/about/). Never used by the
    deployed API Lambda -- see api.about_content_api's own store-selection
    logic for exactly when this is picked instead of S3AboutContentStore.
    """

    def __init__(self, root: Path) -> None:
        self.root = root

    def read_manifest(self) -> dict[str, Any]:
        path = self.root / "manifest.json"
        if not path.exists():
            raise AboutContentStoreError(f"missing file: {path}")
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise AboutContentStoreError(f"manifest is not valid JSON: {exc}") from exc

    def read_page_markdown(self, relative_file: str) -> str:
        path = self.root / relative_file
        if not path.exists():
            raise AboutContentStoreError(f"missing file: {path}")
        return path.read_text(encoding="utf-8")
