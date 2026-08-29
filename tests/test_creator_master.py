import json
from pathlib import Path

import pytest

from creator_master import Creator, CreatorMasterError, get_active_creators, load_creators

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "creators.json"


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
        ),
        Creator(
            creator_id="inactive_example",
            display_name="Inactive Example",
            organization="hololive",
            youtube_channel_id="UC_TEST_CHANNEL_2",
            active=False,
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
        json.dumps(
            [
                {
                    "creatorId": "graduated_example",
                    "displayName": "Graduated Example",
                    "organization": "hololive",
                    "youtubeChannelId": "UC_TEST_CHANNEL_4",
                    "active": True,
                    "discoveryEnabled": False,
                }
            ]
        ),
        encoding="utf-8",
    )

    creators = load_creators(path)

    assert creators[0].active is True
    assert creators[0].discovery_enabled is False


def test_string_discovery_enabled_value_is_rejected(tmp_path):
    """A non-boolean 'discoveryEnabled' is rejected instead of being treated as truthy."""
    path = tmp_path / "creators.json"
    path.write_text(
        json.dumps(
            [
                {
                    "creatorId": "bad_record",
                    "displayName": "Bad Record",
                    "organization": "vspo",
                    "youtubeChannelId": "UC_TEST_CHANNEL_5",
                    "active": True,
                    "discoveryEnabled": "false",
                }
            ]
        ),
        encoding="utf-8",
    )

    with pytest.raises(CreatorMasterError):
        load_creators(path)


def test_string_active_value_is_rejected(tmp_path):
    """A string like "false" for 'active' is rejected instead of being treated as truthy."""
    bad_creators_path = tmp_path / "creators.json"
    bad_creators_path.write_text(
        json.dumps(
            [
                {
                    "creatorId": "bad_record",
                    "displayName": "Bad Record",
                    "organization": "vspo",
                    "youtubeChannelId": "UC_TEST_CHANNEL_3",
                    "active": "false",
                }
            ]
        ),
        encoding="utf-8",
    )

    with pytest.raises(CreatorMasterError):
        load_creators(bad_creators_path)
