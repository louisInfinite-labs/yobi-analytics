"""YouTube avatar sync maintenance CLI (C7A/C7B): populates Creator Master's
avatarUrl from each creator's own official YouTube channel thumbnail.

Canonical source: the YouTube Data API's channels.list(part="snippet") --
never Holodex (a supplementary, best-effort data source; see
tracking.creator_master.Creator.avatar_url's own docstring). Server-side
only: uses the existing backend YouTube API key (ops.config.get_api_key),
the same one collection/main.py already uses -- no separate key, no
frontend exposure, no new VITE_* variable.

Defaults to a dry run: fetches real avatar data and reports what WOULD
change, without writing anything. Pass --execute to actually write to
src/creators.json. Even in --execute mode, this only ever writes avatarUrl
-- every other Creator Master field, and every creator's on-disk order, is
preserved exactly (tracking.creator_avatar_sync.apply_avatar_update_plan).

Does NOT regenerate the frontend Creator Registry
(frontend/dashboard/src/entities/creator/data/generated/creatorMaster.json)
-- run scripts/codegen/generate_creator_registry.py separately afterward,
same as any other Creator Master edit.

Usage:
    .venv/Scripts/python.exe scripts/maintenance/sync_creator_avatars.py            # dry run
    .venv/Scripts/python.exe scripts/maintenance/sync_creator_avatars.py --execute  # write
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))

from ops.config import MissingAPIKeyError, get_api_key  # noqa: E402
from collection.youtube_client import (  # noqa: E402
    MAX_IDS_PER_REQUEST,
    YouTubeAPIError,
    build_youtube_client,
    get_channel_avatar_thumbnails,
)
from tracking.creator_avatar_sync import apply_avatar_update_plan, compute_avatar_update_plan  # noqa: E402
from tracking.creator_master import DEFAULT_CREATORS_PATH, load_creators  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Actually write avatarUrl changes to src/creators.json. Without this flag, reports only (dry run).",
    )
    args = parser.parse_args(argv)

    try:
        api_key = get_api_key()
    except MissingAPIKeyError as exc:
        print(f"Error: {exc}")
        return 1

    creators = load_creators()
    channel_ids = [creator.youtube_channel_id for creator in creators]
    deduped_count = len(dict.fromkeys(channel_ids))
    expected_requests = -(-deduped_count // MAX_IDS_PER_REQUEST)  # ceil division, no hardcoded roster size

    mode = "EXECUTE (writing to src/creators.json)" if args.execute else "DRY RUN (no writes)"
    print(f"=== YouTube avatar sync -- {mode} ===")
    print(
        f"Creators: {len(creators)}  Unique channel IDs: {deduped_count}  "
        f"Batch size: {MAX_IDS_PER_REQUEST}  Expected YouTube API requests: {expected_requests}\n"
    )

    try:
        youtube = build_youtube_client(api_key)
        avatars, skip_reasons = get_channel_avatar_thumbnails(youtube, channel_ids)
    except YouTubeAPIError as exc:
        print(f"Error: avatar fetch failed: {exc}")
        return 1

    plan = compute_avatar_update_plan(creators, avatars, skip_reasons)

    print(
        f"Would update: {len(plan.changes)}  Unchanged: {len(plan.unchanged_creator_ids)}  "
        f"No fresh data: {len(plan.skip_reasons)}\n"
    )
    for change in plan.changes:
        print(f"  {change.creator_id}: {change.old_avatar_url!r} -> {change.new_avatar_url!r}")
    if plan.skip_reasons:
        print("\nSkipped (existing avatarUrl preserved):")
        for creator_id, reason in plan.skip_reasons.items():
            print(f"  {creator_id}: {reason}")

    if args.execute:
        updated = apply_avatar_update_plan(plan, DEFAULT_CREATORS_PATH)
        print(f"\nWrote {updated} avatarUrl change(s) to {DEFAULT_CREATORS_PATH}")
        if updated:
            print("Remember to regenerate the frontend registry: python scripts/codegen/generate_creator_registry.py")
    else:
        print("\nDry run -- no changes written. Pass --execute to write.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
