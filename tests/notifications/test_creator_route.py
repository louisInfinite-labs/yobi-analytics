"""Push notifications open the Creator Home of the creator they are about (`data.url` = `/creator/<slug>`).

Pure rules of notifications/creator_route.py, the shared route across every creator-level notification (start, advance, late-discovery catch-up and
new video), and the dispatcher end of it: a creator that is unknown, inactive or malformed never gets a route, and the payload's own fields
(`videoId`, `reminderKind`) are never changed. The catch-up and new-video payloads are asserted end to end in test_late_discovery_catch_up.py and
test_new_video_dispatcher.py.
"""

from __future__ import annotations

import re
from datetime import timedelta

import pytest

from notifications import creator_route as creator_route_module
from notifications.creator_route import creator_route, with_creator_route
from tests.notifications.test_notification_dispatcher import _creator
from tests.notifications.test_scheduled_start_notifications import START, Harness, _stream
from tracking.creator_master import load_creators

FRONTEND_SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")  # frontend creatorFromSlug's shape


def _by_id(*creators) -> dict:
    """Creator Master entries keyed by creatorId, as the dispatchers build them."""
    return {creator.creator_id: creator for creator in creators}


def test_a_known_active_creator_gets_its_creator_home_route():
    """Canonical ids map to /creator/<id with underscores as hyphens>."""
    creators = _by_id(_creator(), _creator(creator_id="usada_pekora", youtube_channel_id="UC_other"))

    assert creator_route("aizawa_ema", creators) == "/creator/aizawa-ema"
    assert creator_route("usada_pekora", creators) == "/creator/usada-pekora"


def test_an_unknown_or_inactive_creator_gets_no_route():
    """A creator missing from, or inactive in, Creator Master has no route."""
    creators = _by_id(_creator(), _creator(creator_id="retired_one", youtube_channel_id="UC_r", active=False))

    assert creator_route("nobody_here", creators) is None
    assert creator_route("retired_one", creators) is None
    assert creator_route("aizawa_ema", {}) is None


@pytest.mark.parametrize(
    "bad_id",
    [None, 42, "", "Aizawa_Ema", "aizawa-ema", "aizawa__ema", "_ema", "ema_", "aizawa ema", "../admin", "aizawa_ema/../x", "https://evil.example/x", "//evil.example", "aizawa_ema?x=1", "javascript:alert(1)"],
)
def test_a_malformed_creator_id_never_becomes_a_route_even_if_the_master_held_it(bad_id):
    """Every bad string is registered as an ACTIVE creator, so only the strict id-shape check can refuse it."""
    creators = {bad_id: _creator()} if isinstance(bad_id, str) else {}

    assert creator_route(bad_id, creators) is None


def test_with_creator_route_keeps_every_field_and_never_mutates_its_input():
    """The route is added next to videoId/reminderKind; the caller's dict is left as it was."""
    creators = _by_id(_creator())
    original = {"videoId": "v1", "reminderKind": "advance"}

    enriched = with_creator_route(original, "aizawa_ema", creators)

    assert enriched == {"videoId": "v1", "reminderKind": "advance", "url": "/creator/aizawa-ema"}
    assert original == {"videoId": "v1", "reminderKind": "advance"}


def test_with_creator_route_without_a_valid_creator_returns_the_payload_unchanged_and_still_a_copy():
    """No valid creator: the payload is exactly what it was, with no url key."""
    original = {"videoId": "v1"}

    result = with_creator_route(original, "nobody_here", _by_id(_creator()))

    assert result == {"videoId": "v1"}
    assert result is not original


def test_every_active_creator_in_creator_master_maps_to_a_slug_the_frontend_accepts_and_that_round_trips():
    """The real roster: each active id gives a slug of the frontend's shape that maps back to the same canonical id."""
    active = [creator for creator in load_creators() if creator.active]
    creators = _by_id(*active)
    assert active

    for creator in active:
        route = creator_route(creator.creator_id, creators)
        assert route is not None, creator.creator_id
        slug = route.removeprefix(creator_route_module.CREATOR_ROUTE_PREFIX)
        assert FRONTEND_SLUG.fullmatch(slug), creator.creator_id
        assert slug.replace("-", "_") == creator.creator_id  # frontend creatorFromSlug resolves the same canonical id


# ---- the dispatcher end: start and advance reminders for a creator other than the default one ----


@pytest.fixture
def harness(monkeypatch):
    """A Harness with one subscriber (c1) who wants usada_pekora's 10-minute and start reminders for the 21:15 JST stream in the snapshot."""
    world = Harness(monkeypatch)
    world.creators = [_creator(), _creator(creator_id="usada_pekora", display_name="兎田ぺこら", youtube_channel_id="UC_other")]
    world.add_client("c1", creator_reminders={"usada_pekora": {"notifyAtStart": True, "advanceReminder": "10min"}})
    world.refresh_snapshot([_stream(creator="usada_pekora")], world.snapshot_at)
    return world


def test_start_and_advance_reminders_open_the_notified_creators_home_not_the_default_one(harness):
    """Both reminder kinds carry the notified creator's own route."""
    harness.run(START - timedelta(minutes=10) + timedelta(seconds=10))
    harness.run(START + timedelta(seconds=10))

    assert [push["data"] for push in harness.pushes] == [
        {"videoId": "v1", "reminderKind": "advance", "url": "/creator/usada-pekora"},
        {"videoId": "v1", "reminderKind": "start", "url": "/creator/usada-pekora"},
    ]


def test_a_creator_that_became_inactive_still_notifies_but_without_a_route(harness):
    """Eligibility is untouched; the payload just has no url, so a tap opens the app at /."""
    harness.creators = [_creator(), _creator(creator_id="usada_pekora", youtube_channel_id="UC_other", active=False)]

    harness.run(START + timedelta(seconds=10))

    assert [push["data"] for push in harness.pushes] == [{"videoId": "v1", "reminderKind": "start"}]


def test_a_creator_missing_from_creator_master_still_notifies_but_without_a_route(harness):
    """A creator absent from Creator Master is notified as before, without a url."""
    harness.creators = [_creator()]  # usada_pekora is not in the master any more

    harness.run(START + timedelta(seconds=10))

    assert [push["data"] for push in harness.pushes] == [{"videoId": "v1", "reminderKind": "start"}]
