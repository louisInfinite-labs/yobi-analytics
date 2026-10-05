"""Strict identifier and free-text-field validation shared by the public API modules (SEC-API-001, roadmap MT-03).

Every identifier that reaches a data store or an S3 key is checked against a charset + length allowlist *before* any
data-plane or upstream call. Each API module wraps IdentifierError in its own ClientError, so the existing 4xx mapping
is unchanged.
"""

from __future__ import annotations

import re
from typing import Any

# A browser-generated random UUID v4 (the web client uses crypto.randomUUID()), lowercase.
CLIENT_ID_PATTERN = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", re.ASCII)
# Creator Master ids are lowercase snake_case; existence is still checked against the roster by the caller.
CREATOR_ID_PATTERN = re.compile(r"[a-z0-9_]{1,64}", re.ASCII)
# A YouTube video id.
VIDEO_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{11}", re.ASCII)
# A remote-config key, e.g. "notificationPreference" or a dotted per-creator key.
CONFIG_KEY_PATTERN = re.compile(r"[A-Za-z0-9._:-]{1,64}", re.ASCII)
# The web app's own version string, e.g. "dashboard-1.0.0".
APP_VERSION_PATTERN = re.compile(r"[A-Za-z0-9._+-]{1,32}", re.ASCII)

_ECHO_LIMIT = 64


class IdentifierError(ValueError):
    """A clean, safe-to-surface message for an identifier that failed its allowlist."""


def safe_echo(raw: Any) -> str:
    """A bounded, control-character-free rendering of untrusted input for an error message."""
    text = raw if isinstance(raw, str) else repr(raw)
    cleaned = "".join(ch if ch.isprintable() else "?" for ch in text[:_ECHO_LIMIT])
    suffix = "..." if len(text) > _ECHO_LIMIT else ""
    return repr(cleaned + suffix)


def check_identifier(raw: Any, name: str, pattern: re.Pattern[str], rule: str) -> str:
    """Return `raw` when it is a string fully matching `pattern`; otherwise raise IdentifierError naming `rule`."""
    if not isinstance(raw, str) or not raw:
        raise IdentifierError(f"{name} is required and must be a non-empty string")
    if len(raw) > 128 or pattern.fullmatch(raw) is None:
        raise IdentifierError(f"{name} must be {rule}, got {safe_echo(raw)}")
    return raw
