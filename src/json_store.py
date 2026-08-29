"""Shared helpers for the project's simple JSON-file-backed local data stores."""

from __future__ import annotations

import json
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
    except json.JSONDecodeError as exc:
        raise error_class(f"{store_name} file {path} contains invalid JSON: {exc}") from exc

    if not isinstance(data, list):
        raise error_class(f"{store_name} file {path} must contain a JSON array, got {type(data).__name__}")
    return data


def write_json_list(path: Path, data: list, *, store_name: str, error_class: type[Exception] = JsonStoreError) -> None:
    """Write a JSON array to path, pretty-printed as UTF-8 with a trailing newline."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
    except OSError as exc:
        raise error_class(f"Failed to write {store_name} file {path}: {exc}") from exc
