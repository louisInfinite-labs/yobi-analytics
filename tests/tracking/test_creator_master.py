import json
from pathlib import Path

import pytest

from tracking.creator_master import (
    LEGACY_CREATOR_ID_ALIASES,
    Creator,
    CreatorMasterError,
    find_creator_by_youtube_channel_id,
    get_active_creators,
    is_content_collection_eligible,
    is_current_member_eligible,
    is_live_status_display_eligible,
    is_live_status_polling_eligible,
    is_my_oshi_eligible,
    load_creators,
    resolve_creator_key,
)

FIXTURE_PATH = Path(__file__).parent.parent / "fixtures" / "creators.json"


def _base_record(**overrides):
    record = {
        "creatorId": "bad_record",
        "displayName": "Bad Record",
        "organization": "vspo",
        "youtubeChannelId": "UC_TEST_CHANNEL_7",
        "active": True,
        "branch": "vspo_jp",
        "groupKey": ["NO"],
        "channelType": "member",
        "lifecycleStage": "active",
        "displayOrder": 0,
    }
    record.update(overrides)
    return record


def test_load_creators_parses_all_fields():
    """Every field of a Creator Master record is parsed into the Creator dataclass."""
    creators = load_creators(FIXTURE_PATH)

    assert creators == [
        Creator(
            creator_id="aizawa_ema",
            display_name="藍沢エマ",
            organization="vspo",
            youtube_channel_id="UC_TEST_CHANNEL",
            active=True,
            branch="vspo_jp",
            group_key=["NO"],
            channel_type="member",
            lifecycle_stage="active",
            display_order=0,
        ),
        Creator(
            creator_id="inactive_example",
            display_name="Inactive Example",
            organization="hololive",
            youtube_channel_id="UC_TEST_CHANNEL_2",
            active=False,
            branch="holo_jp",
            group_key=["2期生"],
            channel_type="member",
            lifecycle_stage="active",
            display_order=1,
        ),
    ]


def test_get_active_creators_filters_out_inactive():
    """Only creators marked active=true are returned."""
    active = get_active_creators(FIXTURE_PATH)

    assert len(active) == 1
    assert active[0].creator_id == "aizawa_ema"


def test_japanese_display_name_is_preserved():
    """Japanese display names survive the JSON round-trip intact."""
    creators = load_creators(FIXTURE_PATH)

    assert creators[0].display_name == "藍沢エマ"


def test_discovery_enabled_defaults_to_true_when_absent():
    """A record without 'discoveryEnabled' behaves as discovery_enabled=True."""
    creators = load_creators(FIXTURE_PATH)

    assert creators[0].discovery_enabled is True


def test_discovery_enabled_false_is_parsed(tmp_path):
    """A creator can be tracked (active=true) while discovery is disabled,
    e.g. a graduated talent whose known videos still get statistics/snapshots."""
    path = tmp_path / "creators.json"
    path.write_text(
        json.dumps([_base_record(discoveryEnabled=False, branch="holo_jp", groupKey=["3期生"])]),
        encoding="utf-8",
    )

    creators = load_creators(path)

    assert creators[0].active is True
    assert creators[0].discovery_enabled is False


def test_string_discovery_enabled_value_is_rejected(tmp_path):
    """A non-boolean 'discoveryEnabled' is rejected instead of being treated as truthy."""
    path = tmp_path / "creators.json"
    path.write_text(json.dumps([_base_record(discoveryEnabled="false")]), encoding="utf-8")

    with pytest.raises(CreatorMasterError):
        load_creators(path)


def test_display_order_is_parsed_when_present(tmp_path):
    """A valid int 'displayOrder' is parsed onto the Creator as-is."""
    path = tmp_path / "creators.json"
    path.write_text(json.dumps([_base_record(displayOrder=42)]), encoding="utf-8")

    creators = load_creators(path)

    assert creators[0].display_order == 42


def test_missing_display_order_is_rejected(tmp_path):
    """'displayOrder' is required -- a record without it fails to load rather
    than silently defaulting to an arbitrary order."""
    record = _base_record()
    del record["displayOrder"]
    path = tmp_path / "creators.json"
    path.write_text(json.dumps([record]), encoding="utf-8")

    with pytest.raises(CreatorMasterError):
        load_creators(path)


def test_string_display_order_is_rejected(tmp_path):
    """A non-int 'displayOrder' (e.g. a string) is rejected."""
    path = tmp_path / "creators.json"
    path.write_text(json.dumps([_base_record(displayOrder="0")]), encoding="utf-8")

    with pytest.raises(CreatorMasterError):
        load_creators(path)


def test_boolean_display_order_is_rejected(tmp_path):
    """A boolean 'displayOrder' is rejected -- Python's bool is an int subclass,
    so this must be checked explicitly rather than accepted as 0/1."""
    path = tmp_path / "creators.json"
    path.write_text(json.dumps([_base_record(displayOrder=True)]), encoding="utf-8")

    with pytest.raises(CreatorMasterError):
        load_creators(path)


def test_duplicate_display_order_across_roster_is_rejected(tmp_path):
    """Two creators sharing the same 'displayOrder' fail to load -- each record's
    displayOrder is individually well-typed, but displayOrder must also be unique
    across the whole roster (see Creator.display_order's own docstring)."""
    path = tmp_path / "creators.json"
    path.write_text(
        json.dumps(
            [
                _base_record(creatorId="creator_a", youtubeChannelId="UC_A", displayOrder=5),
                _base_record(creatorId="creator_b", youtubeChannelId="UC_B", displayOrder=5),
            ]
        ),
        encoding="utf-8",
    )

    with pytest.raises(CreatorMasterError):
        load_creators(path)


def test_duplicate_youtube_channel_id_across_roster_is_rejected(tmp_path):
    """PR #60 review fix: two creators sharing the same 'youtubeChannelId' must
    fail to load, not silently collapse into one entry for any caller that builds
    its own youtube_channel_id -> creator_id mapping from load_creators() directly
    (e.g. collection.subscriber_snapshot.channel_id_by_creator) rather than going
    through find_creator_by_youtube_channel_id's own duplicate check."""
    path = tmp_path / "creators.json"
    path.write_text(
        json.dumps(
            [
                _base_record(creatorId="creator_a", youtubeChannelId="UC_SHARED", displayOrder=5),
                _base_record(creatorId="creator_b", youtubeChannelId="UC_SHARED", displayOrder=6),
            ]
        ),
        encoding="utf-8",
    )

    with pytest.raises(CreatorMasterError):
        load_creators(path)


@pytest.mark.parametrize("field", ["creatorId", "displayName", "organization", "youtubeChannelId"])
def test_non_string_required_field_is_rejected(tmp_path, field):
    """A non-string (e.g. null or a number) required field is rejected, not silently accepted."""
    record = _base_record()
    record[field] = 42
    path = tmp_path / "creators.json"
    path.write_text(json.dumps([record]), encoding="utf-8")

    with pytest.raises(CreatorMasterError):
        load_creators(path)


def test_string_active_value_is_rejected(tmp_path):
    """A string like "false" for 'active' is rejected instead of being treated as truthy."""
    path = tmp_path / "creators.json"
    path.write_text(json.dumps([_base_record(active="false")]), encoding="utf-8")

    with pytest.raises(CreatorMasterError):
        load_creators(path)


def test_multiple_group_keys_are_parsed(tmp_path):
    """A creator can belong to more than one group at once (e.g. a generation and a cross-generation unit)."""
    path = tmp_path / "creators.json"
    path.write_text(
        json.dumps([_base_record(branch="holo_jp", groupKey=["1期生", "ゲーマーズ"])]), encoding="utf-8"
    )

    creators = load_creators(path)

    assert creators[0].group_key == ["1期生", "ゲーマーズ"]


def test_empty_group_key_list_is_rejected(tmp_path):
    """An empty 'groupKey' list is rejected — every creator must carry at least a placeholder group key."""
    path = tmp_path / "creators.json"
    path.write_text(json.dumps([_base_record(groupKey=[])]), encoding="utf-8")

    with pytest.raises(CreatorMasterError):
        load_creators(path)


def test_non_list_group_key_value_is_rejected(tmp_path):
    """A 'groupKey' value that isn't a list (e.g. a bare string) is rejected."""
    path = tmp_path / "creators.json"
    path.write_text(json.dumps([_base_record(groupKey="NO")]), encoding="utf-8")

    with pytest.raises(CreatorMasterError):
        load_creators(path)


def test_group_key_with_non_string_element_is_rejected(tmp_path):
    """A 'groupKey' list containing a non-string element (e.g. null) is rejected."""
    path = tmp_path / "creators.json"
    path.write_text(json.dumps([_base_record(groupKey=["NO", None])]), encoding="utf-8")

    with pytest.raises(CreatorMasterError):
        load_creators(path)


def test_missing_branch_is_rejected(tmp_path):
    """A record without 'branch' is rejected rather than silently defaulting."""
    record = _base_record()
    del record["branch"]
    path = tmp_path / "creators.json"
    path.write_text(json.dumps([record]), encoding="utf-8")

    with pytest.raises(CreatorMasterError):
        load_creators(path)


@pytest.mark.parametrize("branch", ["holo_jp", "holo_en", "holo_id", "vspo_jp", "vspo_en"])
def test_valid_branches_are_accepted(tmp_path, branch):
    """Each of the five defined branch values is accepted."""
    path = tmp_path / "creators.json"
    path.write_text(json.dumps([_base_record(branch=branch)]), encoding="utf-8")

    creators = load_creators(path)

    assert creators[0].branch == branch


def test_unknown_branch_is_rejected(tmp_path):
    """A branch outside the defined set (e.g. a typo like 'holo_JP') is rejected,
    instead of silently corrupting the region/language filtering hierarchy."""
    path = tmp_path / "creators.json"
    path.write_text(json.dumps([_base_record(branch="holo_JP")]), encoding="utf-8")

    with pytest.raises(CreatorMasterError):
        load_creators(path)


@pytest.mark.parametrize("channel_type", ["member", "group", "staff"])
def test_valid_channel_types_are_accepted(tmp_path, channel_type):
    """Each of the three defined channelType values is accepted."""
    path = tmp_path / "creators.json"
    path.write_text(json.dumps([_base_record(channelType=channel_type)]), encoding="utf-8")

    creators = load_creators(path)

    assert creators[0].channel_type == channel_type


def test_unknown_channel_type_is_rejected(tmp_path):
    """A channelType outside the defined set (member/group/staff) is rejected."""
    path = tmp_path / "creators.json"
    path.write_text(json.dumps([_base_record(channelType="solo")]), encoding="utf-8")

    with pytest.raises(CreatorMasterError):
        load_creators(path)


@pytest.mark.parametrize("stage", ["active", "pre_debut", "graduated", "retired"])
def test_valid_lifecycle_stages_are_accepted(tmp_path, stage):
    """Each of the four defined lifecycleStage values is accepted."""
    overrides = {"graduatedAt": "2025-05-01"} if stage == "graduated" else {}
    path = tmp_path / "creators.json"
    path.write_text(json.dumps([_base_record(lifecycleStage=stage, **overrides)]), encoding="utf-8")

    creators = load_creators(path)

    assert creators[0].lifecycle_stage == stage


def test_unknown_lifecycle_stage_is_rejected(tmp_path):
    """A lifecycleStage outside the defined set is rejected."""
    path = tmp_path / "creators.json"
    path.write_text(json.dumps([_base_record(lifecycleStage="hiatus")]), encoding="utf-8")

    with pytest.raises(CreatorMasterError):
        load_creators(path)


def test_pre_debut_can_be_active_for_collection(tmp_path):
    """lifecycleStage is independent of the collection toggle `active` —
    a pre-debut unit can still have active=true (it's being tracked)."""
    path = tmp_path / "creators.json"
    path.write_text(
        json.dumps([_base_record(active=True, lifecycleStage="pre_debut", channelType="group")]),
        encoding="utf-8",
    )

    creators = load_creators(path)

    assert creators[0].active is True
    assert creators[0].lifecycle_stage == "pre_debut"


def test_graduated_at_defaults_to_none_when_absent(tmp_path):
    """A creator with no 'graduatedAt' key parses as graduated_at=None (sparse by design),
    not a placeholder value like "0000"."""
    path = tmp_path / "creators.json"
    path.write_text(json.dumps([_base_record()]), encoding="utf-8")

    creators = load_creators(path)

    assert creators[0].graduated_at is None


def test_graduated_at_is_parsed_when_present(tmp_path):
    """A valid ISO date 'graduatedAt' is parsed onto the Creator."""
    path = tmp_path / "creators.json"
    path.write_text(
        json.dumps([_base_record(lifecycleStage="graduated", graduatedAt="2025-05-01")]), encoding="utf-8"
    )

    creators = load_creators(path)

    assert creators[0].graduated_at == "2025-05-01"


def test_non_string_graduated_at_is_rejected(tmp_path):
    """A non-string 'graduatedAt' (e.g. a number) is rejected."""
    path = tmp_path / "creators.json"
    path.write_text(json.dumps([_base_record(graduatedAt=20250501)]), encoding="utf-8")

    with pytest.raises(CreatorMasterError):
        load_creators(path)


def test_malformed_graduated_at_is_rejected(tmp_path):
    """A 'graduatedAt' that isn't a valid ISO 8601 date (e.g. wrong format) is rejected."""
    path = tmp_path / "creators.json"
    path.write_text(json.dumps([_base_record(graduatedAt="2025/05/01")]), encoding="utf-8")

    with pytest.raises(CreatorMasterError):
        load_creators(path)


@pytest.mark.parametrize("value", ["20250501", "2025-W18-4"])
def test_non_canonical_iso_date_forms_are_rejected(tmp_path, value):
    """date.fromisoformat() also accepts non-dashed and week-date ISO 8601 forms,
    but this project's convention is strictly "YYYY-MM-DD" — reject anything else,
    even if Python's own parser would otherwise accept it."""
    path = tmp_path / "creators.json"
    path.write_text(json.dumps([_base_record(graduatedAt=value)]), encoding="utf-8")

    with pytest.raises(CreatorMasterError):
        load_creators(path)


def test_graduated_without_graduated_at_is_rejected(tmp_path):
    """lifecycleStage='graduated' with no 'graduatedAt' key violates the invariant
    that a graduated creator must record when they graduated."""
    path = tmp_path / "creators.json"
    path.write_text(json.dumps([_base_record(lifecycleStage="graduated")]), encoding="utf-8")

    with pytest.raises(CreatorMasterError):
        load_creators(path)


def test_non_graduated_with_graduated_at_is_rejected(tmp_path):
    """A non-graduated lifecycleStage with a 'graduatedAt' present violates the
    invariant that only a graduated creator may carry a graduation date."""
    path = tmp_path / "creators.json"
    path.write_text(
        json.dumps([_base_record(lifecycleStage="active", graduatedAt="2025-05-01")]), encoding="utf-8"
    )

    with pytest.raises(CreatorMasterError):
        load_creators(path)


def test_theme_color_defaults_to_none_when_absent(tmp_path):
    """A record without 'themeColor' parses as theme_color=None (sparse by
    design, same as graduatedAt), not a guessed/generated placeholder."""
    path = tmp_path / "creators.json"
    path.write_text(json.dumps([_base_record()]), encoding="utf-8")

    creators = load_creators(path)

    assert creators[0].theme_color is None


def test_theme_color_is_parsed_and_normalized_to_uppercase(tmp_path):
    """A valid '#rrggbb' themeColor is parsed and normalized to uppercase."""
    path = tmp_path / "creators.json"
    path.write_text(json.dumps([_base_record(themeColor="#b4f1f9")]), encoding="utf-8")

    creators = load_creators(path)

    assert creators[0].theme_color == "#B4F1F9"


@pytest.mark.parametrize(
    "value", ["B4F1F9", "#FFF", "#GGGGGG", "rgb(1,2,3)", "", "#1234567", "#B4F1F9\n"]
)
def test_malformed_theme_color_is_rejected(tmp_path, value):
    """A themeColor that isn't exactly '#' followed by 6 hex digits is
    rejected, instead of reaching the frontend as a bad value."""
    path = tmp_path / "creators.json"
    path.write_text(json.dumps([_base_record(themeColor=value)]), encoding="utf-8")

    with pytest.raises(CreatorMasterError):
        load_creators(path)


def test_non_string_theme_color_is_rejected(tmp_path):
    """A non-string 'themeColor' (e.g. a number) is rejected."""
    path = tmp_path / "creators.json"
    path.write_text(json.dumps([_base_record(themeColor=123456)]), encoding="utf-8")

    with pytest.raises(CreatorMasterError):
        load_creators(path)


def test_asobimawaritai_members_have_verified_theme_colors():
    """The four アソビ★まわり隊！ pre-debut members are no longer reported as
    NO_VERIFIED_THEME_COLOR -- a later addition to the original 94-creator pass."""
    creators = {c.creator_id: c for c in load_creators()}

    assert creators["achichi_mela"].theme_color == "#1C97FF"
    assert creators["sorashina_sopia"].theme_color == "#7B7EFF"
    assert creators["suzuna_tsuzuri"].theme_color == "#E2383B"
    assert creators["hyakuto_kyoko"].theme_color == "#F86701"


def test_extreme_theme_colors_are_accepted_unchanged():
    """#FFFFFF and #000000 are valid verified colors and must not be coerced
    into something else for presentation reasons — the frontend, not this
    canonical data, is responsible for contrast handling."""
    creators = {c.creator_id: c for c in load_creators()}

    assert creators["sorasumi_sena"].theme_color == "#FFFFFF"
    assert creators["arya_kuroha"].theme_color == "#000000"


def test_avatar_url_defaults_to_none_when_absent(tmp_path):
    """A record without 'avatarUrl' parses as avatar_url=None (sparse by
    design, same as graduatedAt/themeColor), not a placeholder value."""
    path = tmp_path / "creators.json"
    path.write_text(json.dumps([_base_record()]), encoding="utf-8")

    creators = load_creators(path)

    assert creators[0].avatar_url is None


def test_avatar_url_is_parsed_when_present(tmp_path):
    """A present 'avatarUrl' string is parsed onto the Creator as-is."""
    path = tmp_path / "creators.json"
    path.write_text(
        json.dumps([_base_record(avatarUrl="https://yt3.googleusercontent.com/example=s800")]),
        encoding="utf-8",
    )

    creators = load_creators(path)

    assert creators[0].avatar_url == "https://yt3.googleusercontent.com/example=s800"


def test_blank_avatar_url_is_rejected(tmp_path):
    """An empty-string 'avatarUrl' is rejected rather than treated as a real value."""
    path = tmp_path / "creators.json"
    path.write_text(json.dumps([_base_record(avatarUrl="")]), encoding="utf-8")

    with pytest.raises(CreatorMasterError):
        load_creators(path)


def test_non_string_avatar_url_is_rejected(tmp_path):
    """A non-string 'avatarUrl' (e.g. a number) is rejected."""
    path = tmp_path / "creators.json"
    path.write_text(json.dumps([_base_record(avatarUrl=12345)]), encoding="utf-8")

    with pytest.raises(CreatorMasterError):
        load_creators(path)


def test_production_roster_theme_color_coverage():
    """98 of the 119 production creators carry a verified themeColor
    (Justice/ReGLOSS/FLOWGLOW, every VSPO JP/EN member, and all four
    アソビ★まわり隊！ pre-debut members included); the remaining 21 (graduated
    members, pre-debut mekPark units, staff/group channels -- including the
    hololive Official channel -- with no verified color) are correctly left
    unset for the frontend hashed-palette fallback."""
    creators = load_creators()

    with_color = [c for c in creators if c.theme_color is not None]
    without_color = [c for c in creators if c.theme_color is None]

    assert len(with_color) == 98
    assert len(without_color) == 21


def test_production_roster_has_avatar_url_populated_for_every_creator():
    """C7 completed the real YouTube avatar sync -- every canonical creator in
    the current production roster now carries a populated avatar_url. (The
    schema itself still tolerates a missing avatarUrl -- see
    test_avatar_url_defaults_to_none_when_absent above -- this test is about
    the current state of the real roster, not the schema.)"""
    creators = load_creators()

    assert creators
    assert all(c.avatar_url for c in creators)


def test_production_roster_display_order_values_are_unique_ints():
    """C8A0: every current production creator carries a display_order, each a
    plain int and unique across the roster -- the one canonical stable order
    consumers should sort member-selection/roster UIs by."""
    creators = load_creators()

    assert creators
    assert all(type(c.display_order) is int for c in creators)  # noqa: E721 -- bool is an int subclass, reject it explicitly
    assert len({c.display_order for c in creators}) == len(creators)


def test_production_roster_loads_with_unique_ids_and_the_verified_asobimawaritai_unit():
    creators = load_creators()

    assert len(creators) == 119
    assert len({creator.creator_id for creator in creators}) == len(creators)
    assert len({creator.youtube_channel_id for creator in creators}) == len(creators)

    unit = {creator.creator_id: creator for creator in creators if creator.group_key == ["アソビ★まわり隊！"]}
    assert {creator_id: (c.youtube_channel_id, c.channel_type) for creator_id, c in unit.items()} == {
        "hololive_asobimawaritai": ("UCAHwWUotyS3l2qBetFDsjgQ", "group"),
        "hyakuto_kyoko": ("UCSjQDxud2HkAO2DVD3lwxmw", "member"),
        "achichi_mela": ("UC8eitCE9Z6EwUCs-VUi1blg", "member"),
        "suzuna_tsuzuri": ("UCy9mgxB8pn2C4aNK_MPthDQ", "member"),
        "sorashina_sopia": ("UCROQtXcp2loQEmvpe5rhJzQ", "member"),
    }
    assert all(c.organization == "hololive" and c.branch == "holo_jp" and c.lifecycle_stage == "pre_debut" for c in unit.values())


def _write_roster(tmp_path, *records) -> Path:
    path = tmp_path / "creators.json"
    path.write_text(json.dumps(list(records)), encoding="utf-8")
    return path


class TestResolveCreatorKey:
    """resolve_creator_key: identity resolution only, never eligibility -- a resolved
    Creator (e.g. a "group" or "staff" channelType) says nothing about whether it's
    selectable for a particular feature; that is a separate, later concern."""

    def test_canonical_id_resolves(self, tmp_path):
        path = _write_roster(tmp_path, _base_record(creatorId="aizawa_ema"))

        resolved = resolve_creator_key("aizawa_ema", path)

        assert resolved is not None
        assert resolved.creator_id == "aizawa_ema"

    def test_ordinary_ch_prefixed_id_resolves(self, tmp_path):
        path = _write_roster(tmp_path, _base_record(creatorId="aizawa_ema"))

        resolved = resolve_creator_key("ch_aizawa_ema", path)

        assert resolved is not None
        assert resolved.creator_id == "aizawa_ema"

    def test_unknown_canonical_id_returns_none(self, tmp_path):
        path = _write_roster(tmp_path, _base_record(creatorId="aizawa_ema"))

        assert resolve_creator_key("nonexistent_creator", path) is None

    def test_unknown_ch_prefixed_id_returns_none(self, tmp_path):
        path = _write_roster(tmp_path, _base_record(creatorId="aizawa_ema"))

        assert resolve_creator_key("ch_nonexistent_creator", path) is None

    @pytest.mark.parametrize("value", ["", "   "])
    def test_blank_input_returns_none(self, tmp_path, value):
        path = _write_roster(tmp_path, _base_record(creatorId="aizawa_ema"))

        assert resolve_creator_key(value, path) is None

    @pytest.mark.parametrize("value", [None, 42, ["ch_aizawa_ema"], {"id": "ch_aizawa_ema"}])
    def test_malformed_non_string_input_returns_none(self, tmp_path, value):
        path = _write_roster(tmp_path, _base_record(creatorId="aizawa_ema"))

        assert resolve_creator_key(value, path) is None

    def test_does_not_mutate_creator_master(self, tmp_path):
        """Resolution is read-only -- the backing file's bytes must be identical before and after."""
        path = _write_roster(tmp_path, _base_record(creatorId="aizawa_ema"))
        before = path.read_bytes()

        resolve_creator_key("ch_aizawa_ema", path)
        resolve_creator_key("ch_nonexistent_creator", path)

        assert path.read_bytes() == before

    # -- Legacy alias table, verified against the real production roster,
    # since the alias targets (airani_iofifteen, watson_amelia, vspo_official)
    # are real Creator Master ids, not synthetic fixture data. --

    def test_ch_iofi_alias_resolves_to_airani_iofifteen(self):
        resolved = resolve_creator_key("ch_iofi")

        assert resolved is not None
        assert resolved.creator_id == "airani_iofifteen"

    def test_ch_amelia_myth_graduated_alias_resolves_to_watson_amelia(self):
        resolved = resolve_creator_key("ch_amelia_myth_graduated")

        assert resolved is not None
        assert resolved.creator_id == "watson_amelia"

    def test_ch_vspo_group_alias_resolves_to_vspo_official(self):
        """vspo_official resolves successfully as an identity -- whether a "group"
        channelType is *eligible* for a feature like My Oshi is a separate concern
        this resolver never decides."""
        resolved = resolve_creator_key("ch_vspo_group")

        assert resolved is not None
        assert resolved.creator_id == "vspo_official"
        assert resolved.channel_type == "group"

    def test_ch_hololive_staff_is_mock_only_and_does_not_resolve(self):
        """ch_hololive_staff has no Creator Master counterpart at all -- naive prefix
        stripping would produce "hololive_staff", which must NOT be fabricated as a
        synthetic record. It must resolve as unknown, exactly like any other id with
        no real backing record."""
        assert resolve_creator_key("ch_hololive_staff") is None

    def test_naive_prefix_stripping_of_the_known_aliases_would_not_have_worked(self):
        """Documents *why* the alias table exists: plain "ch_" stripping alone
        produces ids that are not in the current Creator Master at all."""
        creator_ids = {creator.creator_id for creator in load_creators()}
        assert "iofi" not in creator_ids
        assert "amelia_myth_graduated" not in creator_ids
        assert "vspo_group" not in creator_ids

    def test_all_legacy_alias_targets_exist_in_the_current_creator_master(self):
        creator_ids = {creator.creator_id for creator in load_creators()}

        for legacy_id, canonical_id in LEGACY_CREATOR_ID_ALIASES.items():
            assert canonical_id in creator_ids, f"{legacy_id!r} aliases to {canonical_id!r}, which no longer exists"
            assert resolve_creator_key(legacy_id) is not None


class TestFindCreatorByYoutubeChannelId:
    def test_valid_youtube_channel_id_resolves(self, tmp_path):
        path = _write_roster(tmp_path, _base_record(creatorId="aizawa_ema", youtubeChannelId="UC_TEST_1"))

        resolved = find_creator_by_youtube_channel_id("UC_TEST_1", path)

        assert resolved is not None
        assert resolved.creator_id == "aizawa_ema"

    def test_unknown_youtube_channel_id_returns_none(self, tmp_path):
        path = _write_roster(tmp_path, _base_record(creatorId="aizawa_ema", youtubeChannelId="UC_TEST_1"))

        assert find_creator_by_youtube_channel_id("UC_DOES_NOT_EXIST", path) is None

    @pytest.mark.parametrize("value", ["", "   ", None, 42])
    def test_blank_or_malformed_input_returns_none(self, tmp_path, value):
        path = _write_roster(tmp_path, _base_record(creatorId="aizawa_ema", youtubeChannelId="UC_TEST_1"))

        assert find_creator_by_youtube_channel_id(value, path) is None

    def test_duplicate_youtube_channel_id_raises_rather_than_silently_choosing_one(self, tmp_path):
        path = _write_roster(
            tmp_path,
            _base_record(creatorId="aizawa_ema", youtubeChannelId="UC_DUPLICATE"),
            _base_record(creatorId="another_creator", youtubeChannelId="UC_DUPLICATE"),
        )

        with pytest.raises(CreatorMasterError):
            find_creator_by_youtube_channel_id("UC_DUPLICATE", path)

    def test_production_roster_has_no_duplicate_youtube_channel_ids(self):
        """Guards the invariant find_creator_by_youtube_channel_id relies on: every
        real creator's youtubeChannelId is unique, so this lookup never has to choose."""
        for creator in load_creators():
            assert find_creator_by_youtube_channel_id(creator.youtube_channel_id) is not None


def _creator(**overrides) -> Creator:
    """A default active/member/current Creator, overridable per test -- eligibility
    tests build Creator instances directly rather than round-tripping JSON, since
    the eligibility functions take a Creator, not a key."""
    fields = {
        "creator_id": "test_creator",
        "display_name": "Test Creator",
        "organization": "vspo",
        "youtube_channel_id": "UC_TEST",
        "active": True,
        "branch": "vspo_jp",
        "group_key": ["NO"],
        "channel_type": "member",
        "lifecycle_stage": "active",
        "display_order": 0,
    }
    fields.update(overrides)
    return Creator(**fields)


class TestEligibility:
    """Live Status display, Live Status polling, My Oshi and new-content collection are
    four separate rules (see creator_master.py's own section note) -- never one shared
    predicate. A graduated individual creator is the case that proves it: displayed and
    Oshi-selectable, but neither polled nor discovered."""

    # --- Live Status display eligibility: every supported channel ---------------

    @pytest.mark.parametrize(
        "overrides",
        [
            {"channel_type": "member", "lifecycle_stage": "active"},
            {"channel_type": "member", "lifecycle_stage": "pre_debut"},
            {"channel_type": "member", "lifecycle_stage": "graduated"},
            {"channel_type": "group", "lifecycle_stage": "active"},
            {"channel_type": "group", "lifecycle_stage": "pre_debut"},
            {"channel_type": "staff", "lifecycle_stage": "active"},
        ],
        ids=["active-member", "pre-debut-member", "graduated-member", "active-group", "pre-debut-group", "staff"],
    )
    def test_every_supported_channel_is_display_eligible(self, overrides):
        assert is_live_status_display_eligible(_creator(**overrides)) is True

    def test_a_channel_taken_out_of_the_roster_is_not_displayed(self):
        assert is_live_status_display_eligible(_creator(active=False)) is False

    # --- Live Status polling eligibility: narrower than display -----------------

    @pytest.mark.parametrize(
        "overrides",
        [
            {"channel_type": "member", "lifecycle_stage": "active"},
            {"channel_type": "member", "lifecycle_stage": "pre_debut"},
            {"channel_type": "group", "lifecycle_stage": "active"},
            {"channel_type": "group", "lifecycle_stage": "pre_debut"},
            {"channel_type": "staff", "lifecycle_stage": "active"},
        ],
        ids=["active-member", "pre-debut-member", "active-group", "pre-debut-group", "staff"],
    )
    def test_current_channels_of_any_type_are_polled(self, overrides):
        assert is_live_status_polling_eligible(_creator(**overrides)) is True

    def test_a_graduated_member_is_displayed_but_never_polled(self):
        graduated = _creator(lifecycle_stage="graduated")

        assert is_live_status_display_eligible(graduated) is True
        assert is_live_status_polling_eligible(graduated) is False

    @pytest.mark.parametrize("channel_id", ["", "   ", "not-a-channel", "uc_lowercase", "UC has space"])
    def test_a_missing_or_malformed_youtube_channel_id_is_not_polled(self, channel_id):
        assert is_live_status_polling_eligible(_creator(youtube_channel_id=channel_id)) is False

    def test_a_retired_member_is_not_polled(self):
        assert is_live_status_polling_eligible(_creator(lifecycle_stage="retired")) is False

    # --- My Oshi eligibility: individual creators only, graduation keeps them ----

    @pytest.mark.parametrize("lifecycle_stage", ["active", "pre_debut", "graduated"])
    def test_an_individual_creator_is_oshi_eligible_in_every_current_or_graduated_stage(self, lifecycle_stage):
        assert is_my_oshi_eligible(_creator(lifecycle_stage=lifecycle_stage)) is True

    @pytest.mark.parametrize("channel_type", ["group", "staff"])
    @pytest.mark.parametrize("lifecycle_stage", ["active", "pre_debut", "graduated"])
    def test_group_and_staff_channels_are_never_oshi_eligible(self, channel_type, lifecycle_stage):
        assert is_my_oshi_eligible(_creator(channel_type=channel_type, lifecycle_stage=lifecycle_stage)) is False

    def test_a_retired_member_is_not_oshi_eligible(self):
        assert is_my_oshi_eligible(_creator(lifecycle_stage="retired")) is False

    def test_a_member_taken_out_of_the_roster_is_not_oshi_eligible(self):
        assert is_my_oshi_eligible(_creator(active=False)) is False

    # --- The original narrow "current member" rule (kept for /recent-streams) ----

    @pytest.mark.parametrize("lifecycle_stage", ["active", "pre_debut"])
    def test_current_member_rule_accepts_an_active_or_pre_debut_member(self, lifecycle_stage):
        assert is_current_member_eligible(_creator(lifecycle_stage=lifecycle_stage)) is True

    @pytest.mark.parametrize(
        "overrides",
        [
            {"lifecycle_stage": "graduated"},
            {"lifecycle_stage": "retired"},
            {"channel_type": "group"},
            {"channel_type": "staff"},
            {"active": False},
        ],
    )
    def test_current_member_rule_is_unchanged_and_rejects_everything_else(self, overrides):
        assert is_current_member_eligible(_creator(**overrides)) is False

    # --- New-content collection: graduated creators are never discovered ---------

    def test_content_collection_requires_discovery_enabled(self):
        assert is_content_collection_eligible(_creator(discovery_enabled=True)) is True
        assert is_content_collection_eligible(_creator(discovery_enabled=False)) is False

    def test_content_collection_is_not_widened_by_display_or_oshi_eligibility(self):
        graduated = _creator(lifecycle_stage="graduated", discovery_enabled=False)

        assert is_live_status_display_eligible(graduated) is True
        assert is_my_oshi_eligible(graduated) is True
        assert is_content_collection_eligible(graduated) is False

    # --- the real Creator Master ------------------------------------------------

    def test_real_master_every_graduated_member_is_displayed_and_oshi_eligible_but_not_polled_or_collected(self):
        graduated = [c for c in load_creators() if c.lifecycle_stage == "graduated"]

        assert len(graduated) == 13
        for creator in graduated:
            assert creator.channel_type == "member"
            assert is_live_status_display_eligible(creator) is True, creator.creator_id
            assert is_my_oshi_eligible(creator) is True, creator.creator_id
            assert is_live_status_polling_eligible(creator) is False, creator.creator_id
            assert is_content_collection_eligible(creator) is False, creator.creator_id

    def test_real_master_every_channel_is_displayed_and_the_polled_set_is_the_current_channels(self):
        creators = load_creators()
        polled = [c for c in creators if is_live_status_polling_eligible(c)]
        graduated_ids = {c.creator_id for c in creators if c.lifecycle_stage == "graduated"}

        assert len({c.creator_id for c in creators}) == len(creators)
        assert all(is_live_status_display_eligible(c) for c in creators)
        # Polled = every channel except the graduated members -- derived, not a pinned total.
        assert {c.creator_id for c in creators} - {c.creator_id for c in polled} == graduated_ids
        assert len(polled) == len(creators) - len(graduated_ids)

    def test_real_master_group_and_staff_channels_are_polled_but_not_oshi_eligible(self):
        non_members = [c for c in load_creators() if c.channel_type != "member"]

        assert {c.creator_id for c in non_members} == {
            "vspo_official",
            "hololive_official",
            "hololive_dev_is_regloss",
            "hololive_dev_is_flow_glow",
            "hololive_asobimawaritai",
            "fuwamoco",
            "achrora",
            "unit_b_pre_debut",
            "holoan_room",
        }
        for creator in non_members:
            assert is_live_status_display_eligible(creator) is True, creator.creator_id
            assert is_live_status_polling_eligible(creator) is True, creator.creator_id
            assert is_my_oshi_eligible(creator) is False, creator.creator_id

    def test_real_master_my_oshi_roster_is_every_individual_creator(self):
        creators = load_creators()
        eligible = [c for c in creators if is_my_oshi_eligible(c)]

        assert {c.creator_id for c in eligible} == {c.creator_id for c in creators if c.channel_type == "member"}
        assert all(c.channel_type == "member" for c in eligible)

    def test_hololive_official_is_the_verified_main_channel_and_is_displayed_and_polled_but_not_an_oshi(self):
        """The main hololive official YouTube channel (hololive.hololivepro.com/en/about) -- a
        canonical group-type channel, distinct from the old mock-only ch_hololive_staff."""
        official = next(c for c in load_creators() if c.creator_id == "hololive_official")

        assert official.youtube_channel_id == "UCJFZiqLMntJufDCHc6bQixg"
        assert official.organization == "hololive"
        assert official.branch == "holo_jp"
        assert official.channel_type == "group"
        assert official.lifecycle_stage == "active"
        assert official.group_key == ["NO"]
        assert is_live_status_display_eligible(official) is True
        assert is_live_status_polling_eligible(official) is True
        assert is_my_oshi_eligible(official) is False

    def test_ch_hololive_staff_stays_unresolved_and_is_not_the_main_official_channel(self):
        assert resolve_creator_key("ch_hololive_staff") is None
        assert resolve_creator_key("hololive_official") is not None

    def test_vspo_official_resolves_and_is_displayed_but_is_not_oshi_eligible(self):
        resolved = resolve_creator_key("ch_vspo_group")

        assert resolved is not None
        assert resolved.creator_id == "vspo_official"
        assert resolved.channel_type == "group"
        assert is_live_status_display_eligible(resolved) is True
        assert is_live_status_polling_eligible(resolved) is True
        assert is_my_oshi_eligible(resolved) is False

    def test_a_graduated_creator_remains_resolvable_by_canonical_id(self):
        """Graduated identity is never deleted/rejected by identity resolution."""
        graduated = next(c for c in load_creators() if c.lifecycle_stage == "graduated")

        resolved = resolve_creator_key(graduated.creator_id)

        assert resolved is not None
        assert resolved.creator_id == graduated.creator_id

    def test_historical_identity_lookup_is_unaffected_by_eligibility(self):
        """load_creators()/get_active_creators() -- the functions historical/analytics
        code actually uses -- must keep returning every creator regardless of
        eligibility; eligibility is a presentation-surface concern, not a data-
        access filter. This is a documentation test: it fails only if a future
        change starts filtering load_creators() by eligibility, which must not happen."""
        all_creators = load_creators()
        graduated = [c for c in all_creators if c.lifecycle_stage == "graduated"]

        assert len(graduated) > 0
        assert all(c in all_creators for c in graduated)
