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


def test_avatar_url_matches_the_backend_creator_master(registry):
    """C7 completed the real YouTube avatar sync -- every generated creator's
    avatarUrl must be a faithful, unmodified copy of the corresponding backend
    Creator.avatar_url (not re-derived or transformed), and every current
    canonical creator now has one populated."""
    avatar_url_by_id = {creator.creator_id: creator.avatar_url for creator in load_creators()}

    # hololive_official was added after C7 and awaits the avatar sync (see
    # tests/tracking/test_creator_master.py's AVATAR_SYNC_PENDING, the single source of truth).
    from tests.tracking.test_creator_master import AVATAR_SYNC_PENDING

    assert all("avatarUrl" in creator for creator in registry["creators"] if creator["creatorId"] not in AVATAR_SYNC_PENDING)
    assert all(creator["avatarUrl"] for creator in registry["creators"] if creator["creatorId"] not in AVATAR_SYNC_PENDING)
    for creator in registry["creators"]:
        assert creator.get("avatarUrl") == avatar_url_by_id[creator["creatorId"]]


def test_active_is_present_for_every_generated_creator(registry):
    assert all("active" in creator for creator in registry["creators"])


def test_display_order_matches_the_backend_creator_master(registry):
    """C8A0: the generated displayOrder must be a faithful, unmodified copy of
    the corresponding backend Creator.display_order -- the one canonical
    stable order My Oshi/Oshi Settings sort by, never a second copy of it."""
    display_order_by_id = {creator.creator_id: creator.display_order for creator in load_creators()}
    assert all("displayOrder" in creator for creator in registry["creators"])
    for creator in registry["creators"]:
        assert creator["displayOrder"] == display_order_by_id[creator["creatorId"]]


def test_display_order_values_are_unique_in_the_generated_artifact(registry):
    orders = [creator["displayOrder"] for creator in registry["creators"]]
    assert len(orders) == len(set(orders))


def test_active_exactly_matches_the_backend_creator_active_field(registry):
    """The eligibility rules (is_live_status_display_eligible/is_live_status_polling_eligible/is_my_oshi_eligible)
    depend on `active` alongside channelType/lifecycleStage -- this proves the
    generated value is a faithful copy of Creator.active, not derived/guessed."""
    active_by_id = {creator.creator_id: creator.active for creator in load_creators()}
    for creator in registry["creators"]:
        assert creator["active"] == active_by_id[creator["creatorId"]]


def test_active_is_a_real_boolean_not_a_stringified_value(registry):
    assert all(isinstance(creator["active"], bool) for creator in registry["creators"])


def test_discovery_enabled_is_not_exposed_in_the_generated_artifact(registry):
    """discoveryEnabled is not part of current-roster eligibility (C4) and must not
    be added merely because Creator Master happens to carry it."""
    assert all("discoveryEnabled" not in creator for creator in registry["creators"])


def test_no_derived_eligibility_boolean_is_exposed(registry):
    """The generated artifact exposes stable canonical facts only -- eligibility is a
    business rule the frontend derives from active/channelType/lifecycleStage itself,
    never a precomputed flag that would become a second copy of C4's own logic."""
    forbidden = {"selectable", "eligible", "liveRosterEligible", "isEligible", "isSelectable"}
    for creator in registry["creators"]:
        leaked = forbidden & creator.keys()
        assert not leaked, f"Derived eligibility field(s) {leaked} leaked into the generated registry for {creator['creatorId']!r}"


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
