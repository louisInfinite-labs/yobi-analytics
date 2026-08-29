"""Creator Master: provider-neutral creator metadata, kept separate from collection logic."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from json_store import JsonStoreError, load_json_list

DEFAULT_CREATORS_PATH = Path(__file__).parent / "creators.json"


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
        active = raw["active"]
        if not isinstance(active, bool):
            raise CreatorMasterError(
                f"Creator {raw.get('creatorId')!r} has non-boolean 'active': {active!r}"
            )
        return Creator(
            creator_id=raw["creatorId"],
            display_name=raw["displayName"],
            organization=raw["organization"],
            youtube_channel_id=raw["youtubeChannelId"],
            active=active,
        )
    except (KeyError, TypeError) as exc:
        raise CreatorMasterError(f"Malformed Creator Master record, missing/invalid field: {exc}") from exc
