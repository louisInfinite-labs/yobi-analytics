import importlib.util
import sys
from pathlib import Path

import pytest

from tracking.creator_master import LEGACY_CREATOR_ID_ALIASES, load_creators

_MODULE_PATH = Path(__file__).resolve().parents[2] / "scripts" / "codegen" / "generate_creator_registry.py"
_spec = importlib.util.spec_from_file_location("generate_creator_registry", _MODULE_PATH)
generate_creator_registry = importlib.util.module_from_spec(_spec)
sys.modules.setdefault("generate_creator_registry", generate_creator_registry)
_spec.loader.exec_module(generate_creator_registry)

build_creator_registry = generate_creator_registry.build_creator_registry
render_creator_registry = generate_creator_registry.render_creator_registry
GENERATED_ARTIFACT_PATH = generate_creator_registry.GENERATED_ARTIFACT_PATH

_RUNTIME_FIELD_NAMES = {
    "status",
    "liveStatus",
    "streamTitle",
    "title",
    "scheduledStart",
    "scheduledStartMs",
    "actualStart",
    "videoId",
    "holodexStatus",
    "topic",
    "topics",
}


@pytest.fixture
def registry():
    return build_creator_registry()


def test_generated_creator_count_matches_backend_creator_master(registry):
    assert len(registry["creators"]) == len(load_creators())


def test_all_creator_ids_are_unique(registry):
    ids = [creator["creatorId"] for creator in registry["creators"]]
    assert len(ids) == len(set(ids))


def test_all_youtube_channel_ids_are_unique(registry):
    ids = [creator["youtubeChannelId"] for creator in registry["creators"]]
    assert len(ids) == len(set(ids))


def test_all_legacy_alias_targets_exist_in_the_generated_creator_list(registry):
    creator_ids = {creator["creatorId"] for creator in registry["creators"]}
    for legacy_id, canonical_id in registry["legacyAliases"].items():
        assert canonical_id in creator_ids, f"{legacy_id!r} aliases to {canonical_id!r}, which is not in the generated list"


def test_generated_aliases_exactly_match_the_canonical_alias_table(registry):
    """The alias table must never be hand-copied into a second, TypeScript-side
    source -- this proves the generated output is a pure derivation of
    LEGACY_CREATOR_ID_ALIASES, not an independently maintained copy of it."""
    assert registry["legacyAliases"] == LEGACY_CREATOR_ID_ALIASES


def test_avatar_url_null_is_preserved_for_every_current_creator(registry):
    """C1 added the avatarUrl schema, but no real data is synced yet (C7) --
    every generated creator must carry avatarUrl: null explicitly, never an
    omitted key or an empty string standing in for "no value"."""
    assert all("avatarUrl" in creator for creator in registry["creators"])
    assert all(creator["avatarUrl"] is None for creator in registry["creators"])


def test_no_runtime_fields_are_included(registry):
    for creator in registry["creators"]:
        leaked = _RUNTIME_FIELD_NAMES & creator.keys()
        assert not leaked, f"Runtime field(s) {leaked} leaked into the generated Creator Registry for {creator['creatorId']!r}"


def test_generation_is_deterministic_across_repeated_calls():
    assert render_creator_registry() == render_creator_registry()


def test_generated_creator_order_is_deterministic_by_creator_id(registry):
    ids = [creator["creatorId"] for creator in registry["creators"]]
    assert ids == sorted(ids)


def test_committed_artifact_matches_a_fresh_generation():
    """Drift guard: if src/creators.json, avatar_url values, or
    LEGACY_CREATOR_ID_ALIASES change without regenerating the committed
    artifact, this must fail -- exactly the class of bug that produced the
    118-vs-112 stale frontend copy this whole effort exists to prevent."""
    assert GENERATED_ARTIFACT_PATH.exists(), (
        f"{GENERATED_ARTIFACT_PATH} does not exist. Run "
        "`.venv/Scripts/python.exe scripts/codegen/generate_creator_registry.py` to generate it."
    )
    committed = GENERATED_ARTIFACT_PATH.read_text(encoding="utf-8")
    fresh = render_creator_registry()
    assert committed == fresh, (
        "The committed Creator Registry artifact is stale relative to its backend sources. "
        "Re-run `.venv/Scripts/python.exe scripts/codegen/generate_creator_registry.py` and commit the result."
    )
