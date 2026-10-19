"""The thumbnail (`data.image`) and the full `data` object of creator-level push notifications (notifications/notification_payload.py).

The image is DERIVED from a well-formed 11-character YouTube videoId into the `https://i.ytimg.com/vi/<id>/hqdefault.jpg` form the read API and the
dashboard already use -- no YouTube/Holodex request, nothing stored. A videoId that is not a real YouTube id gets no image, and that never changes
whether, when or to whom the notification is sent. Covered end to end for every kind: advance and start (scheduled_start harness), late-discovery
catch-up, and new video.
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from notifications.notification_payload import notification_data, youtube_thumbnail_url
from tests.notifications.new_video_harness import DAY1_EVENING, due_event, fake_delivery_log, preference_value, run_slot_pass
from tests.notifications.test_late_discovery_catch_up import RUN_AFTER, START as CATCH_UP_START, make_world as make_catch_up_world
from tests.notifications.test_notification_dispatcher import _creator
from tests.notifications.test_scheduled_start_notifications import START, Harness, _stream

VIDEO_ID = "dQw4w9WgXcQ"
THUMBNAIL = f"https://i.ytimg.com/vi/{VIDEO_ID}/hqdefault.jpg"


def test_a_well_formed_youtube_video_id_gets_its_thumbnail_url():
    """The canonical i.ytimg.com hqdefault URL, nothing else."""
    assert youtube_thumbnail_url(VIDEO_ID) == THUMBNAIL
    assert youtube_thumbnail_url("a-b_c1234Zz") == "https://i.ytimg.com/vi/a-b_c1234Zz/hqdefault.jpg"


@pytest.mark.parametrize(
    "bad_id",
    [None, 42, "", "v1", "sf6_stream", "dQw4w9WgXc", "dQw4w9WgXcQQ", "dQw4w9Wg.cQ", "dQw4w9Wg/cQ", "dQw4w9Wg?cQ", "../../x/evil", "http://evil.example/x", " dQw4w9WgXcQ", "dQw4w9WgXcQ\n"],
)
def test_anything_that_is_not_a_youtube_video_id_gets_no_thumbnail(bad_id):
    """A value that could change the host or path of the URL can never be spliced into it."""
    assert youtube_thumbnail_url(bad_id) is None


MAXRES = f"https://i.ytimg.com/vi/{VIDEO_ID}/maxresdefault.jpg"


@pytest.mark.parametrize("host", ["i.ytimg.com", "img.youtube.com"])
def test_a_stored_maxres_thumbnail_of_the_same_video_confirms_maxres(host):
    """YouTube lists the maxres variant only when the file exists, so a stored maxresdefault.jpg is proof; it is re-emitted in the canonical form."""
    assert youtube_thumbnail_url(VIDEO_ID, f"https://{host}/vi/{VIDEO_ID}/maxresdefault.jpg") == MAXRES


@pytest.mark.parametrize(
    "known",
    [
        None,
        "",
        42,
        f"https://i.ytimg.com/vi/{VIDEO_ID}/sddefault.jpg",  # discovery stored a smaller variant: Maxres was not available
        f"https://i.ytimg.com/vi/{VIDEO_ID}/hqdefault.jpg",
        f"https://i.ytimg.com/vi/{VIDEO_ID}/default.jpg",
        "https://i.ytimg.com/vi/otherVideo1/maxresdefault.jpg",  # a different video's Maxres proves nothing about this one
        f"https://evil.example.com/vi/{VIDEO_ID}/maxresdefault.jpg",
        f"https://i.ytimg.com.evil.example.com/vi/{VIDEO_ID}/maxresdefault.jpg",
        f"http://i.ytimg.com/vi/{VIDEO_ID}/maxresdefault.jpg",
        f"https://user:pw@i.ytimg.com/vi/{VIDEO_ID}/maxresdefault.jpg",
        f"https://i.ytimg.com:8443/vi/{VIDEO_ID}/maxresdefault.jpg",
        f"https://i.ytimg.com/vi/{VIDEO_ID}/maxresdefault.jpg?x=1",
        f"https://i.ytimg.com/vi/{VIDEO_ID}/maxresdefault.jpg#x",
        f"https://i.ytimg.com/vi_webp/{VIDEO_ID}/maxresdefault.webp",
        f" https://i.ytimg.com/vi/{VIDEO_ID}/maxresdefault.jpg",
    ],
)
def test_without_a_confirming_url_the_always_available_hq_thumbnail_is_used(known):
    """No known URL, another size, another video, a hostile or malformed URL: Maxres is never assumed -- HQ."""
    assert youtube_thumbnail_url(VIDEO_ID, known) == THUMBNAIL


def test_a_known_maxres_url_never_gives_a_malformed_video_id_an_image():
    """The video id is validated first: a bad id has no image whatever URL is offered."""
    assert youtube_thumbnail_url("bad", "https://i.ytimg.com/vi/bad/maxresdefault.jpg") is None


def test_notification_data_adds_route_and_image_keeps_the_original_fields_and_never_mutates_its_input():
    """videoId/reminderKind pass through untouched; url and image are only added."""
    original = {"videoId": VIDEO_ID, "reminderKind": "start"}
    creators = {"aizawa_ema": _creator()}

    enriched = notification_data(original, video_id=VIDEO_ID, creator_id="aizawa_ema", creators_by_id=creators)

    assert enriched == {"videoId": VIDEO_ID, "reminderKind": "start", "url": "/creator/aizawa-ema", "image": THUMBNAIL}
    assert original == {"videoId": VIDEO_ID, "reminderKind": "start"}


def test_notification_data_degrades_each_field_independently():
    """No valid creator: image only. No valid video id: route only. Neither: the payload as given."""
    creators = {"aizawa_ema": _creator()}

    assert notification_data({"videoId": VIDEO_ID}, video_id=VIDEO_ID, creator_id="nobody", creators_by_id=creators) == {"videoId": VIDEO_ID, "image": THUMBNAIL}
    assert notification_data({"videoId": "v1"}, video_id="v1", creator_id="aizawa_ema", creators_by_id=creators) == {"videoId": "v1", "url": "/creator/aizawa-ema"}
    assert notification_data({"videoId": "v1"}, video_id="v1", creator_id="nobody", creators_by_id=creators) == {"videoId": "v1"}


# ---- every notification kind, end to end through the real dispatchers ----


@pytest.fixture
def harness(monkeypatch):
    """A Harness with subscriber c1 wanting a 10-minute advance reminder and the start notification for a stream whose id is a real-format YouTube id."""
    world = Harness(monkeypatch)
    world.add_client("c1", creator_reminders={"aizawa_ema": {"notifyAtStart": True, "advanceReminder": "10min"}})
    world.refresh_snapshot([_stream(VIDEO_ID)], world.snapshot_at)
    return world


def test_advance_and_start_reminders_carry_route_and_thumbnail(harness):
    """Both on-time reminder kinds: videoId, reminderKind, creator route and the stream's thumbnail."""
    harness.run(START - timedelta(minutes=10) + timedelta(seconds=10))
    harness.run(START + timedelta(seconds=10))

    assert [push["data"] for push in harness.pushes] == [
        {"videoId": VIDEO_ID, "reminderKind": "advance", "url": "/creator/aizawa-ema", "image": THUMBNAIL},
        {"videoId": VIDEO_ID, "reminderKind": "start", "url": "/creator/aizawa-ema", "image": THUMBNAIL},
    ]


def test_a_late_discovery_catch_up_carries_route_and_thumbnail(monkeypatch):
    """The catch-up advance reminder goes through the same payload builder as the on-time one."""
    world = make_catch_up_world(monkeypatch, stream=_stream(VIDEO_ID, start=CATCH_UP_START))

    assert world.run(RUN_AFTER)["delivered"] == 1

    assert world.pushes[0]["data"] == {"videoId": VIDEO_ID, "reminderKind": "advance", "url": "/creator/aizawa-ema", "image": THUMBNAIL}


def test_a_new_video_notification_carries_route_and_thumbnail(monkeypatch):
    """The new-video slot dispatcher attaches the same fields."""
    fake_delivery_log(monkeypatch)

    sent = run_slot_pass(monkeypatch, now=DAY1_EVENING, preference=preference_value(), event=due_event(videoId=VIDEO_ID))

    assert sent == [{"videoId": VIDEO_ID, "url": "/creator/aizawa-ema", "image": THUMBNAIL}]


def test_a_new_video_event_carrying_a_stored_maxres_thumbnail_gets_maxres(monkeypatch):
    """The event's own stored (Video Master) thumbnail is the only thing that can confirm Maxres; nothing is looked up or probed."""
    fake_delivery_log(monkeypatch)

    sent = run_slot_pass(monkeypatch, now=DAY1_EVENING, preference=preference_value(), event=due_event(videoId=VIDEO_ID, thumbnailUrl=MAXRES))

    assert sent == [{"videoId": VIDEO_ID, "url": "/creator/aizawa-ema", "image": MAXRES}]


@pytest.mark.parametrize("stored", [f"https://i.ytimg.com/vi/{VIDEO_ID}/sddefault.jpg", "https://evil.example.com/x.jpg", None])
def test_a_new_video_event_without_a_confirming_thumbnail_is_still_delivered_with_hq(monkeypatch, stored):
    """A smaller stored size, a hostile URL or no thumbnail at all: HQ, and the delivery itself is unchanged."""
    fake_delivery_log(monkeypatch)

    sent = run_slot_pass(monkeypatch, now=DAY1_EVENING, preference=preference_value(), event=due_event(videoId=VIDEO_ID, thumbnailUrl=stored))

    assert sent == [{"videoId": VIDEO_ID, "url": "/creator/aizawa-ema", "image": THUMBNAIL}]


def test_reminders_always_use_hq_because_the_live_snapshot_thumbnail_confirms_nothing(monkeypatch):
    """The live-stream snapshot's thumbnailUrl is generated from the videoId (never a proof of Maxres) and is not even carried into the schedule."""
    world = Harness(monkeypatch)
    world.add_client("c1", creator_reminders={"aizawa_ema": {"notifyAtStart": True, "advanceReminder": None}})
    world.refresh_snapshot([{**_stream(VIDEO_ID), "thumbnailUrl": MAXRES}], world.snapshot_at)

    world.run(START + timedelta(seconds=10))

    assert [push["data"]["image"] for push in world.pushes] == [THUMBNAIL]


def test_a_stream_without_a_well_formed_video_id_is_still_delivered_without_an_image(monkeypatch):
    """A missing thumbnail is never a reason to drop or change a notification: same send, same text, no image."""
    world = Harness(monkeypatch)
    world.add_client("c1", creator_reminders={"aizawa_ema": {"notifyAtStart": True, "advanceReminder": None}})
    world.refresh_snapshot([_stream("not-a-real-id")], world.snapshot_at)

    summary = world.run(START + timedelta(seconds=10))

    assert summary["delivered"] == 1
    assert [push["data"] for push in world.pushes] == [{"videoId": "not-a-real-id", "reminderKind": "start", "url": "/creator/aizawa-ema"}]
