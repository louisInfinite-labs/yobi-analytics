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
