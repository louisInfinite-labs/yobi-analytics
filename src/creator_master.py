"""Creator Master: provider-neutral creator metadata, kept separate from collection logic."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path

from json_store import JsonStoreError, load_json_list

# Unlike video_master.json/snapshots (which the collector writes to, and so
# must live in a writable DATA_DIR — /tmp on Lambda), creators.json is a
# read-only reference dataset nothing ever writes at runtime. It stays on the
# package path deliberately: Lambda's deployment package is read-only but
# still readable, and nothing copies it into /tmp on cold start — pointing
# this at DATA_DIR would make load_json_list() see a missing file, silently
# return [], and make main() exit 0 having collected nothing.
DEFAULT_CREATORS_PATH = Path(__file__).parent / "creators.json"


class CreatorMasterError(JsonStoreError):
    """Raised when a Creator Master JSON record is malformed."""


VALID_BRANCHES = {"holo_jp", "holo_en", "holo_id", "vspo_jp", "vspo_en"}
VALID_CHANNEL_TYPES = {"member", "group", "staff"}
VALID_LIFECYCLE_STAGES = {"active", "pre_debut", "graduated", "retired"}


@dataclass(frozen=True)
class Creator:
    """A single creator's provider-neutral metadata."""

    creator_id: str
    display_name: str
    organization: str
    youtube_channel_id: str
    active: bool
    # Regional/language branch — one of holo_jp/holo_en/holo_id/vspo_jp/vspo_en.
    # A finer split than `organization`, since a single agency spans regions;
    # deliberately does NOT encode sub-labels like DEV_IS/mekPark/staff — see
    # `tags` for that.
    branch: str
    # Generation/unit membership (a creator can belong to more than one, e.g.
    # Shirakami Fubuki is both "1期生" and "ゲーマーズ") or a single-element
    # placeholder like ["NO"] where the concept doesn't apply. Never empty.
    tags: list[str]
    # "member" (an individual talent's own channel), "group" (an official
    # channel for a unit/generation, not one person), or "staff" (an official
    # non-talent channel, e.g. an announcer/PR channel).
    channel_type: str
    # Real-world status, independent of the collection toggle `active` — a
    # pre-debut unit can be lifecycle_stage="pre_debut" while active=true.
    lifecycle_stage: str
    # False for a creator whose upload history is known to be closed (e.g. a
    # graduated talent). Their already-known videos still get statistics/
    # snapshots via active; Discovery just stops looking for new uploads.
    discovery_enabled: bool = True
    # ISO 8601 date a graduated creator's activities ended, or None if they
    # haven't (sparse — see Roadmap 1.3). Only meaningful when
    # lifecycle_stage == "graduated"; not required to be consistent for any
    # other stage today.
    graduated_at: str | None = None


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

        branch = _require_str(raw, "branch")
        if branch not in VALID_BRANCHES:
            raise CreatorMasterError(f"Creator {creator_id!r} has invalid 'branch': {branch!r}")

        tags = _require_str_list(raw, "tags", creator_id)

        channel_type = _require_str(raw, "channelType")
        if channel_type not in VALID_CHANNEL_TYPES:
            raise CreatorMasterError(f"Creator {creator_id!r} has invalid 'channelType': {channel_type!r}")

        lifecycle_stage = _require_str(raw, "lifecycleStage")
        if lifecycle_stage not in VALID_LIFECYCLE_STAGES:
            raise CreatorMasterError(f"Creator {creator_id!r} has invalid 'lifecycleStage': {lifecycle_stage!r}")

        discovery_enabled = raw.get("discoveryEnabled", True)
        if not isinstance(discovery_enabled, bool):
            raise CreatorMasterError(
                f"Creator {creator_id!r} has non-boolean 'discoveryEnabled': {discovery_enabled!r}"
            )

        graduated_at = _optional_iso_date(raw, "graduatedAt", creator_id)

        return Creator(
            creator_id=creator_id,
            display_name=display_name,
            organization=organization,
            youtube_channel_id=youtube_channel_id,
            active=active,
            branch=branch,
            tags=tags,
            channel_type=channel_type,
            lifecycle_stage=lifecycle_stage,
            discovery_enabled=discovery_enabled,
            graduated_at=graduated_at,
        )
    except (KeyError, TypeError) as exc:
        raise CreatorMasterError(f"Malformed Creator Master record, missing/invalid field: {exc}") from exc


def _require_str(raw: dict, field: str) -> str:
    """Return raw[field] as a non-empty string, or raise CreatorMasterError."""
    value = raw.get(field)
    if not isinstance(value, str) or not value:
        raise CreatorMasterError(f"Creator {raw.get('creatorId')!r} has invalid {field!r}: {value!r}")
    return value


def _require_str_list(raw: dict, field: str, creator_id: str) -> list[str]:
    """Return raw[field] as a non-empty list of non-empty strings, or raise CreatorMasterError."""
    value = raw.get(field)
    if not isinstance(value, list) or not value or not all(isinstance(item, str) and item for item in value):
        raise CreatorMasterError(f"Creator {creator_id!r} has invalid {field!r}: {value!r}")
    return value


def _optional_iso_date(raw: dict, field: str, creator_id: str) -> str | None:
    """Return raw[field] as a "YYYY-MM-DD" date string if present, or None if the key is absent.

    A sparse field by design (see Roadmap 1.3) — omitted for creators it
    doesn't apply to, rather than a placeholder value like "0000".
    """
    if field not in raw:
        return None
    value = raw[field]
    if not isinstance(value, str):
        raise CreatorMasterError(f"Creator {creator_id!r} has non-string {field!r}: {value!r}")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise CreatorMasterError(f"Creator {creator_id!r} has invalid {field!r}: {value!r}") from exc
    # date.fromisoformat() also accepts non-canonical ISO 8601 forms (e.g. no
    # dashes, week-date syntax) that don't match this project's "YYYY-MM-DD"
    # convention for every other date field. Round-tripping through
    # isoformat() rejects anything that isn't already in that exact form.
    if parsed.isoformat() != value:
        raise CreatorMasterError(f"Creator {creator_id!r} has invalid {field!r}: {value!r}")
    return value
