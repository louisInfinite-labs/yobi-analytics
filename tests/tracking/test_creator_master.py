import json
from pathlib import Path

import pytest

from tracking.creator_master import (
    LEGACY_CREATOR_ID_ALIASES,
    Creator,
    CreatorMasterError,
    find_creator_by_youtube_channel_id,
    get_active_creators,
    is_creator_live_roster_eligible,
    is_creator_selectable,
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
    """98 of the 118 production creators carry a verified themeColor
    (Justice/ReGLOSS/FLOWGLOW, every VSPO JP/EN member, and all four
    アソビ★まわり隊！ pre-debut members included); the remaining 20 (graduated
    members, pre-debut mekPark units, staff/group channels with no verified
    color) are correctly left unset for the frontend hashed-palette
    fallback."""
    creators = load_creators()

    with_color = [c for c in creators if c.theme_color is not None]
    without_color = [c for c in creators if c.theme_color is None]

    assert len(with_color) == 98
    assert len(without_color) == 20


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

    assert len(creators) == 118
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
    is_creator_selectable/is_creator_live_roster_eligible take a Creator, not a key."""
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
    """is_creator_selectable (My Oshi / Favorites) and is_creator_live_roster_eligible
    (Live Status / Live Schedule) currently share one rule: an active-collection
    individual member who is a current real-world talent (active or pre_debut).
    Both functions are exercised identically below to prove they agree today,
    without assuming they must always agree (see their own docstrings)."""

    ELIGIBILITY_FUNCTIONS = [is_creator_selectable, is_creator_live_roster_eligible]

    @pytest.mark.parametrize("is_eligible", ELIGIBILITY_FUNCTIONS)
    def test_active_member_is_eligible(self, is_eligible):
        assert is_eligible(_creator(lifecycle_stage="active")) is True

    @pytest.mark.parametrize("is_eligible", ELIGIBILITY_FUNCTIONS)
    def test_pre_debut_member_is_eligible(self, is_eligible):
        """A pre-debut member is eligible even though no current stream exists yet --
        eligibility is about identity/status, not about whether they've ever streamed."""
        assert is_eligible(_creator(lifecycle_stage="pre_debut")) is True

    @pytest.mark.parametrize("is_eligible", ELIGIBILITY_FUNCTIONS)
    def test_graduated_member_is_excluded(self, is_eligible):
        assert is_eligible(_creator(lifecycle_stage="graduated")) is False

    @pytest.mark.parametrize("is_eligible", ELIGIBILITY_FUNCTIONS)
    def test_retired_member_is_excluded(self, is_eligible):
        assert is_eligible(_creator(lifecycle_stage="retired")) is False

    @pytest.mark.parametrize("is_eligible", ELIGIBILITY_FUNCTIONS)
    def test_active_group_is_excluded(self, is_eligible):
        """channel_type alone excludes a group, regardless of lifecycle_stage --
        never special-cased by creatorId (e.g. vspo_official) or branch."""
        assert is_eligible(_creator(channel_type="group", lifecycle_stage="active")) is False

    @pytest.mark.parametrize("is_eligible", ELIGIBILITY_FUNCTIONS)
    def test_pre_debut_group_is_excluded(self, is_eligible):
        """hololive_asobimawaritai's own real shape: channel_type "group" with
        lifecycle_stage "pre_debut" -- group exclusion wins regardless of
        lifecycle_stage, exactly per the accepted product rule."""
        assert is_eligible(_creator(channel_type="group", lifecycle_stage="pre_debut")) is False

    @pytest.mark.parametrize("is_eligible", ELIGIBILITY_FUNCTIONS)
    def test_active_staff_is_excluded(self, is_eligible):
        assert is_eligible(_creator(channel_type="staff", lifecycle_stage="active")) is False

    @pytest.mark.parametrize("is_eligible", ELIGIBILITY_FUNCTIONS)
    def test_active_false_member_is_excluded(self, is_eligible):
        """Future-safe rule, not exercised by any real data today (every production
        creator currently has active=true): a member taken out of active collection
        has no reliable ongoing data, so a current-facing roster must not offer them
        either, even though their real-world lifecycle_stage might still say "active"."""
        assert is_eligible(_creator(active=False, lifecycle_stage="active")) is False

    def test_vspo_official_resolves_but_is_ineligible_for_either_roster(self):
        """vspo_official: a real Creator Master identity (channel_type "group") --
        resolves successfully, but is ineligible for My Oshi and Live Status/Schedule."""
        resolved = resolve_creator_key("ch_vspo_group")

        assert resolved is not None
        assert is_creator_selectable(resolved) is False
        assert is_creator_live_roster_eligible(resolved) is False

    def test_hololive_asobimawaritai_resolves_but_is_ineligible(self):
        """hololive_asobimawaritai: channel_type "group", lifecycle_stage "pre_debut" --
        resolves successfully, but group exclusion wins over pre_debut eligibility."""
        resolved = resolve_creator_key("hololive_asobimawaritai")

        assert resolved is not None
        assert resolved.lifecycle_stage == "pre_debut"
        assert resolved.channel_type == "group"
        assert is_creator_selectable(resolved) is False
        assert is_creator_live_roster_eligible(resolved) is False

    def test_a_graduated_creator_remains_resolvable_by_canonical_id(self):
        """Graduated identity is never deleted/rejected by identity resolution --
        only excluded from the two CURRENT rosters by eligibility, a separate check."""
        graduated = next(c for c in load_creators() if c.lifecycle_stage == "graduated")

        resolved = resolve_creator_key(graduated.creator_id)

        assert resolved is not None
        assert resolved.creator_id == graduated.creator_id
        assert is_creator_selectable(resolved) is False
        assert is_creator_live_roster_eligible(resolved) is False

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
