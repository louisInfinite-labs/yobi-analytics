"""Creator Master: provider-neutral creator metadata, kept separate from collection logic."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from stores.json_store import JsonStoreError, load_json_list

# Unlike video_master.json/snapshots (which the collector writes to, and so
# must live in a writable DATA_DIR — /tmp on Lambda), creators.json is a
# read-only reference dataset nothing ever writes at runtime. It stays on the
# package path deliberately: Lambda's deployment package is read-only but
# still readable, and nothing copies it into /tmp on cold start — pointing
# this at DATA_DIR would make load_json_list() see a missing file, silently
# return [], and make main() exit 0 having collected nothing.
DEFAULT_CREATORS_PATH = Path(__file__).parent.parent / "creators.json"


class CreatorMasterError(JsonStoreError):
    """Raised when a Creator Master JSON record is malformed."""


VALID_BRANCHES = {"holo_jp", "holo_en", "holo_id", "vspo_jp", "vspo_en"}
VALID_CHANNEL_TYPES = {"member", "group", "staff"}
VALID_LIFECYCLE_STAGES = {"active", "pre_debut", "graduated", "retired"}
THEME_COLOR_PATTERN = re.compile(r"^#[0-9A-Fa-f]{6}$")


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
    # `group_key` for that.
    branch: str
    # Generation/unit membership (a creator can belong to more than one, e.g.
    # Shirakami Fubuki is both "1期生" and "ゲーマーズ") or a single-element
    # placeholder like ["NO"] where the concept doesn't apply. Never empty.
    # A list rather than a single value specifically so the frontend can look
    # a creator up under every group they belong to.
    group_key: list[str]
    # "member" (an individual talent's own channel), "group" (an official
    # channel for a unit/generation, not one person), or "staff" (an official
    # non-talent channel, e.g. an announcer/PR channel).
    channel_type: str
    # Real-world status, independent of the collection toggle `active` — a
    # pre-debut unit can be lifecycle_stage="pre_debut" while active=true.
    lifecycle_stage: str
    # The single canonical stable display order for member-selection/roster
    # UIs (My Oshi, Oshi Settings, and any future consumer that needs a
    # curated rather than alphabetical order) — an ascending int, unique
    # across the roster. This is the ONE authoritative order; a consumer
    # sorts by this field rather than maintaining its own copy of it (C8A0).
    # Seeded once from the frontend's former hand-maintained mockCreators.ts
    # array order at migration time — mockCreators.ts is NOT the ongoing
    # authority for it going forward, this field is.
    display_order: int
    # False for a creator whose upload history is known to be closed (e.g. a
    # graduated talent). Their already-known videos still get statistics/
    # snapshots via active; Discovery just stops looking for new uploads.
    discovery_enabled: bool = True
    # ISO 8601 date a graduated creator's activities ended, or None if they
    # haven't (sparse — see Roadmap 1.3). Set if and only if
    # lifecycle_stage == "graduated" — enforced in _parse_creator.
    graduated_at: str | None = None
    # "#RRGGBB", the creator's verified official brand color, or None when
    # no verified value exists yet (sparse by design — never guessed/
    # generated; see this field's own migration task). The frontend's
    # deterministic hashed palette is the fallback for None, not something
    # this field ever needs to account for.
    theme_color: str | None = None
    # The creator's canonical avatar image URL, or None when it hasn't been
    # synced yet (sparse by design, same as theme_color above — never
    # guessed/generated). Canonical source: the YouTube Data API's
    # channels.list(part="snippet") -> snippet.thumbnails, preferring the
    # highest-quality thumbnail available — never a Holodex-provided photo,
    # since Holodex is a supplementary, best-effort data source (Roadmap
    # Phase 9) and must not become this field's source of truth. Populated
    # only by dedicated maintenance/sync tooling (not implemented yet); an
    # ordinary frontend/API request must never call YouTube on the fly to
    # refresh this, and a failed sync must leave the existing value (or
    # None) in place rather than making Creator Master itself unusable. The
    # frontend falls back to a generated colored-initial avatar when this
    # is None.
    avatar_url: str | None = None


def load_creators(path: Path = DEFAULT_CREATORS_PATH) -> list[Creator]:
    """Load all creators from the Creator Master JSON file."""
    raw_creators = load_json_list(path, store_name="Creator Master", error_class=CreatorMasterError)
    creators = [_parse_creator(raw) for raw in raw_creators]
    _require_unique_display_order(creators)
    _require_unique_youtube_channel_id(creators)
    return creators


def _require_unique_youtube_channel_id(creators: list[Creator]) -> None:
    """Raise CreatorMasterError if two creators share the same youtubeChannelId.

    PR #60 review fix: find_creator_by_youtube_channel_id (below) already
    raised on this same condition, but only within its own lookup -- any
    caller that instead builds its own youtube_channel_id -> creator_id
    mapping from load_creators()/get_active_creators() directly (e.g.
    collection.subscriber_snapshot.channel_id_by_creator) got no such guard,
    so a real duplicate would silently collapse into one entry instead of
    failing loudly. Enforced here, at load time, so every caller is
    protected regardless of which lookup path it uses.
    """
    seen: dict[str, str] = {}
    for creator in creators:
        if creator.youtube_channel_id in seen:
            raise CreatorMasterError(
                f"Duplicate youtubeChannelId {creator.youtube_channel_id!r} in Creator Master: "
                f"{seen[creator.youtube_channel_id]!r} and {creator.creator_id!r}"
            )
        seen[creator.youtube_channel_id] = creator.creator_id


def _require_unique_display_order(creators: list[Creator]) -> None:
    """Raise CreatorMasterError if two creators share the same displayOrder.

    _require_int (inside _parse_creator) only validates one record's
    displayOrder in isolation; displayOrder's whole purpose is to be each
    creator's unique position in the canonical UI ordering (see
    Creator.display_order's own docstring: "an ascending int, unique across
    the roster"), so a collision is a Creator Master data-integrity bug that
    must fail loudly rather than leave two creators silently tied for the
    same slot.
    """
    seen: dict[int, str] = {}
    for creator in creators:
        if creator.display_order in seen:
            raise CreatorMasterError(
                f"Duplicate displayOrder {creator.display_order!r} in Creator Master: "
                f"{seen[creator.display_order]!r} and {creator.creator_id!r}"
            )
        seen[creator.display_order] = creator.creator_id


def get_active_creators(path: Path = DEFAULT_CREATORS_PATH) -> list[Creator]:
    """Load creators and return only those marked active."""
    return [creator for creator in load_creators(path) if creator.active]


# The frontend roster's legacy id form is "ch_" + creatorId (e.g.
# "ch_aizawa_ema" for creatorId "aizawa_ema") -- see
# frontend/dashboard/src/features/dashboard/comparison/data/
# backendComparisonSource.ts and .../favorites/utils/creatorFavoriteBridge.ts,
# which each independently document and rely on the same convention. Plain
# stripping covers most ids, but a handful of legacy frontend ids predate or
# diverge from that convention -- kept here, small and explicit, never
# inferred from a name, exactly matching the frontend's own documented
# special cases:
#   "ch_iofi"                  -> a shorthand id, not a stripped form at all
#   "ch_amelia_myth_graduated" -> carries a status suffix the canonical id doesn't
#   "ch_vspo_group"            -> the frontend's own generic "group" naming,
#                                 not the canonical roster's own id for it
# Deliberately excludes "ch_hololive_staff": it is mock/legacy-only, with no
# Creator Master counterpart at all -- adding it here would fabricate an
# alias to a creator that doesn't exist, which resolve_creator_key() below
# must never do.
LEGACY_CREATOR_ID_ALIASES: dict[str, str] = {
    "ch_iofi": "airani_iofifteen",
    "ch_amelia_myth_graduated": "watson_amelia",
    "ch_vspo_group": "vspo_official",
}

_LEGACY_ROSTER_ID_PREFIX = "ch_"


def resolve_creator_key(key: str, path: Path = DEFAULT_CREATORS_PATH) -> Creator | None:
    """Resolve a canonical creatorId, legacy "ch_"-prefixed frontend id, or known legacy
    alias (LEGACY_CREATOR_ID_ALIASES) to its Creator Master record.

    Identity resolution only -- this never decides whether the resolved
    creator is *eligible* for a particular feature (My Oshi, Favorites,
    etc.); that is a separate, later concern. Stripping "ch_" (or applying
    an alias) only produces a *candidate* creatorId -- the actual lookup
    against Creator Master is what decides success, so a mock/legacy-only
    id with no real counterpart (e.g. "ch_hololive_staff" -> candidate
    "hololive_staff") returns None rather than a fabricated record. Returns
    None (not a raise) for anything that isn't a genuine creator identity:
    blank/non-string input, an unrecognized canonical id, or an
    unrecognized "ch_" id -- this is a lookup, not a validator of a
    required field.
    """
    if not isinstance(key, str) or not key.strip():
        return None

    candidate = LEGACY_CREATOR_ID_ALIASES.get(key, key)
    if key not in LEGACY_CREATOR_ID_ALIASES and candidate.startswith(_LEGACY_ROSTER_ID_PREFIX):
        candidate = candidate[len(_LEGACY_ROSTER_ID_PREFIX) :]

    for creator in load_creators(path):
        if creator.creator_id == candidate:
            return creator
    return None


def find_creator_by_youtube_channel_id(youtube_channel_id: str, path: Path = DEFAULT_CREATORS_PATH) -> Creator | None:
    """Return the Creator Master record for a real YouTube/Holodex channel id, or None.

    A distinct lookup from resolve_creator_key() above: youtube_channel_id
    is YouTube's own external id, with no "ch_" legacy-frontend form or
    alias table of its own to resolve -- kept as a separate function rather
    than folded into resolve_creator_key() because it resolves a completely
    different id space with none of that function's legacy-format concerns.
    Added here (rather than a new module) because both are Creator Master
    identity-lookup infrastructure, and this mapping is what the future
    Holodex integration needs to turn a Holodex youtube_channel_id back
    into a creator.

    Raises CreatorMasterError, rather than silently returning one of them,
    if the data itself is inconsistent (two records sharing the same
    youtubeChannelId) -- the current production roster is already verified
    unique (test_production_roster_loads_with_unique_ids_and_the_verified_
    asobimawaritai_unit), so this should never fire against real data; it
    exists to fail loudly rather than silently pick a creator if that
    invariant is ever violated.
    """
    if not isinstance(youtube_channel_id, str) or not youtube_channel_id.strip():
        return None

    index: dict[str, Creator] = {}
    for creator in load_creators(path):
        if creator.youtube_channel_id in index:
            raise CreatorMasterError(
                f"Duplicate youtubeChannelId {creator.youtube_channel_id!r} in Creator Master: "
                f"{index[creator.youtube_channel_id].creator_id!r} and {creator.creator_id!r}"
            )
        index[creator.youtube_channel_id] = creator
    return index.get(youtube_channel_id)


# ---------------------------------------------------------------------------
# Eligibility (C4) -- deliberately separate from identity resolution above.
#
# resolve_creator_key()/find_creator_by_youtube_channel_id() answer "does this
# key identify a real creator". The functions below answer a different
# question entirely: "should this ALREADY-RESOLVED creator appear in a given
# current-facing roster". A creator can resolve successfully and still be
# ineligible for every roster (e.g. vspo_official: a real Creator Master
# identity, channel_type "group", excluded from both rosters below) -- and
# the reverse is never true, since eligibility is only ever checked on an
# already-resolved Creator, not a raw key. Never call these from inside
# resolve_creator_key()/find_creator_by_youtube_channel_id(), and never use
# them as a general "does this creator exist" filter for historical/
# analytics consumers (see the module note below).
#
# active vs. lifecycle_stage vs. discovery_enabled -- audited, not assumed
# interchangeable:
#   - `active` is documented above (see get_active_creators()) as the
#     COLLECTION pipeline's own toggle: whether main.py still actively
#     processes this creator at all. It is intentionally independent of
#     real-world status (a pre-debut unit can be active=true; a graduated
#     creator can also still be active=true, per discovery_enabled's own
#     comment, purely so their already-known videos keep getting
#     statistics/snapshots).
#   - `lifecycle_stage` is the real-world status (active/pre_debut/graduated/
#     retired) -- this is what actually answers "is this a current talent".
#   - `discovery_enabled` only controls whether Discovery looks for NEW
#     uploads; it says nothing about a creator's own current-ness and is not
#     used below, since no product requirement for these two rosters depends
#     on upload-discovery state.
# Every one of the current 118 production creators has active=true, so
# `active` never actually excludes anyone today -- it is still checked
# explicitly below as a future-safe rule: a creator taken out of active
# collection has no reliable ongoing data, so a roster meant to show
# CURRENT status should not offer them either, even though nothing in
# today's data exercises that branch yet.
# ---------------------------------------------------------------------------

_CURRENT_LIFECYCLE_STAGES = frozenset({"active", "pre_debut"})


def _is_current_active_member(creator: Creator) -> bool:
    """Shared rule behind both eligibility functions below: an individual talent
    (channel_type "member") who is a current real-world talent (lifecycle_stage
    "active" or "pre_debut") and still under active collection."""
    return (
        creator.active
        and creator.channel_type == "member"
        and creator.lifecycle_stage in _CURRENT_LIFECYCLE_STAGES
    )


def is_creator_selectable(creator: Creator) -> bool:
    """Whether `creator` may be selected on a member-selection surface (My Oshi,
    Favorites).

    Currently identical to is_creator_live_roster_eligible() below -- kept as
    a separate function because the two surfaces are conceptually distinct
    (selecting a creator vs. showing them in a live/upcoming roster) and may
    diverge later; callers should use the function matching their own
    surface, not assume the two will always agree.
    """
    return _is_current_active_member(creator)


def is_creator_live_roster_eligible(creator: Creator) -> bool:
    """Whether `creator` may appear in a current live/upcoming roster (Live
    Status, Live Schedule).

    Currently identical to is_creator_selectable() above -- see that
    function's docstring for why they are kept separate anyway. A graduated
    creator's identity remains fully valid (resolve_creator_key() /
    load_creators() still return it) -- this function only says it should
    not appear in a CURRENT roster; historical/analytics consumers must
    never call this as a general creator filter (see the module note above
    this section).
    """
    return _is_current_active_member(creator)


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

        group_key = _require_str_list(raw, "groupKey", creator_id)

        channel_type = _require_str(raw, "channelType")
        if channel_type not in VALID_CHANNEL_TYPES:
            raise CreatorMasterError(f"Creator {creator_id!r} has invalid 'channelType': {channel_type!r}")

        lifecycle_stage = _require_str(raw, "lifecycleStage")
        if lifecycle_stage not in VALID_LIFECYCLE_STAGES:
            raise CreatorMasterError(f"Creator {creator_id!r} has invalid 'lifecycleStage': {lifecycle_stage!r}")

        display_order = _require_int(raw, "displayOrder", creator_id)

        discovery_enabled = raw.get("discoveryEnabled", True)
        if not isinstance(discovery_enabled, bool):
            raise CreatorMasterError(
                f"Creator {creator_id!r} has non-boolean 'discoveryEnabled': {discovery_enabled!r}"
            )

        graduated_at = _optional_iso_date(raw, "graduatedAt", creator_id)
        if (lifecycle_stage == "graduated") != (graduated_at is not None):
            raise CreatorMasterError(
                f"Creator {creator_id!r} has lifecycleStage {lifecycle_stage!r} "
                f"inconsistent with graduatedAt {graduated_at!r}: "
                "graduated requires graduatedAt, and only graduated may set it"
            )

        theme_color = _optional_theme_color(raw, "themeColor", creator_id)
        avatar_url = _optional_str(raw, "avatarUrl", creator_id)

        return Creator(
            creator_id=creator_id,
            display_name=display_name,
            organization=organization,
            youtube_channel_id=youtube_channel_id,
            active=active,
            branch=branch,
            group_key=group_key,
            channel_type=channel_type,
            lifecycle_stage=lifecycle_stage,
            display_order=display_order,
            discovery_enabled=discovery_enabled,
            graduated_at=graduated_at,
            theme_color=theme_color,
            avatar_url=avatar_url,
        )
    except (KeyError, TypeError) as exc:
        raise CreatorMasterError(f"Malformed Creator Master record, missing/invalid field: {exc}") from exc


def _require_str(raw: dict, field: str) -> str:
    """Return raw[field] as a non-empty string, or raise CreatorMasterError."""
    value = raw.get(field)
    if not isinstance(value, str) or not value:
        raise CreatorMasterError(f"Creator {raw.get('creatorId')!r} has invalid {field!r}: {value!r}")
    return value


def _require_int(raw: dict, field: str, creator_id: str) -> int:
    """Return raw[field] as an int, or raise CreatorMasterError.

    bool is deliberately rejected even though Python's bool is an int
    subclass -- a stray `true`/`false` here would silently parse as 1/0.
    """
    value = raw.get(field)
    if isinstance(value, bool) or not isinstance(value, int):
        raise CreatorMasterError(f"Creator {creator_id!r} has invalid {field!r}: {value!r}")
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


def _optional_str(raw: dict, field: str, creator_id: str) -> str | None:
    """Return raw[field] as a non-empty string if present, or None if the key is absent.

    For an optional field with no further format of its own to validate,
    unlike graduatedAt/themeColor below — but a present-and-wrong-type or
    blank value is still rejected rather than silently dropped, matching
    every other field's "no value" convention (an absent key, not a
    placeholder like an empty string).
    """
    if field not in raw:
        return None
    value = raw[field]
    if not isinstance(value, str) or not value:
        raise CreatorMasterError(f"Creator {creator_id!r} has invalid {field!r}: {value!r}")
    return value


def _optional_theme_color(raw: dict, field: str, creator_id: str) -> str | None:
    """Return raw[field] as a normalized "#RRGGBB" string, or None if the key is absent.

    Sparse by design, same as graduatedAt: omitted for every creator without
    a verified official color rather than a guessed/generated placeholder.
    A present-but-malformed value (wrong length, no '#', non-hex digits) is
    rejected rather than silently dropped, so a bad value fails here instead
    of reaching the frontend unnoticed.
    """
    if field not in raw:
        return None
    value = raw[field]
    if not isinstance(value, str) or not THEME_COLOR_PATTERN.fullmatch(value):
        raise CreatorMasterError(f"Creator {creator_id!r} has invalid {field!r}: {value!r}")
    return value.upper()
