from dataclasses import dataclass

import pytest
from pywebpush import WebPushException

import push_sender
from push_sender import (
    InvalidSubscriptionError,
    build_payload,
    parse_subscription,
    send_push_notification,
)


def _subscription(**overrides) -> dict:
    """Build a minimal well-formed Web Push subscription for a test, overriding only the given fields."""
    fields = {
        "endpoint": "https://fcm.googleapis.com/fcm/send/abc123",
        "keys": {"p256dh": "p256dh-value", "auth": "auth-value"},
    }
    fields.update(overrides)
    return fields


@dataclass
class _FakeResponse:
    status_code: int


# --- parse_subscription --------------------------------------------------


def test_parse_subscription_accepts_a_well_formed_subscription():
    sub = _subscription()
    assert parse_subscription(sub) == sub


@pytest.mark.parametrize(
    "bad_value",
    [
        None,
        "not-a-dict",
        {},
        {"endpoint": ""},
        {"endpoint": "https://example.com/x"},
        {"endpoint": "https://example.com/x", "keys": "not-a-dict"},
        {"endpoint": "https://example.com/x", "keys": {"p256dh": "", "auth": "a"}},
        {"endpoint": "https://example.com/x", "keys": {"p256dh": "p", "auth": ""}},
        {"endpoint": "https://example.com/x", "keys": {"p256dh": "p"}},
    ],
)
def test_parse_subscription_rejects_malformed_values(bad_value):
    with pytest.raises(InvalidSubscriptionError):
        parse_subscription(bad_value)


# --- build_payload -------------------------------------------------------


def test_build_payload_includes_title_and_body():
    payload = build_payload(title="New video", body="藍沢エマ just went live")
    assert '"title": "New video"' in payload
    assert "藍沢エマ" in payload


def test_build_payload_omits_data_when_not_given():
    payload = build_payload(title="t", body="b")
    assert "data" not in payload


def test_build_payload_includes_data_when_given():
    payload = build_payload(title="t", body="b", data={"videoId": "abc123"})
    assert "abc123" in payload


@pytest.mark.parametrize("bad_title", [None, ""])
def test_build_payload_rejects_a_missing_title(bad_title):
    with pytest.raises(ValueError):
        build_payload(title=bad_title, body="b")


@pytest.mark.parametrize("bad_body", [None, ""])
def test_build_payload_rejects_a_missing_body(bad_body):
    with pytest.raises(ValueError):
        build_payload(title="t", body=bad_body)


# --- send_push_notification -----------------------------------------------


def test_send_push_notification_reports_success(monkeypatch):
    monkeypatch.setattr(push_sender, "webpush", lambda **kwargs: None)

    result = send_push_notification(
        _subscription(),
        title="New video",
        body="body",
        data=None,
        vapid_private_key="fake-key",
        vapid_claims={"sub": "mailto:test@example.com"},
    )

    assert result.sent is True
    assert result.subscription_expired is False
    assert result.error is None


def test_send_push_notification_never_raises_for_a_malformed_stored_subscription():
    """A stored subscription is untrusted data (Roadmap 4.5's opaque
    key/value store) — a corrupt/partial value must come back as a
    PushResult, not propagate as an exception."""
    result = send_push_notification(
        {"endpoint": "no-keys-here"},
        title="t",
        body="b",
        data=None,
        vapid_private_key="fake-key",
        vapid_claims={"sub": "mailto:test@example.com"},
    )

    assert result.sent is False
    assert result.subscription_expired is False
    assert result.error is not None


@pytest.mark.parametrize("status_code", [404, 410])
def test_send_push_notification_marks_a_gone_subscription_as_expired(monkeypatch, status_code):
    def _boom(**kwargs):
        raise WebPushException("Push service rejected the subscription", response=_FakeResponse(status_code))

    monkeypatch.setattr(push_sender, "webpush", _boom)

    result = send_push_notification(
        _subscription(),
        title="t",
        body="b",
        data=None,
        vapid_private_key="fake-key",
        vapid_claims={"sub": "mailto:test@example.com"},
    )

    assert result.sent is False
    assert result.subscription_expired is True


@pytest.mark.parametrize("status_code", [400, 429, 500])
def test_send_push_notification_treats_other_failures_as_transient_not_expired(monkeypatch, status_code):
    def _boom(**kwargs):
        raise WebPushException("Push service had a problem", response=_FakeResponse(status_code))

    monkeypatch.setattr(push_sender, "webpush", _boom)

    result = send_push_notification(
        _subscription(),
        title="t",
        body="b",
        data=None,
        vapid_private_key="fake-key",
        vapid_claims={"sub": "mailto:test@example.com"},
    )

    assert result.sent is False
    assert result.subscription_expired is False


def test_send_push_notification_treats_a_response_less_exception_as_transient_not_expired(monkeypatch):
    def _boom(**kwargs):
        raise WebPushException("Network error before any response arrived")

    monkeypatch.setattr(push_sender, "webpush", _boom)

    result = send_push_notification(
        _subscription(),
        title="t",
        body="b",
        data=None,
        vapid_private_key="fake-key",
        vapid_claims={"sub": "mailto:test@example.com"},
    )

    assert result.sent is False
    assert result.subscription_expired is False
