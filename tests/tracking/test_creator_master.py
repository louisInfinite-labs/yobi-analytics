import json
from pathlib import Path

import pytest

from tracking.creator_master import Creator, CreatorMasterError, get_active_creators, load_creators

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
