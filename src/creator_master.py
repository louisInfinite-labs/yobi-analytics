"""Creator Master: provider-neutral creator metadata, kept separate from collection logic."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

DEFAULT_CREATORS_PATH = Path(__file__).parent / "creators.json"


class CreatorMasterError(ValueError):
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
    with open(path, encoding="utf-8") as f:
        raw_creators = json.load(f)
    return [_parse_creator(raw) for raw in raw_creators]


def get_active_creators(path: Path = DEFAULT_CREATORS_PATH) -> list[Creator]:
    """Load creators and return only those marked active."""
    return [creator for creator in load_creators(path) if creator.active]


def _parse_creator(raw: dict) -> Creator:
    """Convert a raw Creator Master JSON record into a Creator instance."""
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
