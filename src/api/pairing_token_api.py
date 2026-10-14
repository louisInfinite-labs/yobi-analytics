"""Pure logic for Device Sync pairing sessions (OshiYobi Device Sync spec).

A pairing session lets one already-running OshiYobi environment (PC, or an
already-paired mobile PWA) invite a second local environment to join the
same Sync Profile, via either a QR code or a short human-typed code. Both
represent the SAME one-time secret: `generate_pairing_secret()` mints the
raw value once, `generate_human_code()` mints an independent, separately
typable code for the same session, and only their SHA-256 hashes are ever
persisted (pairing_token_store.py) -- the same "never store the raw
value" shape client_credential_api.py already uses for the longer-lived
per-device secret. Consumption (`PairingTokenConsumed`,
pairing_token_store.mark_consumed's conditional update) is what actually
enforces one-time use; this module only shapes/validates requests and
hashes values, it has no notion of "already used" on its own.

Deliberately NOT a reusable, long-lived credential: a pairing session
expires quickly (`PAIRING_SESSION_TTL_SECONDS`) and is for exactly one
device-attach action, so storing only a hash (rather than, say, comparing
plaintext) is defense in depth, not a strict requirement the way a
long-lived client secret's hash is -- see this module's own tests for the
expired/reused/invalid-code cases this is meant to reject.
"""

from __future__ import annotations

import hashlib
import secrets
import string
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

DeviceType = Literal["desktop", "android", "ios"]
_VALID_DEVICE_TYPES = frozenset({"desktop", "android", "ios"})

# 5 minutes: short enough that a QR/code left on screen stops being a live
# attack surface quickly, long enough for a real human to scan or type it
# once without racing the clock.
PAIRING_SESSION_TTL_SECONDS = 300

# 32 raw bytes before URL-safe base64 -- same strength as
# client_credential_api.generate_secret, for the same "well beyond
# brute-forceable" reason.
_TOKEN_BYTES = 32

# Excludes 0/O and 1/I/L -- the ambiguous-when-handwritten-or-misread
# characters the spec asks the human code to avoid. 8 chars from a
# 31-symbol alphabet is ~39 bits of entropy, comfortably more than a
# 5-minute, single-use, rate-limited code needs.
_HUMAN_CODE_ALPHABET = "".join(sorted(set(string.ascii_uppercase + string.digits) - set("0O1IL")))
_HUMAN_CODE_LENGTH = 8


class PairingError(ValueError):
    """A clean, safe-to-surface 4xx error for a malformed Device Sync pairing request.

    Mirrors remote_config_api.ClientError/heartbeat_api's own per-module
    error type -- every field here is untrusted input from a public route.
    """


def generate_pairing_secret() -> str:
    """A new random, URL-safe pairing token -- the value encoded into the QR."""
    return secrets.token_urlsafe(_TOKEN_BYTES)


def generate_human_code() -> str:
    """A new random human-typeable code, e.g. 'AB3D-EFGH' -- same pairing session as the QR, typed instead of scanned."""
    raw = "".join(secrets.choice(_HUMAN_CODE_ALPHABET) for _ in range(_HUMAN_CODE_LENGTH))
    return f"{raw[:4]}-{raw[4:]}"


def normalize_human_code(raw: Any) -> str:
    """Validate and normalize a user-typed pairing code: uppercased, dashes/spaces stripped, checked against the known alphabet.

    Raises PairingError for anything that cannot possibly be a code this
    module ever generated (wrong length/charset) -- NOT for "not found" or
    "expired", which the store layer decides once it can look the hash up.
    """
    if not isinstance(raw, str):
        raise PairingError("code is required and must be a string")
    cleaned = raw.strip().upper().replace("-", "").replace(" ", "")
    if len(cleaned) != _HUMAN_CODE_LENGTH or any(ch not in _HUMAN_CODE_ALPHABET for ch in cleaned):
        raise PairingError("code is not a recognized pairing code")
    return cleaned


def hash_pairing_value(value: str) -> str:
    """One-way SHA-256 hex digest of a raw pairing token or normalized human code, for storage/lookup instead of the raw value."""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def parse_device_id(raw: Any) -> str:
    """Validate a deviceId field (clientId.ts's own local, per-browser-storage-origin UUID -- never the user's identity)."""
    if not isinstance(raw, str) or not raw:
        raise PairingError("deviceId is required and must be a non-empty string")
    return raw


def parse_device_type(raw: Any) -> DeviceType:
    """Validate a deviceType field against the 3 form factors Device Sync's UX actually branches on."""
    if raw not in _VALID_DEVICE_TYPES:
        raise PairingError(f"deviceType must be one of {sorted(_VALID_DEVICE_TYPES)}")
    return raw  # type: ignore[return-value]


def parse_device_label(raw: Any) -> str:
    """Validate a deviceLabel field: a short, human-readable string (e.g. 'Desktop Chrome', 'iPhone PWA'), never a raw device id."""
    if not isinstance(raw, str) or not raw.strip():
        raise PairingError("deviceLabel is required and must be a non-empty string")
    return raw.strip()[:64]


def create_pairing_session(body: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
    """Validate a pairing-session creation request and return the normalized record to persist.

    `profileId` is optional: absent means "this is a brand-new pairing
    relationship, mint a fresh Sync Profile once the session is consumed";
    present means "attach the joining device to MY existing profile"
    (an already-paired device inviting a second one). The creating
    device's own ownership of `deviceId` is checked by api_handler.py's
    existing `_require_client_secret`, not here -- this module only shapes
    the pairing-session fields themselves.
    """
    device_id = parse_device_id(body.get("deviceId"))
    profile_id = body.get("profileId")
    if profile_id is not None and (not isinstance(profile_id, str) or not profile_id):
        raise PairingError("profileId must be a non-empty string when present")
    created_at = now or datetime.now(timezone.utc)
    token = generate_pairing_secret()
    human_code = generate_human_code()
    return {
        "token": token,
        "humanCode": human_code,
        "tokenHash": hash_pairing_value(token),
        "humanCodeHash": hash_pairing_value(human_code),
        "profileId": profile_id,
        "createdByDeviceId": device_id,
        "createdAt": created_at.isoformat(),
        "expiresAt": int((created_at + timedelta(seconds=PAIRING_SESSION_TTL_SECONDS)).timestamp()),
    }


def parse_consume_request(body: dict[str, Any]) -> dict[str, Any]:
    """Validate a pairing-session consume request: exactly one of token/code, plus the joining device's own identity.

    Returns `{lookupHash, deviceId, deviceLabel, deviceType}`; which of
    token/code was presented no longer matters past this point, since both
    hash-lookup paths resolve to the same stored session record.
    """
    raw_token = body.get("token")
    raw_code = body.get("code")
    if bool(raw_token) == bool(raw_code):
        raise PairingError("exactly one of token or code is required")
    lookup_hash = hash_pairing_value(raw_token) if raw_token else hash_pairing_value(normalize_human_code(raw_code))
    return {
        "lookupHash": lookup_hash,
        "usedToken": bool(raw_token),
        "deviceId": parse_device_id(body.get("deviceId")),
        "deviceLabel": parse_device_label(body.get("deviceLabel")),
        "deviceType": parse_device_type(body.get("deviceType")),
    }
