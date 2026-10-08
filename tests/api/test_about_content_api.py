"""Tests for api.about_content_api -- GET /about-content.

Two storage paths are exercised:
  - S3AboutContentStore, via moto (`s3_about_content` fixture) -- proves the
    real production read path (yobi-analytics-history bucket, "about/"
    prefix) genuinely works, same convention as test_video_ranking_store.py.
  - LocalAboutContentStore, pointed at the actually-committed
    src/content/about/ -- proves the real authored content (all five pages,
    three locales, official links, the unresolved contact placeholder, the
    second-draft-only Data Sources copy) is itself well-formed, independent
    of which store serves it.
"""

from __future__ import annotations

import json
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

from api.about_content_api import (
    AboutContentUnavailableError,
    AboutContentValidationError,
    get_about_content,
    validate_about_content,
)
from stores.about_content_store import S3AboutContentStore

REGION = "ap-northeast-1"
BUCKET = "test-history-bucket"
REPO_CONTENT_DIR = Path(__file__).resolve().parent.parent.parent / "src" / "content" / "about"

REQUIRED_PAGE_ORDER = ["about", "dataSources", "privacy", "terms", "acknowledgements"]


def _manifest(pages_by_locale: dict[str, list[dict]]) -> dict:
    return {
        "schemaVersion": 1,
        "contentVersion": "test-1",
        "locales": {locale: {"pages": pages} for locale, pages in pages_by_locale.items()},
    }


@pytest.fixture
def s3_about_content(aws_credentials, monkeypatch):
    """A moto-backed bucket seeded with a small two-page, one-locale fixture
    (not the real content -- see the Local* tests below for that)."""
    monkeypatch.setenv("YOBI_HISTORY_BUCKET", BUCKET)
    monkeypatch.delenv("YOBI_ABOUT_CONTENT_DIR", raising=False)
    with mock_aws():
        client = boto3.client("s3", region_name=REGION)
        client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})
        manifest = _manifest({"en": [{"id": "about", "title": "About", "file": "en/about.md"}]})
        client.put_object(Bucket=BUCKET, Key=S3AboutContentStore.MANIFEST_KEY, Body=json.dumps(manifest).encode("utf-8"))
        client.put_object(Bucket=BUCKET, Key="about/en/about.md", Body="## Hello\n\nWorld.\n".encode("utf-8"))
        yield client


@pytest.fixture
def local_real_content(monkeypatch):
    """Points get_about_content() at the actually-committed authoring copy."""
    monkeypatch.setenv("YOBI_ABOUT_CONTENT_DIR", str(REPO_CONTENT_DIR))
    yield


class TestS3BackedRead:
    def test_assembles_manifest_and_markdown_into_one_payload(self, s3_about_content):
        payload = get_about_content()

        assert payload == {
            "schemaVersion": 1,
            "contentVersion": "test-1",
            "locales": {"en": {"pages": [{"id": "about", "title": "About", "markdown": "## Hello\n\nWorld.\n"}]}},
        }

    def test_no_query_params_needed_and_stable_across_calls(self, s3_about_content):
        assert get_about_content() == get_about_content({"locale": "en"}) == get_about_content(None)

    def test_missing_manifest_raises_unavailable_not_a_crash(self, aws_credentials, monkeypatch):
        monkeypatch.setenv("YOBI_HISTORY_BUCKET", BUCKET)
        monkeypatch.delenv("YOBI_ABOUT_CONTENT_DIR", raising=False)
        with mock_aws():
            client = boto3.client("s3", region_name=REGION)
            client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})
            with pytest.raises(AboutContentUnavailableError):
                get_about_content()

    def test_missing_page_file_raises_unavailable(self, aws_credentials, monkeypatch):
        monkeypatch.setenv("YOBI_HISTORY_BUCKET", BUCKET)
        monkeypatch.delenv("YOBI_ABOUT_CONTENT_DIR", raising=False)
        with mock_aws():
            client = boto3.client("s3", region_name=REGION)
            client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})
            manifest = _manifest({"en": [{"id": "about", "title": "About", "file": "en/missing.md"}]})
            client.put_object(Bucket=BUCKET, Key=S3AboutContentStore.MANIFEST_KEY, Body=json.dumps(manifest).encode("utf-8"))
            with pytest.raises(AboutContentUnavailableError):
                get_about_content()

    def test_malformed_manifest_json_raises_unavailable(self, aws_credentials, monkeypatch):
        monkeypatch.setenv("YOBI_HISTORY_BUCKET", BUCKET)
        monkeypatch.delenv("YOBI_ABOUT_CONTENT_DIR", raising=False)
        with mock_aws():
            client = boto3.client("s3", region_name=REGION)
            client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})
            client.put_object(Bucket=BUCKET, Key=S3AboutContentStore.MANIFEST_KEY, Body=b"{not json")
            with pytest.raises(AboutContentUnavailableError):
                get_about_content()


class TestLocalBackedRealContent:
    """Exercises the actually-committed src/content/about/ -- the content
    that scripts/local_api_server.py (Playwright) and production (once
    published) both ultimately serve."""

    def test_served_payload_passes_its_own_validation(self, local_real_content):
        validate_about_content(get_about_content())

    def test_all_three_locales_present(self, local_real_content):
        payload = get_about_content()
        assert set(payload["locales"]) == {"zh-TW", "en", "ja"}

    @pytest.mark.parametrize("locale", ["zh-TW", "en", "ja"])
    def test_five_pages_in_required_order(self, local_real_content, locale):
        payload = get_about_content()
        ids = [page["id"] for page in payload["locales"][locale]["pages"]]
        assert ids == REQUIRED_PAGE_ORDER

    def test_zh_tw_finalized_line_is_verbatim(self, local_real_content):
        payload = get_about_content()
        about_page = next(p for p in payload["locales"]["zh-TW"]["pages"] if p["id"] == "about")
        assert "先從你關注的推し開始，掌握近期值得留意的內容。" in about_page["markdown"]

    def test_only_second_data_sources_draft_is_served(self, local_real_content):
        payload = get_about_content()
        for locale in ("zh-TW", "en", "ja"):
            markdown = next(p for p in payload["locales"][locale]["pages"] if p["id"] == "dataSources")["markdown"]
            assert "Schedule" in markdown or "排程" in markdown or "スケジュール" in markdown

    def test_official_links_resolved_to_approved_https_domains(self, local_real_content):
        payload = get_about_content()
        for locale in ("zh-TW", "en", "ja"):
            privacy = next(p for p in payload["locales"][locale]["pages"] if p["id"] == "privacy")["markdown"]
            terms = next(p for p in payload["locales"][locale]["pages"] if p["id"] == "terms")["markdown"]
            assert "](https://policies.google.com/privacy)" in privacy
            assert "](https://www.youtube.com/t/terms)" in terms

    def test_contact_placeholder_never_resolved_to_a_link(self, local_real_content):
        """The placeholder stays a bare bracket -- never followed by "(...)",
        i.e. never turned into a real Markdown link."""
        payload = get_about_content()
        found_at_least_one = False
        for locale in ("zh-TW", "en", "ja"):
            for page_id in ("privacy", "terms"):
                markdown = next(p for p in payload["locales"][locale]["pages"] if p["id"] == page_id)["markdown"]
                for placeholder in ("[聯絡方式]", "[Contact]", "[お問い合わせ先]"):
                    idx = markdown.find(placeholder)
                    if idx == -1:
                        continue
                    found_at_least_one = True
                    after = markdown[idx + len(placeholder) : idx + len(placeholder) + 1]
                    assert after != "("
        assert found_at_least_one


class TestValidateAboutContent:
    def test_valid_payload_passes(self):
        validate_about_content(_manifest_payload())

    @pytest.mark.parametrize(
        "mutate",
        [
            lambda p: p.pop("schemaVersion"),
            lambda p: p.__setitem__("schemaVersion", "1"),
            lambda p: p.__setitem__("schemaVersion", 0),
            lambda p: p.__setitem__("contentVersion", ""),
            lambda p: p.pop("contentVersion"),
            lambda p: p.__setitem__("locales", {}),
            lambda p: p.__setitem__("locales", "not-a-dict"),
            lambda p: p["locales"]["en"].__setitem__("pages", []),
            lambda p: p["locales"]["en"]["pages"][0].pop("title"),
            lambda p: p["locales"]["en"]["pages"][0].__setitem__("markdown", ""),
            lambda p: p["locales"]["en"]["pages"][0].__setitem__("id", 5),
        ],
    )
    def test_malformed_payload_rejected(self, mutate):
        payload = _manifest_payload()
        mutate(payload)
        with pytest.raises(AboutContentValidationError):
            validate_about_content(payload)

    def test_non_object_payload_rejected(self):
        with pytest.raises(AboutContentValidationError):
            validate_about_content(["not", "an", "object"])

    def test_new_locale_beyond_zh_tw_en_ja_is_accepted(self):
        """The validator intentionally doesn't hardcode a fixed locale set --
        adding a locale is an ordinary content change, not a schema change."""
        payload = _manifest_payload()
        payload["locales"]["ko"] = {"pages": [{"id": "about", "title": "제목", "markdown": "안녕"}]}
        validate_about_content(payload)


def _manifest_payload() -> dict:
    return {
        "schemaVersion": 1,
        "contentVersion": "2026.10.2",
        "locales": {"en": {"pages": [{"id": "about", "title": "About", "markdown": "## Hi\n\nThere.\n"}]}},
    }
