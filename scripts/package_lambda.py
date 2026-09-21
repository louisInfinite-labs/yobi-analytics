"""Package the collector and its runtime dependencies into a Lambda deployment ZIP.

Excludes pytest deliberately — it's a dev/test-only dependency and never
imported by main.py/lambda_handler.py at runtime, so it must not bloat the
deployed package.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).parent.parent
BUILD_DIR = ROOT / "build" / "lambda_package"
WHEELHOUSE_DIR = ROOT / "build" / "wheelhouse"
ZIP_PATH = ROOT / "build" / "lambda_deployment.zip"
SRC_DIR = ROOT / "src"

# AWS Lambda's own hard caps (docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html):
# 50 MB zipped for a direct `update-function-code --zip-file` upload (an
# S3-based upload bypasses only this one), and 250 MB unzipped total
# regardless of upload method — there is no way around the second limit
# except shrinking the package itself.
LAMBDA_ZIPPED_LIMIT_BYTES = 50 * 1024 * 1024
LAMBDA_UNZIPPED_LIMIT_BYTES = 250 * 1024 * 1024

# youtube_client.py calls googleapiclient's build("youtube", "v3", ...,
# cache_discovery=False). `cache_discovery` and `static_discovery` are two
# separate build() parameters: cache_discovery=False only disables the
# *runtime* discovery-cache lookup (discovery_cache.autodetect(), for docs
# already fetched over the network) -- it has no effect on static_discovery,
# which build() defaults to True whenever discoveryServiceUrl isn't passed
# (as here). With static_discovery=True, build() always tries the bundled
# discovery_cache/documents/{name}.{version}.json file first and raises
# UnknownApiNameOrVersion immediately -- before any network request -- if
# that file is missing (confirmed against googleapiclient 2.199.0's own
# discovery.py/discovery_cache/__init__.py). So youtube.v3.json must stay
# bundled. Every OTHER API's discovery document (Drive, BigQuery, Compute,
# ...) is still dead weight, since nothing in this codebase calls build()
# for them (confirmed via `grep -rn discovery_cache src/` turning up nothing
# but that one YouTube v3 call) -- ~100MB removed here, minus the one file
# in REQUIRED_DISCOVERY_DOCUMENTS below.
DISCOVERY_CACHE_DOCUMENTS_DIR = Path("googleapiclient") / "discovery_cache" / "documents"
REQUIRED_DISCOVERY_DOCUMENTS = {"youtube.v3.json"}

# Packages in requirements.txt that main.py/lambda_handler.py never import at
# runtime — kept out of the Lambda package rather than duplicated by version
# here, so requirements.txt stays the single source of truth. moto is a
# test-only DynamoDB mock (Roadmap 2.3); boto3 itself is a real runtime
# dependency (dynamodb_store.py) and stays bundled, even though the Lambda
# Python runtime also provides its own copy.
DEV_ONLY_PACKAGES = {"pytest", "moto"}

# Transitive dependencies with no published wheel at all (sdist-only on
# PyPI), so --only-binary=:all: below would otherwise fail to install them
# no matter the platform — pip's cross-platform install mode (--platform/
# --implementation/--python-version) refuses to build from source at all,
# even when --no-binary is used to ask for it (it can't invoke a build
# backend for a foreign platform). Worked around below by pre-building a
# real wheel for each of these locally first: each is pure Python with no
# compiled extension, so the wheel that comes out is platform-independent
# ("py3-none-any") and satisfies the manylinux/cp312 target just as well as
# if PyPI had published one. http-ece is pulled in by pywebpush==2.5.0
# (Roadmap 4.6's push_sender.py).
SDIST_ONLY_PACKAGES = {"http-ece"}


def _load_runtime_dependencies() -> list[str]:
    """Read requirements.txt, excluding dev/test-only packages not needed at runtime."""
    lines = (ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines()
    return [
        line.strip()
        for line in lines
        if line.strip() and line.split("==")[0].strip() not in DEV_ONLY_PACKAGES
    ]


def prune_discovery_documents(build_dir: Path) -> None:
    """Delete every discovery_cache/documents/*.json file except REQUIRED_DISCOVERY_DOCUMENTS.

    See DISCOVERY_CACHE_DOCUMENTS_DIR's own comment above for why
    youtube.v3.json specifically must survive this prune.
    """
    discovery_documents = build_dir / DISCOVERY_CACHE_DOCUMENTS_DIR
    if not discovery_documents.exists():
        return
    for doc_file in discovery_documents.iterdir():
        if doc_file.is_file() and doc_file.name not in REQUIRED_DISCOVERY_DOCUMENTS:
            doc_file.unlink()


def copy_source_files(build_dir: Path) -> None:
    for py_file in SRC_DIR.rglob("*.py"):
        destination = build_dir / py_file.relative_to(SRC_DIR)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(py_file, destination)
    shutil.copy(SRC_DIR / "creators.json", build_dir / "creators.json")


def main() -> int:
    """Build a clean Lambda deployment ZIP from src/ and its runtime dependencies."""
    if BUILD_DIR.exists():
        shutil.rmtree(BUILD_DIR)
    if WHEELHOUSE_DIR.exists():
        shutil.rmtree(WHEELHOUSE_DIR)
    if ZIP_PATH.exists():
        ZIP_PATH.unlink()
    BUILD_DIR.mkdir(parents=True)

    find_links_args: list[str] = []
    if SDIST_ONLY_PACKAGES:
        WHEELHOUSE_DIR.mkdir(parents=True)
        # Built with the host's own interpreter/platform (no cross-platform
        # flags) — safe only because every package here is pure Python; see
        # SDIST_ONLY_PACKAGES' comment for why that makes the result reusable
        # for the manylinux/cp312 target below.
        subprocess.run(
            [sys.executable, "-m", "pip", "wheel", "--no-deps", "--wheel-dir", str(WHEELHOUSE_DIR), *SDIST_ONLY_PACKAGES],
            check=True,
        )
        find_links_args = [f"--find-links={WHEELHOUSE_DIR}"]

    # Force manylinux/cp312 wheels regardless of the host platform (this repo
    # develops on Windows — see Roadmap 2.2 "Known Constraint"). Without this,
    # pip resolves platform-specific compiled deps (e.g. cryptography/cffi,
    # pulled in transitively via google-auth) to Windows wheels, which raise
    # ImportError on Lambda's Amazon Linux runtime at cold start.
    subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--target",
            str(BUILD_DIR),
            "--platform",
            "manylinux2014_x86_64",
            "--implementation",
            "cp",
            "--python-version",
            "3.12",
            "--only-binary=:all:",
            *find_links_args,
            *_load_runtime_dependencies(),
        ],
        check=True,
    )

    prune_discovery_documents(BUILD_DIR)

    copy_source_files(BUILD_DIR)

    with zipfile.ZipFile(ZIP_PATH, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in BUILD_DIR.rglob("*"):
            if file_path.is_file():
                zf.write(file_path, file_path.relative_to(BUILD_DIR))

    uncompressed_bytes = sum(f.stat().st_size for f in BUILD_DIR.rglob("*") if f.is_file())
    compressed_bytes = ZIP_PATH.stat().st_size
    print(f"Packaged: {ZIP_PATH}")
    print(f"  Uncompressed: {uncompressed_bytes / 1024 / 1024:.1f} MB (Lambda limit: 250 MB, any upload method)")
    print(f"  Zipped:       {compressed_bytes / 1024 / 1024:.1f} MB (Lambda limit: 50 MB for direct --zip-file upload)")

    if uncompressed_bytes > LAMBDA_UNZIPPED_LIMIT_BYTES:
        print(
            f"ERROR: uncompressed size exceeds Lambda's 250 MB limit by "
            f"{(uncompressed_bytes - LAMBDA_UNZIPPED_LIMIT_BYTES) / 1024 / 1024:.1f} MB. "
            "No upload method (zip-file or S3) can deploy this package as-is."
        )
        return 1
    if compressed_bytes > LAMBDA_ZIPPED_LIMIT_BYTES:
        print(
            "NOTE: zipped size exceeds the 50 MB direct-upload limit - "
            "upload via S3 (aws s3 cp + aws lambda update-function-code --s3-bucket/--s3-key) instead of --zip-file."
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
