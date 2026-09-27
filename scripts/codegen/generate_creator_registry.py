"""Generate the committed frontend Creator Registry artifact (C3) from the
backend canonical Creator Master.

Canonical sources -- the only manually maintained inputs:
    src/creators.json                                  (tracking.creator_master.load_creators)
    tracking.creator_master.LEGACY_CREATOR_ID_ALIASES   (C2's legacy alias table)

Everything else in the generated artifact is derived, never hand-edited.
This exists specifically to stop a repeat of the drift already found in the
frontend's OTHER hand-maintained creator copy (features/notifications/data/
creators.json, discovered stale at 112 creators vs. the real 118) --
tests/codegen/test_generate_creator_registry.py's own drift test fails
loudly if this file is regenerated from changed source data but the
committed artifact wasn't updated to match.

Only stable, non-runtime creator metadata is generated. No live status,
stream title, scheduled/actual start time, Holodex data, or current topic --
those belong to runtime APIs (H4+), never this static, build-time artifact.

No AWS, no YouTube, no Holodex, no API keys: this reads only the local
creators.json file and the alias table already in source code.

Usage:
    .venv/Scripts/python.exe scripts/codegen/generate_creator_registry.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "src"))

from tracking.creator_master import LEGACY_CREATOR_ID_ALIASES, Creator, load_creators  # noqa: E402

GENERATED_ARTIFACT_PATH = (
    ROOT / "frontend" / "dashboard" / "src" / "entities" / "creator" / "data" / "generated" / "creatorMaster.json"
)


def _creator_to_dict(creator: Creator) -> dict[str, Any]:
    """Map one backend Creator onto the generated artifact's stable public shape.

    Field order here is what json.dumps (insertion-ordered) actually emits,
    so it is also what keeps the committed file's diffs readable.
    """
    return {
        "creatorId": creator.creator_id,
        "displayName": creator.display_name,
        "avatarUrl": creator.avatar_url,
        "organization": creator.organization,
        "branch": creator.branch,
        "groupKey": list(creator.group_key),
        "channelType": creator.channel_type,
        "themeColor": creator.theme_color,
        "lifecycleStage": creator.lifecycle_stage,
        # Included because tracking.creator_master's canonical eligibility
        # rules (is_creator_selectable/is_creator_live_roster_eligible, C4)
        # depend on it alongside channelType/lifecycleStage above -- without
        # it, a frontend consumer could not derive eligibility itself.
        # discoveryEnabled is deliberately NOT exposed here: no eligibility
        # rule depends on it, so it would only be a stable fact with no
        # consumer, not schema a future frontend actually needs.
        "active": creator.active,
        "youtubeChannelId": creator.youtube_channel_id,
    }


def build_creator_registry() -> dict[str, Any]:
    """Build the generated registry payload as a plain dict -- pure, no disk I/O.

    Creators are sorted by creatorId: creators.json's own on-disk order is
    not documented as a stable sort key, so sorting here (rather than
    trusting that order) is what actually makes the output deterministic
    regardless of how creators.json happens to be arranged.
    LEGACY_CREATOR_ID_ALIASES is copied in its own source-code definition
    order (already small and fixed, so this needs no separate sort).
    """
    creators = sorted(load_creators(), key=lambda creator: creator.creator_id)
    return {
        "creators": [_creator_to_dict(creator) for creator in creators],
        "legacyAliases": dict(LEGACY_CREATOR_ID_ALIASES),
    }


def render_creator_registry(registry: dict[str, Any] | None = None) -> str:
    """Render a registry dict as the exact JSON text written to disk.

    2-space indent, unescaped non-ASCII (so Japanese display names aren't
    \\uXXXX-escaped), and a trailing newline -- this is also what
    test_generate_creator_registry.py's drift test compares the committed
    file's bytes against, so any change here must be regenerated and
    recommitted together with that comparison.
    """
    if registry is None:
        registry = build_creator_registry()
    return json.dumps(registry, ensure_ascii=False, indent=2) + "\n"


def main() -> int:
    """Write the generated artifact to GENERATED_ARTIFACT_PATH."""
    GENERATED_ARTIFACT_PATH.parent.mkdir(parents=True, exist_ok=True)
    GENERATED_ARTIFACT_PATH.write_text(render_creator_registry(), encoding="utf-8")
    print(f"Wrote {GENERATED_ARTIFACT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
