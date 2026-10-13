"""The centralized new-video discovery windows.

Discovery runs once per window for the whole roster, never per subscriber: the YouTube cost is
windows x discovery-enabled creators uploads-playlist reads, independent of how many clients are subscribed. Each run is the
existing incremental uploads-playlist discovery (collection.main.run_discovery); a window only names WHEN it runs and is stamped
on the events it records.

terraform/eventbridge.tf's `discovery_windows_jst` is the schedule side of this list. tests/test_discovery_windows_schedule.py
fails if the two drift apart, so change both together.
"""

from __future__ import annotations

# (window id, "HH:MM" Asia/Tokyo). The id is the time without the colon and is what the schedule passes as `window`.
DISCOVERY_WINDOWS_JST: tuple[tuple[str, str], ...] = (
    ("0000", "00:00"),
    ("0900", "09:00"),
    ("1300", "13:00"),
    ("2000", "20:00"),
    ("2200", "22:00"),
)

DISCOVERY_WINDOW_IDS = frozenset(window_id for window_id, _ in DISCOVERY_WINDOWS_JST)

# Recorded on an event written by a scheduled window; an event written by anything else carries LEGACY_SOURCE.
WINDOW_SOURCE_PREFIX = "discovery_window:"
LEGACY_SOURCE = "collection_run"


class UnknownDiscoveryWindowError(ValueError):
    """A `window` value that is not one of DISCOVERY_WINDOW_IDS."""


def validate_window(window: object) -> str:
    """Return a known window id, or raise UnknownDiscoveryWindowError (a stale schedule target must fail loudly)."""
    if not isinstance(window, str) or window not in DISCOVERY_WINDOW_IDS:
        raise UnknownDiscoveryWindowError(f"Unknown discovery window {window!r}; expected one of {sorted(DISCOVERY_WINDOW_IDS)}")
    return window


def discovery_source(window: str | None) -> str:
    """The `discoverySource` an event carries: the window that found it, else the legacy collection-run source."""
    return LEGACY_SOURCE if window is None else f"{WINDOW_SOURCE_PREFIX}{validate_window(window)}"
