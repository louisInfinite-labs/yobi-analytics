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

    for py_file in SRC_DIR.glob("*.py"):
        shutil.copy(py_file, BUILD_DIR / py_file.name)
    shutil.copy(SRC_DIR / "creators.json", BUILD_DIR / "creators.json")

    with zipfile.ZipFile(ZIP_PATH, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in BUILD_DIR.rglob("*"):
            if file_path.is_file():
                zf.write(file_path, file_path.relative_to(BUILD_DIR))

    print(f"Packaged: {ZIP_PATH} ({ZIP_PATH.stat().st_size / 1024 / 1024:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
