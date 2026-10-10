"""The VAPID private key as the production secret holds it (PEM TEXT) must reach `webpush()` in a form it accepts, and one failed send
must never end the dispatcher run.

The production incident this guards: `get_vapid_credentials` returns PEM text, and `pywebpush.webpush(vapid_private_key=<str>)` only takes a
`Vapid` object, a file path or a raw/DER base64 string -- given PEM text it raised `ValueError: Could not deserialize key data` at the first
reminder that came due, which crashed the whole dispatcher invocation. Every earlier test stubbed `webpush` (and the key) so the real parsing
was never exercised. Here the key is a REAL ephemeral VAPID key and the REAL pywebpush/py_vapid signing + encryption run; only the final HTTP
POST (the fake session) is stubbed.
"""

from __future__ import annotations

import base64
import os
from datetime import datetime, timezone

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from py_vapid import Vapid
from pywebpush import webpush

from api import read_api
from notifications import notification_dispatcher, push_sender
from notifications.notification_dispatcher import lambda_handler
from stores import notification_delivery_log_store, notification_events_store, remote_config_store

from .test_notification_dispatcher import (  # noqa: F401  (autouse fixtures must be visible in this module)
    _START_MS,
    _frozen_datetime,
    _holodex_stream,
    _override_value,
    _preference_value,
    _remote_config_stub,
    stub_creators,
    stub_live_streams,
    stub_reminder_items,
    stub_vapid,
)

CLAIMS = {"sub": "mailto:test@example.com"}
START = datetime.fromtimestamp(_START_MS / 1000, tz=timezone.utc)


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def real_subscription() -> dict:
    """A well-formed browser-style subscription (valid P-256 public key + 16-byte auth secret) on an allowed push host."""
    point = ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return {"endpoint": "https://fcm.googleapis.com/fcm/send/ephemeral-test", "keys": {"p256dh": _b64url(point), "auth": _b64url(os.urandom(16))}}


def ephemeral_pem() -> str:
    """A throwaway VAPID private key as PEM TEXT -- the same shape the production secret resolves to. Nothing here is a real credential."""
    vapid = Vapid()
    vapid.generate_keys()
    return vapid.private_pem().decode()


class _FakeResponse:
    status_code = 201
    text = ""
    headers: dict = {}


class FakeSession:
    """Stands in for the HTTP layer only: records the request pywebpush built AFTER it parsed the key, signed and encrypted."""

    def __init__(self):
        self.posts: list[dict] = []

    def post(self, endpoint, **kwargs):
        self.posts.append({"endpoint": endpoint, **kwargs})
        return _FakeResponse()


@pytest.fixture
def session(monkeypatch):
    fake = FakeSession()
    monkeypatch.setattr(push_sender, "_PUSH_SESSION", fake)
    return fake


def send(key: str, subscription: dict | None = None):
    return push_sender.send_push_notification(
        subscription or real_subscription(), title="t", body="b", data=None, vapid_private_key=key, vapid_claims=CLAIMS
    )


# --- the key itself ---------------------------------------------------------


def test_the_library_really_rejects_pem_text_so_the_conversion_is_required(session):
    """Documents WHY push_sender converts: handing PEM text straight to webpush() is exactly the production failure."""
    with pytest.raises(ValueError, match="Could not deserialize key data"):
        webpush(subscription_info=real_subscription(), data="x", vapid_private_key=ephemeral_pem(), vapid_claims=dict(CLAIMS), requests_session=session)
    assert session.posts == []


def test_a_pem_key_is_parsed_signed_and_the_request_is_built_for_real(session):
    result = send(ephemeral_pem())

    assert result.sent is True and result.error is None
    [post] = session.posts
    assert post["endpoint"].startswith("https://fcm.googleapis.com/")
    authorization = post["headers"]["authorization"]
    assert authorization.startswith("vapid t=") and ",k=" in authorization  # a real, signed VAPID header


@pytest.mark.parametrize("decorate", [lambda pem: pem.rstrip("\n"), lambda pem: pem.replace("\n", "\r\n"), lambda pem: "\n" + pem + "\n\n", lambda pem: "  " + pem])
def test_whitespace_and_line_ending_variants_of_the_same_pem_still_work(session, decorate):
    assert send(decorate(ephemeral_pem())).sent is True
    assert len(session.posts) == 1


def test_a_raw_base64_key_string_still_goes_through_unchanged(session):
    """The non-PEM forms webpush() already accepts are not broken by the PEM handling."""
    vapid = Vapid()
    vapid.generate_keys()
    raw = vapid.private_key.private_numbers().private_value.to_bytes(32, "big")

    assert send(_b64url(raw)).sent is True
    assert len(session.posts) == 1


def test_a_garbage_pem_is_a_failed_send_not_an_exception_and_never_echoes_the_key(session):
    garbage = "-----BEGIN PRIVATE KEY-----\nTOPSECRETGARBAGE0123\n-----END PRIVATE KEY-----"

    result = send(garbage)

    assert result.sent is False and result.subscription_expired is False
    assert "VAPID private key could not be loaded" in result.error
    assert "TOPSECRET" not in result.error and "GARBAGE" not in result.error
    assert session.posts == []


def test_a_malformed_stored_subscription_key_is_a_failed_send_not_an_exception(session):
    subscription = real_subscription()
    subscription["keys"]["p256dh"] = _b64url(b"not-a-real-ec-point")

    result = send(ephemeral_pem(), subscription)

    assert result.sent is False and result.subscription_expired is False
    assert session.posts == []


# --- the dispatcher: one failed send never ends the run ---------------------

OTHER = "second_stream"


def run_dispatcher(monkeypatch, *, vapid_key: str, now: datetime = START, webpush_impl=None) -> tuple[list, set]:
    """One dispatcher pass at `now` for one subscribed client with a start-reminder override on TWO streams that are both due.

    The real push_sender, py_vapid and pywebpush run; returns (what reached `webpush_impl`, the delivery-log claims left afterwards).
    """
    streams = [_holodex_stream(videoId="first_stream", title="Ranked grind"), _holodex_stream(videoId=OTHER, title="Ranked grind")]
    monkeypatch.setattr(read_api, "get_live_streams", lambda *_a, **_kw: {"streams": streams})
    monkeypatch.setattr(notification_dispatcher, "datetime", _frozen_datetime(now))
    monkeypatch.setattr(notification_dispatcher, "get_vapid_credentials", lambda: (vapid_key, CLAIMS))
    monkeypatch.setattr(notification_events_store, "list_events_for_date", lambda event_date: [])
    monkeypatch.setattr(remote_config_store, "list_by_key", lambda key: [{"clientId": "c1", "value": _preference_value()}])
    overrides = {"first_stream": _override_value(notifyAtStart=True, advanceReminder=None), OTHER: _override_value(notifyAtStart=True, advanceReminder=None)}
    monkeypatch.setattr(remote_config_store, "get_remote_config", _remote_config_stub(subscription=real_subscription(), overrides=overrides))
    log: set = set()
    monkeypatch.setattr(notification_delivery_log_store, "already_delivered", lambda c, v: (c, v) in log)
    monkeypatch.setattr(notification_delivery_log_store, "mark_delivered", lambda c, v, at: log.add((c, v)) or True)
    monkeypatch.setattr(notification_delivery_log_store, "confirm_delivered", lambda *a, **kw: None)
    monkeypatch.setattr(notification_delivery_log_store, "release_claim", lambda c, v: log.discard((c, v)))
    reached: list[str] = []
    if webpush_impl is not None:
        monkeypatch.setattr(push_sender, "webpush", lambda **kwargs: webpush_impl(reached, **kwargs))
    result = lambda_handler({}, None)
    assert result["statusCode"] == 200
    return reached, log


def test_with_a_real_pem_key_every_due_reminder_is_signed_and_posted(monkeypatch, session):
    _, log = run_dispatcher(monkeypatch, vapid_key=ephemeral_pem())

    assert len(log) == 2
    assert len(session.posts) == 2  # both streams' start reminders, each really signed and encrypted
    assert all(p["headers"]["authorization"].startswith("vapid t=") for p in session.posts)


def test_an_unusable_key_fails_each_send_but_the_dispatcher_finishes_and_still_tries_every_reminder(monkeypatch, session):
    attempts: list[tuple] = []
    real = push_sender.send_push_notification

    def counting(*args, **kwargs):
        result = real(*args, **kwargs)
        attempts.append((kwargs["data"]["videoId"], result.sent))
        return result

    monkeypatch.setattr(notification_dispatcher.push_sender, "send_push_notification", counting)

    _, log = run_dispatcher(monkeypatch, vapid_key="-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5\n-----END PRIVATE KEY-----")  # does not raise

    assert sorted(video for video, _ in attempts) == ["first_stream", OTHER]  # the 2nd reminder was still attempted after the 1st failed
    assert all(sent is False for _, sent in attempts)
    assert log == set()  # failed sends release their claims, so nothing looks delivered


def test_a_signing_failure_on_the_first_reminder_does_not_stop_the_second(monkeypatch, session):
    calls = {"n": 0}

    def flaky(reached, *, data, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ValueError("signing failed")
        reached.append(data)

    reached, log = run_dispatcher(monkeypatch, vapid_key=ephemeral_pem(), webpush_impl=flaky)

    assert calls["n"] == 2 and len(reached) == 1  # A failed, B was still processed and sent
    assert len(log) == 1  # only B's claim stays; A's was released
