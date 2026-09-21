"""Regression coverage for scripts/package_lambda.py's discovery-document pruning.

Exercises the actual pruning behavior against a fake build directory (no pip
install, no network) rather than only asserting on package_lambda.py's own
source text -- see the incident this guards against: youtube_client.py's
build("youtube", "v3", ..., cache_discovery=False) call still requires the
bundled discovery_cache/documents/youtube.v3.json file (static_discovery
defaults to True independently of cache_discovery), but an earlier version of
this pruning step deleted the entire documents/ directory, which broke every
production collector invocation with UnknownApiNameOrVersion("name: youtube
version: v3") before any network request was even attempted.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_MODULE_PATH = Path(__file__).resolve().parents[3] / "scripts" / "deploy" / "package_lambda.py"
_spec = importlib.util.spec_from_file_location("package_lambda", _MODULE_PATH)
package_lambda = importlib.util.module_from_spec(_spec)
sys.modules.setdefault("package_lambda", package_lambda)
_spec.loader.exec_module(package_lambda)


def _fake_build_dir(tmp_path: Path, document_names: list[str]) -> Path:
    """Create tmp_path/googleapiclient/discovery_cache/documents/ populated with
    one small fake JSON file per name in document_names."""
    documents_dir = tmp_path / package_lambda.DISCOVERY_CACHE_DOCUMENTS_DIR
    documents_dir.mkdir(parents=True)
    for name in document_names:
        (documents_dir / name).write_text("{}", encoding="utf-8")
    return tmp_path


def test_prune_discovery_documents_keeps_youtube_v3_and_removes_the_rest(tmp_path):
    build_dir = _fake_build_dir(
        tmp_path,
        ["youtube.v3.json", "drive.v3.json", "bigquery.v2.json", "compute.v1.json"],
    )

    package_lambda.prune_discovery_documents(build_dir)

    documents_dir = build_dir / package_lambda.DISCOVERY_CACHE_DOCUMENTS_DIR
    remaining = {f.name for f in documents_dir.iterdir()}
    assert remaining == {"youtube.v3.json"}


def test_prune_discovery_documents_does_not_retain_the_full_unused_document_set(tmp_path):
    """Guards specifically against reverting to shutil.rmtree-the-whole-dir's
    opposite failure mode: silently keeping everything instead of pruning it."""
    unused_names = [f"fake-api-{i}.v1.json" for i in range(20)]
    build_dir = _fake_build_dir(tmp_path, ["youtube.v3.json", *unused_names])

    package_lambda.prune_discovery_documents(build_dir)

    documents_dir = build_dir / package_lambda.DISCOVERY_CACHE_DOCUMENTS_DIR
    remaining = {f.name for f in documents_dir.iterdir()}
    assert remaining == {"youtube.v3.json"}, (
        f"expected only youtube.v3.json to survive pruning, found {sorted(remaining)}"
    )


def test_prune_discovery_documents_tolerates_a_missing_documents_directory(tmp_path):
    """googleapiclient isn't installed in every build_dir this could run against
    (e.g. an empty/partial build) -- must not raise."""
    package_lambda.prune_discovery_documents(tmp_path)


def test_copy_source_files_preserves_nested_packages(tmp_path, monkeypatch):
    source_dir = tmp_path / "src"
    (source_dir / "api").mkdir(parents=True)
    (source_dir / "root_module.py").write_text("ROOT = True\n", encoding="utf-8")
    (source_dir / "api" / "__init__.py").write_text("", encoding="utf-8")
    (source_dir / "api" / "handler.py").write_text("HANDLER = True\n", encoding="utf-8")
    (source_dir / "creators.json").write_text("[]\n", encoding="utf-8")
    build_dir = tmp_path / "build"
    build_dir.mkdir()
    monkeypatch.setattr(package_lambda, "SRC_DIR", source_dir)

    package_lambda.copy_source_files(build_dir)

    assert (build_dir / "root_module.py").read_text(encoding="utf-8") == "ROOT = True\n"
    assert (build_dir / "api" / "__init__.py").is_file()
    assert (build_dir / "api" / "handler.py").read_text(encoding="utf-8") == "HANDLER = True\n"
    assert (build_dir / "creators.json").read_text(encoding="utf-8") == "[]\n"


@pytest.mark.parametrize("required_doc", sorted(package_lambda.REQUIRED_DISCOVERY_DOCUMENTS))
def test_required_discovery_document_is_youtube_v3(required_doc):
    """Documents the actual runtime requirement: youtube_client.py only calls
    build() for YouTube v3, so that's the only discovery document that must
    survive packaging."""
    assert required_doc == "youtube.v3.json"


def test_repo_root_resolves_to_real_source_tree():
    repo_root = Path(__file__).resolve().parents[3]
    assert package_lambda.ROOT == repo_root
    assert package_lambda.SRC_DIR == repo_root / "src"
    assert (package_lambda.SRC_DIR / "creators.json").is_file()
