"""The Lambda package must never ship a vulnerable certifi (GHSA-6q48-6c7w-9gw2, emSign root CA compromise, October 2026).

certifi is a transitive dependency of every HTTPS client in the package (botocore, requests / pywebpush, httplib2 / google-api-python-client) and the
Lambda runtime does not replace it, so the protection has to live in the repository: the requirements pin, the packaging check and the CI bootstrap.
Everything here runs on fake directories and the repository's own text files: no pip install, no network.
"""

from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
_spec = importlib.util.spec_from_file_location("package_lambda", ROOT / "scripts" / "deploy" / "package_lambda.py")
package_lambda = importlib.util.module_from_spec(_spec)
sys.modules.setdefault("package_lambda", package_lambda)
_spec.loader.exec_module(package_lambda)

SAFE_BUNDLE = "# Label: \"ISRG Root X1\"\n-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"
BAD_BUNDLE = SAFE_BUNDLE + "# Label: \"emSign ECC Root CA - G3\"\n-----BEGIN CERTIFICATE-----\nBBBB\n-----END CERTIFICATE-----\n"


def _fake_site(tmp_path: Path, version: str | None, bundle: str | None = SAFE_BUNDLE) -> Path:
    """A directory shaped like a pip --target install of certifi `version` (no certifi at all when version is None)."""
    if version is not None:
        dist_info = tmp_path / f"certifi-{version}.dist-info"
        dist_info.mkdir()
        (dist_info / "METADATA").write_text(f"Metadata-Version: 2.4\nName: certifi\nVersion: {version}\n", encoding="utf-8")
    if bundle is not None:
        (tmp_path / "certifi").mkdir()
        (tmp_path / "certifi" / "cacert.pem").write_text(bundle, encoding="utf-8")
    return tmp_path


def test_the_pinned_requirement_is_the_fixed_certifi_and_reaches_the_lambda_package():
    """requirements.txt pins exactly the fixed certifi and the packaging script hands that pin to pip."""
    pinned = [line.strip() for line in (ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines() if line.strip().startswith("certifi")]
    assert pinned == ["certifi==2026.10.23"]
    assert tuple(int(part) for part in pinned[0].split("==")[1].split(".")) >= package_lambda.MIN_CERTIFI_VERSION
    assert "certifi==2026.10.23" in package_lambda._load_runtime_dependencies()  # the packaging script passes it to pip: certifi is not dev-only


def test_nothing_else_in_the_requirements_changed_with_the_certifi_pin():
    """This remediation is scoped to certifi: the other pins (for example pyarrow, whose advisory does not reach the Parquet-only code path) stay."""
    lines = {line.strip() for line in (ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines() if line.strip()}
    assert {"pyarrow==20.0.0", "boto3==1.43.86", "pywebpush==2.5.0", "google-api-python-client==2.199.0"} <= lines


@pytest.mark.parametrize("version", ["2026.10.19", "2026.10.23", "2027.1.1"])
def test_a_fixed_certifi_with_a_clean_bundle_is_accepted(tmp_path, version):
    """A certifi at or above the fix with a clean bundle passes the packaging check."""
    assert package_lambda.check_certifi_security(_fake_site(tmp_path, version)) == version


@pytest.mark.parametrize("version", ["2026.10.18", "2026.7.22", "2025.11.12", "2019.3.9"])
def test_a_certifi_older_than_the_fix_is_refused(tmp_path, version):
    """A certifi older than 2026.10.19 fails the packaging check with the advisory id in the message."""
    with pytest.raises(package_lambda.PackagingSecurityError, match="GHSA-6q48-6c7w-9gw2"):
        package_lambda.check_certifi_security(_fake_site(tmp_path, version))


def test_a_new_looking_certifi_that_still_bundles_the_emsign_ecc_root_is_refused(tmp_path):
    """The version alone is not trusted: a bundle carrying the distrusted root fails whatever its dist-info says."""
    with pytest.raises(package_lambda.PackagingSecurityError, match="emSign ECC Root CA - G3"):
        package_lambda.check_certifi_security(_fake_site(tmp_path, "2026.10.23", BAD_BUNDLE))


def test_a_package_without_certifi_or_without_its_bundle_is_refused(tmp_path):
    """A package with no certifi dist-info, or a certifi without its cacert.pem, fails the packaging check."""
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(package_lambda.PackagingSecurityError, match="no certifi dist-info"):
        package_lambda.check_certifi_security(empty)
    no_bundle = tmp_path / "no_bundle"
    no_bundle.mkdir()
    with pytest.raises(package_lambda.PackagingSecurityError, match="cacert.pem"):
        package_lambda.check_certifi_security(_fake_site(no_bundle, "2026.10.23", None))


def test_an_unparseable_certifi_version_is_refused_rather_than_guessed(tmp_path):
    """A version string the check cannot parse is refused instead of being assumed safe."""
    with pytest.raises(package_lambda.PackagingSecurityError, match="cannot parse"):
        package_lambda.check_certifi_security(_fake_site(tmp_path, "2026.10.23rc1"))


def test_the_packaging_run_checks_certifi_before_it_builds_the_zip():
    """main() runs the certifi check after pip installs the dependencies and before the zip is assembled."""
    source = (ROOT / "scripts" / "deploy" / "package_lambda.py").read_text(encoding="utf-8")
    assert source.index("check_certifi_security(BUILD_DIR)") < source.index("copy_source_files(BUILD_DIR)")
    assert source.index("check_certifi_security(BUILD_DIR)") > source.index('"--only-binary=:all:"')  # after pip installed the dependencies


def test_ci_replaces_pip_with_the_hash_pinned_26_2_2_before_installing_anything_else():
    """The CI backend job installs the hash-pinned pip 26.2.2 first and verifies the installed certifi afterwards."""
    workflow = (ROOT / ".github" / "workflows" / "pr-ci.yml").read_text(encoding="utf-8")
    bootstrap = workflow.index("pip==26.2.2 --hash=sha256:fd7f4dfa8190e014013b9f08f3e973f4e4c26ffd179a204895533a7254813a70")  # the hash Python's advisory publishes
    assert "--require-hashes" in workflow[bootstrap : bootstrap + 400]
    assert bootstrap < workflow.index("python -m pip install -r requirements.txt")
    assert workflow.index("check_certifi_security(") > workflow.index("python -m pip install -r requirements.txt")  # verified after the dependencies are installed
    assert re.search(r"python-version: \"3\.12\"", workflow)  # the Python version is deliberately unchanged
