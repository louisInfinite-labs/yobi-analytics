"""Shared helpers for the project's simple JSON-file-backed local data stores."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path


class JsonStoreError(RuntimeError):
    """Raised when a JSON-file-backed store is malformed, unreadable, or unwritable."""


def load_json_list(path: Path, *, store_name: str, error_class: type[Exception] = JsonStoreError) -> list:
    """Load a JSON array from path, returning [] if the file doesn't exist yet."""
    if not path.exists():
        return []
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except OSError as exc:
        raise error_class(f"Failed to read {store_name} file {path}: {exc}") from exc
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise error_class(f"{store_name} file {path} contains invalid JSON: {exc}") from exc

    if not isinstance(data, list):
        raise error_class(f"{store_name} file {path} must contain a JSON array, got {type(data).__name__}")
    return data


def write_json_list(path: Path, data: list, *, store_name: str, error_class: type[Exception] = JsonStoreError) -> None:
    """Atomically replace path with a JSON array (write to a temp file, then rename)."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = _write_temp_json(path, data)
        os.replace(tmp_path, path)
    except OSError as exc:
        raise error_class(f"Failed to write {store_name} file {path}: {exc}") from exc


def write_json_list_exclusive(
    path: Path, data: list, *, store_name: str, error_class: type[Exception] = JsonStoreError
) -> None:
    """Atomically create path with a JSON array, refusing to overwrite an existing file."""
    if path.exists():
        raise FileExistsError(f"{store_name} file already exists at {path}")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = _write_temp_json(path, data)
    except OSError as exc:
        raise error_class(f"Failed to write {store_name} file {path}: {exc}") from exc

    try:
        os.link(tmp_path, path)
    except FileExistsError:
        raise FileExistsError(f"{store_name} file already exists at {path}") from None
    except OSError as exc:
        raise error_class(f"Failed to write {store_name} file {path}: {exc}") from exc
    finally:
        tmp_path.unlink(missing_ok=True)


def _write_temp_json(path: Path, data: list) -> Path:
    """Write data as JSON to a new temp file next to path, returning the temp file's path."""
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise
    return Path(tmp_name)
