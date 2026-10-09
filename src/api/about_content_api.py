"""`GET /about-content`: the canonical, versioned content for the About/
Information area's five destinations (About OshiYobi, Data Sources,
Privacy, Terms of Use, Acknowledgements).

STORAGE DECISION (read-only audit, 2026-10-08): the canonical copy is
Markdown, stored remotely in the existing history S3 bucket
(stores.history_bucket.DEFAULT_HISTORY_BUCKET, terraform/history.tf) under
a new `about/` prefix -- not a new bucket/table/service. That bucket's
Lambda IAM policy already grants
`s3:GetObject`/`s3:PutObject` on the whole bucket (a wildcard resource
ARN, terraform/manual-iam/policy-lambda-history-access.json), so a new
prefix needs no Terraform change and no new IAM statement. No deploy
pipeline step syncs anything into this bucket, so publishing an updated
`about/manifest.json` or `.md` file (see scripts/publish_about_content.py)
takes effect on the next request with **no Lambda redeploy, no frontend
rebuild, and no native app release** -- this replaces an earlier revision
of this module that packaged content as a Python constant (like TOPICS/
creators.json), which *did* require a backend deploy for every content
edit; that design is superseded.

This module does no Markdown PARSING and owns no block/style schema of
its own -- it only reads the remote manifest (schemaVersion, contentVersion,
and each locale's ordered page list) and each page's raw Markdown text, and
returns them assembled. The frontend owns a small, safe Markdown renderer
(never raw HTML, never `dangerouslySetInnerHTML`): this module's job ends
at "fetch the approved text," not "decide how it looks."

stores.about_content_store.S3AboutContentStore is the production store.
LocalAboutContentStore (same module) reads the committed authoring copy at
src/content/about/ instead, when YOBI_ABOUT_CONTENT_DIR is set -- used by
scripts/local_api_server.py (Playwright) and a few of this module's own
tests, specifically so neither ever needs real AWS credentials or moto
just to exercise this route. The deployed API Lambda never sets this
env var, so production always reads S3.

`schemaVersion` and `contentVersion` are both authored directly in the
remote manifest, not computed here -- `schemaVersion` is deliberately not
given alternate-version handling yet (no second version exists to
handle); `contentVersion` is a human-readable revision marker (never
parsed by the frontend).
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from stores.about_content_store import AboutContentStore, AboutContentStoreError, LocalAboutContentStore, S3AboutContentStore

_LOCAL_CONTENT_DIR_ENV = "YOBI_ABOUT_CONTENT_DIR"

# The committed authoring copy -- the source a content edit normally starts
# from before scripts/publish_about_content.py uploads it to S3. Also the
# default LocalAboutContentStore root for local dev/tests.
DEFAULT_LOCAL_CONTENT_DIR = Path(__file__).resolve().parent.parent / "content" / "about"


class AboutContentUnavailableError(RuntimeError):
    """Raised when the manifest or a page's Markdown can't be read from
    storage. Maps to a 503 in api_handler.py, not a 4xx -- nothing about
    the request itself was invalid, the content store is just unreachable
    or malformed."""


def _default_store() -> AboutContentStore:
    local_dir = os.environ.get(_LOCAL_CONTENT_DIR_ENV)
    if local_dir:
        return LocalAboutContentStore(Path(local_dir))
    return S3AboutContentStore.from_environment_or_default()


def get_about_content(_query: dict[str, Any] | None = None) -> dict[str, Any]:
    """`GET /about-content`: the full, all-locales payload (same shape as
    get_topics -- no query params are required or consulted; the frontend
    already knows its own active locale and simply indexes into
    `locales`). Public, read-only, no clientId, no auth -- same trust level
    as GET /topics and GET /live-streams."""
    store = _default_store()
    try:
        manifest = store.read_manifest()
        locales: dict[str, Any] = {}
        for locale, locale_value in manifest["locales"].items():
            pages = []
            for page in locale_value["pages"]:
                markdown = store.read_page_markdown(page["file"])
                pages.append({"id": page["id"], "title": page["title"], "markdown": markdown})
            locales[locale] = {"pages": pages}
        payload = {
            "schemaVersion": manifest["schemaVersion"],
            "contentVersion": manifest["contentVersion"],
            "locales": locales,
        }
        validate_about_content(payload)
        return payload
    except AboutContentStoreError as exc:
        raise AboutContentUnavailableError("About content is temporarily unavailable") from exc
    except (KeyError, TypeError, AttributeError, AboutContentValidationError) as exc:
        raise AboutContentUnavailableError("About content is malformed") from exc


class AboutContentValidationError(ValueError):
    """Raised by validate_about_content for a structurally broken payload --
    exercised by this module's own tests to guard against a future content
    edit accidentally producing something the frontend's own defensive
    parser would have to fall back away from entirely. Deliberately knows
    nothing about Markdown syntax itself (that's the frontend renderer's
    concern) -- only that the envelope/manifest shape is well-formed."""


def validate_about_content(payload: Any) -> None:
    """Raises AboutContentValidationError on any structural defect. Strict
    by design (unlike the frontend's own defensive parser, which tolerates
    and falls back around a malformed field from a live network response)
    -- this validates OUR OWN served content at test time. Deliberately
    does not hardcode a fixed set of required locales: which locales exist
    is entirely the remote manifest's call, not this validator's -- adding
    a new locale is an ordinary content change, not a schema change."""
    if not isinstance(payload, dict):
        raise AboutContentValidationError("payload must be an object")
    if type(payload.get("schemaVersion")) is not int or payload["schemaVersion"] < 1:  # exact int: bool is not a version
        raise AboutContentValidationError("schemaVersion must be a positive integer")
    if not isinstance(payload.get("contentVersion"), str) or not payload["contentVersion"]:
        raise AboutContentValidationError("contentVersion must be a non-empty string")
    locales = payload.get("locales")
    if not isinstance(locales, dict) or not locales:
        raise AboutContentValidationError("locales must be a non-empty object")
    for locale, locale_value in locales.items():
        pages = locale_value.get("pages") if isinstance(locale_value, dict) else None
        if not isinstance(pages, list) or not pages:
            raise AboutContentValidationError(f"locales[{locale!r}].pages must be a non-empty list")
        for i, page in enumerate(pages):
            where = f"locales[{locale!r}].pages[{i}]"
            if not isinstance(page, dict):
                raise AboutContentValidationError(f"{where}: must be an object")
            for field in ("id", "title", "markdown"):
                if not isinstance(page.get(field), str) or not page[field]:
                    raise AboutContentValidationError(f"{where}.{field} must be a non-empty string")
