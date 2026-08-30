"""Creator Master: provider-neutral creator metadata, kept separate from collection logic."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from json_store import DATA_DIR, JsonStoreError, load_json_list

# DATA_DIR defaults to this package's own directory locally, but is overridden
# to /tmp on Lambda, where the deployment package itself is read-only (see
# Roadmap 2.2 "Known Constraint").
DEFAULT_CREATORS_PATH = DATA_DIR / "creators.json"


class CreatorMasterError(JsonStoreError):
    """Raised when a Creator Master JSON record is malformed."""


@dataclass(frozen=True)
class Creator:
    """A single creator's provider-neutral metadata."""

    creator_id: str
    display_name: str
    organization: str
    youtube_channel_id: str
    active: bool
    # False for a creator whose upload history is known to be closed (e.g. a
    # graduated talent). Their already-known videos still get statistics/
    # snapshots via active; Discovery just stops looking for new uploads.
    discovery_enabled: bool = True


def load_creators(path: Path = DEFAULT_CREATORS_PATH) -> list[Creator]:
    """Load all creators from the Creator Master JSON file."""
    raw_creators = load_json_list(path, store_name="Creator Master", error_class=CreatorMasterError)
    return [_parse_creator(raw) for raw in raw_creators]


def get_active_creators(path: Path = DEFAULT_CREATORS_PATH) -> list[Creator]:
    """Load creators and return only those marked active."""
    return [creator for creator in load_creators(path) if creator.active]


def _parse_creator(raw: dict) -> Creator:
    """Convert a raw Creator Master JSON record into a Creator instance."""
    try:
        creator_id = _require_str(raw, "creatorId")
        display_name = _require_str(raw, "displayName")
        organization = _require_str(raw, "organization")
        youtube_channel_id = _require_str(raw, "youtubeChannelId")

        active = raw["active"]
        if not isinstance(active, bool):
            raise CreatorMasterError(f"Creator {creator_id!r} has non-boolean 'active': {active!r}")
        discovery_enabled = raw.get("discoveryEnabled", True)
        if not isinstance(discovery_enabled, bool):
            raise CreatorMasterError(
                f"Creator {creator_id!r} has non-boolean 'discoveryEnabled': {discovery_enabled!r}"
            )
        return Creator(
            creator_id=creator_id,
            display_name=display_name,
            organization=organization,
            youtube_channel_id=youtube_channel_id,
            active=active,
            discovery_enabled=discovery_enabled,
        )
    except (KeyError, TypeError) as exc:
        raise CreatorMasterError(f"Malformed Creator Master record, missing/invalid field: {exc}") from exc


def _require_str(raw: dict, field: str) -> str:
    """Return raw[field] as a non-empty string, or raise CreatorMasterError."""
    value = raw.get(field)
    if not isinstance(value, str) or not value:
        raise CreatorMasterError(f"Creator {raw.get('creatorId')!r} has invalid {field!r}: {value!r}")
    return value
