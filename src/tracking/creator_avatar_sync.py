"""YouTube avatar sync maintenance tooling (C7A): populates Creator Master's
avatarUrl from each creator's own official YouTube channel thumbnail.

Canonical source: the YouTube Data API's channels.list(part="snippet") --
never Holodex, which is a supplementary, best-effort data source and must
not become this field's source of truth (see Creator.avatar_url's own
docstring in tracking.creator_master).

Three-stage pipeline, kept separate so the one stage with real decision
logic is testable without any network or disk I/O:
    fetch   collection.youtube_client.get_channel_avatar_thumbnails
    plan    compute_avatar_update_plan (pure, below)
    apply   apply_avatar_update_plan (disk I/O only, below)

This module builds and applies the *plan*; scripts/maintenance/
sync_creator_avatars.py is the CLI entry point that wires fetch -> plan ->
apply/dry-run together against the real Creator Master and the existing
backend YouTube API key (ops.config.get_api_key). An ordinary frontend/API
request must NEVER reach this module or call YouTube on the fly to refresh
an avatar -- this is maintenance/sync tooling only.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from stores.json_store import load_json_list, write_json_list
from tracking.creator_master import Creator, CreatorMasterError, DEFAULT_CREATORS_PATH


@dataclass(frozen=True)
class AvatarSyncChange:
    """One creator whose avatarUrl would change if a plan is applied."""

    creator_id: str
    old_avatar_url: str | None
    new_avatar_url: str


@dataclass(frozen=True)
class AvatarSyncPlan:
    """The result of comparing freshly fetched avatar thumbnails against
    Creator Master's current avatarUrl values -- pure data, no I/O of its
    own (see compute_avatar_update_plan). A dry run is simply "never pass
    this to apply_avatar_update_plan" -- nothing about building a plan
    touches disk or network.

    changes: creators whose avatarUrl would actually be written (the fresh
        value differs from what's already stored). Never includes a creator
        whose fetched avatar already matches the current value, so applying
        an all-unchanged plan is a guaranteed no-op/no-write.
    unchanged_creator_ids: every creator NOT in `changes` -- either no fresh
        avatar was available for them (skip_reasons explains why) or the
        fetched value already matches. Their existing avatarUrl (including
        None) is left exactly as-is.
    skip_reasons: creatorId -> why no fresh avatar was available for them
        (propagated from the fetch layer's own skip_reasons).
    """

    changes: list[AvatarSyncChange] = field(default_factory=list)
    unchanged_creator_ids: list[str] = field(default_factory=list)
    skip_reasons: dict[str, str] = field(default_factory=dict)

    @property
    def has_changes(self) -> bool:
        return bool(self.changes)


def compute_avatar_update_plan(
    creators: list[Creator],
    avatar_url_by_channel_id: dict[str, str],
    skip_reasons_by_channel_id: dict[str, str] | None = None,
) -> AvatarSyncPlan:
    """Pure: decide which creators' avatarUrl should change, given a fresh
    channelId -> avatarUrl map (from get_channel_avatar_thumbnails). No disk
    or network I/O -- safe to call with synthetic data in a test.

    A creator whose channel wasn't resolved (absent from
    avatar_url_by_channel_id) keeps their existing avatarUrl exactly as-is
    -- including staying None if it already was None -- never overwritten
    with null just because one refresh attempt found nothing (this task's
    own requirement 5 / Creator.avatar_url's own docstring).
    """
    skip_reasons_by_channel_id = skip_reasons_by_channel_id or {}
    changes: list[AvatarSyncChange] = []
    unchanged: list[str] = []
    skip_reasons: dict[str, str] = {}

    for creator in creators:
        fresh_avatar = avatar_url_by_channel_id.get(creator.youtube_channel_id)
        if fresh_avatar is None:
            unchanged.append(creator.creator_id)
            reason = skip_reasons_by_channel_id.get(creator.youtube_channel_id)
            if reason:
                skip_reasons[creator.creator_id] = reason
            continue
        if fresh_avatar == creator.avatar_url:
            unchanged.append(creator.creator_id)
            continue
        changes.append(
            AvatarSyncChange(creator_id=creator.creator_id, old_avatar_url=creator.avatar_url, new_avatar_url=fresh_avatar)
        )

    return AvatarSyncPlan(changes=changes, unchanged_creator_ids=unchanged, skip_reasons=skip_reasons)


def apply_avatar_update_plan(plan: AvatarSyncPlan, path: Path = DEFAULT_CREATORS_PATH) -> int:
    """Write plan.changes' new avatarUrl values into the Creator Master JSON
    file at `path`, changing NOTHING else: every other field of every
    record (changed or not), and every creator's on-disk order, is
    preserved exactly -- this mutates the SAME raw records read from disk,
    never reconstructs them.

    A no-op (no read, no write) when plan.has_changes is False, so an
    all-unchanged plan never produces file churn. Returns the number of
    records actually updated.

    Raises CreatorMasterError if a change targets a creatorId no longer
    present in the file at `path` (it changed under us between fetch and
    apply) -- fails loudly rather than silently dropping that change.
    """
    if not plan.has_changes:
        return 0

    raw_records = load_json_list(path, store_name="Creator Master", error_class=CreatorMasterError)
    new_avatar_by_creator_id = {change.creator_id: change.new_avatar_url for change in plan.changes}
    remaining_creator_ids = set(new_avatar_by_creator_id)

    updated = 0
    for record in raw_records:
        creator_id = record.get("creatorId")
        if creator_id in new_avatar_by_creator_id:
            record["avatarUrl"] = new_avatar_by_creator_id[creator_id]
            remaining_creator_ids.discard(creator_id)
            updated += 1

    if remaining_creator_ids:
        raise CreatorMasterError(f"apply_avatar_update_plan: creatorId(s) not found in {path}: {sorted(remaining_creator_ids)}")

    write_json_list(path, raw_records, store_name="Creator Master", error_class=CreatorMasterError)
    return updated
