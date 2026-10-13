import pytest

from tracking.discovery_windows import (
    DISCOVERY_WINDOW_IDS,
    DISCOVERY_WINDOWS_JST,
    LEGACY_SOURCE,
    UnknownDiscoveryWindowError,
    discovery_source,
    validate_window,
)


def test_there_are_exactly_five_discovery_windows_a_day():
    assert len(DISCOVERY_WINDOWS_JST) == 5
    assert len(DISCOVERY_WINDOW_IDS) == 5


def test_the_five_windows_are_exactly_the_specified_jst_times():
    assert DISCOVERY_WINDOWS_JST == (
        ("0000", "00:00"),
        ("0900", "09:00"),
        ("1300", "13:00"),
        ("2000", "20:00"),
        ("2200", "22:00"),
    )


def test_each_window_id_is_its_time_without_the_colon_and_the_windows_ascend():
    times = [time for _id, time in DISCOVERY_WINDOWS_JST]
    assert [window_id for window_id, _ in DISCOVERY_WINDOWS_JST] == [t.replace(":", "") for t in times]
    assert times == sorted(times)
    assert len(set(times)) == 5


def test_no_window_starts_at_the_18_00_daily_history_run():
    assert "1800" not in DISCOVERY_WINDOW_IDS


@pytest.mark.parametrize("window_id", sorted(DISCOVERY_WINDOW_IDS))
def test_a_known_window_is_accepted_and_names_the_events_source(window_id):
    assert validate_window(window_id) == window_id
    assert discovery_source(window_id) == f"discovery_window:{window_id}"


def test_no_window_means_the_legacy_collection_run_source():
    assert discovery_source(None) == LEGACY_SOURCE


@pytest.mark.parametrize("bad", ["0615", "", "0000 ", None, 500, ["0000"], "00:00"])
def test_an_unknown_window_fails_loudly(bad):
    with pytest.raises(UnknownDiscoveryWindowError):
        validate_window(bad)
