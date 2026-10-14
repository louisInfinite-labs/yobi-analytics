"""Pure logic for Device Sync's Sync Profile / Sync Device model (OshiYobi Device Sync spec).

A Sync Profile is a bare logical grouping id: {profileId, createdAt}. It
carries no preference data of its own -- synced preference VALUES
(My Oshi, Favorites, language, display, notification preference) are
deliberately NOT a new table here. They reuse the existing Roadmap 4.5
remote-config store exactly as-is, addressed with a Sync Profile's
`profileId` in place of a lone device's own `clientId` (see
api_handler.py's new `/sync/*` routes): any device attached to a profile
reads/writes those specific remote-config keys under that shared
`profileId`, so "what should sync" never duplicates remote_config_store.py
or invents a second preference format, per the Device Sync spec's own
explicit instruction not to.

A Sync Device is the attach record: {profileId, deviceId, deviceLabel,
deviceType, createdAt, lastSeenAt}. `deviceId` is clientId.ts's existing
per-browser-storage-origin id -- Device Sync never mints a second,
competing device identity.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Literal

DeviceType = Literal["desktop", "android", "ios"]
_VALID_DEVICE_TYPES = frozenset({"desktop", "android", "ios"})


class SyncProfileError(ValueError):
    """A clean, safe-to-surface 4xx error for a malformed Device Sync profile/device request."""


def new_profile_id() -> str:
    """A fresh, random Sync Profile id -- opaque, never derived from any device identity or user account."""
    return uuid.uuid4().hex


def parse_profile_id(raw: Any) -> str:
    if not isinstance(raw, str) or not raw:
        raise SyncProfileError("profileId is required and must be a non-empty string")
    return raw


def parse_device_id(raw: Any) -> str:
    if not isinstance(raw, str) or not raw:
        raise SyncProfileError("deviceId is required and must be a non-empty string")
    return raw


def parse_device_type(raw: Any) -> DeviceType:
    if raw not in _VALID_DEVICE_TYPES:
        raise SyncProfileError(f"deviceType must be one of {sorted(_VALID_DEVICE_TYPES)}")
    return raw  # type: ignore[return-value]


def parse_device_label(raw: Any) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise SyncProfileError("deviceLabel is required and must be a non-empty string")
    return raw.strip()[:64]


def new_profile_record(*, now: datetime | None = None) -> dict[str, Any]:
    """A brand-new Sync Profile record, minted the first time two fresh devices pair with no prior profile between them."""
    created_at = (now or datetime.now(timezone.utc)).isoformat()
    return {"profileId": new_profile_id(), "createdAt": created_at}


def attach_device_record(
    *, profile_id: str, device_id: str, device_label: str, device_type: DeviceType, now: datetime | None = None
) -> dict[str, Any]:
    """The SyncDevice record to upsert when a device joins (or re-confirms its membership in) a Sync Profile.

    An upsert, not a create-once: re-pairing the same deviceId (e.g. the
    user re-scans a fresh QR for a device that already belongs to this
    profile) simply refreshes its label/lastSeenAt rather than erroring,
    since nothing about re-attaching an already-attached device is unsafe.
    """
    timestamp = (now or datetime.now(timezone.utc)).isoformat()
    return {
        "profileId": parse_profile_id(profile_id),
        "deviceId": parse_device_id(device_id),
        "deviceLabel": parse_device_label(device_label),
        "deviceType": parse_device_type(device_type),
        "createdAt": timestamp,
        "lastSeenAt": timestamp,
    }
