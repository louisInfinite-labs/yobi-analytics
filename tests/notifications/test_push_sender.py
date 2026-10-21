from dataclasses import dataclass

import pytest
import requests
from pywebpush import WebPushException

from notifications import push_sender
from notifications.push_sender import (
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


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://fcm.googleapis.com/fcm/send/abc123",  # not HTTPS
        "https://evil.example.com/fcm/send/abc123",  # not an approved push service
        "https://fcm.googleapis.com.evil.example.com/fcm/send/abc123",  # lookalike host
        "http://web.push.apple.com/abc123",  # Apple's host, but not HTTPS
        "https://web.push.apple.com.evil.example.com/abc123",  # lookalike of Apple's host
        "https://evil.example.com/web.push.apple.com/abc123",  # the host name only appears in the path
        "https://push.apple.com/abc123",  # a different Apple host: only the exact web push service is approved
    ],
)
def test_parse_subscription_rejects_an_endpoint_outside_the_allowlist(endpoint):
    with pytest.raises(InvalidSubscriptionError):
        parse_subscription(_subscription(endpoint=endpoint))


@pytest.mark.parametrize(
    "endpoint",
    [
        "https://fcm.googleapis.com/fcm/send/abc123",  # Chrome / Edge / Android
        "https://updates.push.services.mozilla.com/wpush/v2/abc123",  # Firefox
        "https://web.push.apple.com/QGZxLjk2",  # Safari / iOS and iPadOS Home Screen web apps (a real iPhone Home Screen app sends this)
    ],
)
def test_parse_subscription_accepts_every_supported_push_service(endpoint):
    assert parse_subscription(_subscription(endpoint=endpoint))["endpoint"] == endpoint


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


def test_send_push_notification_never_raises_for_a_non_json_serializable_data_payload():
    """`data` reaching build_payload's json.dumps can carry a value that
    isn't JSON-serializable (e.g. a datetime) — json.dumps raises TypeError
    for that, not ValueError, so it must be caught here too."""
    result = send_push_notification(
        _subscription(),
        title="t",
        body="b",
        data={"when": object()},
        vapid_private_key="fake-key",
        vapid_claims={"sub": "mailto:test@example.com"},
    )

    assert result.sent is False
    assert result.subscription_expired is False
    assert result.error is not None


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


@pytest.mark.parametrize(
    "exc",
    [
        requests.Timeout("timed out"),
        requests.ConnectionError("connection refused"),
        requests.TooManyRedirects("redirected"),  # _PUSH_SESSION's max_redirects=0
    ],
)
def test_send_push_notification_treats_a_transport_failure_as_transient_not_expired(monkeypatch, exc):
    def _boom(**kwargs):
        raise exc

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
    assert result.error is not None


def test_send_push_notification_passes_a_bounded_timeout_and_the_hardened_session(monkeypatch):
    captured = {}

    def _fake_webpush(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(push_sender, "webpush", _fake_webpush)

    send_push_notification(
        _subscription(),
        title="t",
        body="b",
        data=None,
        vapid_private_key="fake-key",
        vapid_claims={"sub": "mailto:test@example.com"},
    )

    assert captured["timeout"] == push_sender._PUSH_REQUEST_TIMEOUT_SECONDS
    assert captured["requests_session"] is push_sender._PUSH_SESSION
    assert captured["requests_session"].max_redirects == 0


# --- retryable failures and the bounded immediate retry ----------------------------------------------------------------------


def _failing_webpush(status_code):
    """A webpush stand-in raising a WebPushException that carries an HTTP status (None = no response at all)."""
    from pywebpush import WebPushException

    class _Response:
        """Just enough of a requests.Response."""

        def __init__(self, status):
            self.status_code = status

    def fake(**kwargs):
        raise WebPushException("push failed", response=None if status_code is None else _Response(status_code))

    return fake


@pytest.mark.parametrize("status, retryable, expired", [(500, True, False), (503, True, False), (429, True, False), (None, True, False), (400, False, False), (401, False, False), (410, False, True), (404, False, True)])
def test_only_a_plausibly_transient_failure_is_marked_retryable(monkeypatch, status, retryable, expired):
    """5xx / 429 / no response are retryable; a 4xx rejection is not; 404 / 410 mean the subscription is gone."""
    monkeypatch.setattr(push_sender, "webpush", _failing_webpush(status))

    result = push_sender.send_push_notification(
        {"endpoint": "https://fcm.googleapis.com/fcm/send/x", "keys": {"p256dh": "a", "auth": "b"}},
        title="t", body="b", data=None, vapid_private_key="k", vapid_claims={"sub": "mailto:a@b.c"},
    )

    assert result.sent is False and result.retryable is retryable and result.subscription_expired is expired


def test_a_transport_error_is_retryable(monkeypatch):
    """A timeout / connection error never reached the push service well enough to know anything: retry once."""
    import requests

    def fake(**kwargs):
        raise requests.ConnectionError("reset")

    monkeypatch.setattr(push_sender, "webpush", fake)

    result = push_sender.send_push_notification(
        {"endpoint": "https://fcm.googleapis.com/fcm/send/x", "keys": {"p256dh": "a", "auth": "b"}},
        title="t", body="b", data=None, vapid_private_key="k", vapid_claims={"sub": "mailto:a@b.c"},
    )

    assert result.retryable is True


def _scripted(monkeypatch, results):
    """Make send_push_notification answer from `results` in order, counting calls."""
    calls = []
    monkeypatch.setattr(push_sender, "_RETRY_PAUSE_SECONDS", 0)
    monkeypatch.setattr(push_sender, "send_push_notification", lambda *a, **kw: (calls.append(1), results[len(calls) - 1])[1])
    return calls


def _bounded(attempts=2):
    """send_with_bounded_retry with throwaway arguments."""
    return push_sender.send_with_bounded_retry({}, title="t", body="b", data=None, vapid_private_key="k", vapid_claims={}, attempts=attempts)


def test_a_retryable_failure_is_sent_once_more_and_a_success_ends_it(monkeypatch):
    """One immediate re-send; the second answer is the result."""
    calls = _scripted(monkeypatch, [push_sender.PushResult(False, False, "x", retryable=True), push_sender.PushResult(True, False)])

    assert _bounded().sent is True and len(calls) == 2


def test_the_retry_is_bounded_and_never_repeats_a_non_retryable_or_expired_result(monkeypatch):
    """At most `attempts` sends; a permanent failure and an expired subscription are sent exactly once."""
    calls = _scripted(monkeypatch, [push_sender.PushResult(False, False, "x", retryable=True)] * 5)
    assert _bounded(attempts=3).sent is False and len(calls) == 3

    for result in (push_sender.PushResult(False, False, "bad", retryable=False), push_sender.PushResult(False, True, "gone", retryable=False)):
        calls = _scripted(monkeypatch, [result] * 5)
        assert _bounded().sent is False and len(calls) == 1
