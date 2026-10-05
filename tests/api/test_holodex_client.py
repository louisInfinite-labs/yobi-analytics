import requests
import pytest

from api import holodex_client
from api.holodex_client import HOLODEX_BASE_URL, HolodexAPIError, holodex_get


class _FakeResponse:
    """Minimal stand-in for requests.Response, just enough for holodex_get's use of it."""

    def __init__(self, *, status_code=200, json_data=None, text="", json_raises=False, headers=None):
        self.headers = headers or {}
        self.status_code = status_code
        self.ok = 200 <= status_code < 400
        self.text = text
        self._json_data = json_data
        self._json_raises = json_raises

    def json(self):
        if self._json_raises:
            raise ValueError("Expecting value: line 1 column 1 (char 0)")
        return self._json_data


@pytest.fixture(autouse=True)
def fake_api_key(monkeypatch):
    """Every test authenticates with this key, without touching real config/AWS/env."""
    monkeypatch.setattr(holodex_client, "get_holodex_api_key", lambda: "test-holodex-key")


def test_constructs_the_correct_url_params_and_x_apikey_header(monkeypatch):
    captured = {}

    def fake_get(url, params=None, headers=None, timeout=None):
        captured.update(url=url, params=params, headers=headers, timeout=timeout)
        return _FakeResponse(json_data=[])

    monkeypatch.setattr(holodex_client._HOLODEX_SESSION, "get", fake_get)

    holodex_get("/live", {"channel_id": "abc123"})

    assert captured["url"] == f"{HOLODEX_BASE_URL}/live"
    assert captured["params"] == {"channel_id": "abc123"}
    assert captured["headers"] == {"X-APIKEY": "test-holodex-key"}
    assert captured["timeout"] == holodex_client._HOLODEX_REQUEST_TIMEOUT_SECONDS


def test_returns_the_decoded_json_payload_on_success(monkeypatch):
    payload = [{"id": "vid1", "status": "live"}]
    monkeypatch.setattr(holodex_client._HOLODEX_SESSION, "get", lambda *a, **k: _FakeResponse(json_data=payload))

    assert holodex_get("/live", {"channel_id": "abc123"}) == payload


def test_raises_holodex_api_error_on_non_2xx_response(monkeypatch):
    monkeypatch.setattr(
        holodex_client._HOLODEX_SESSION,
        "get",
        lambda *a, **k: _FakeResponse(status_code=401, text="invalid API key"),
    )

    with pytest.raises(HolodexAPIError, match="401"):
        holodex_get("/live", {"channel_id": "abc123"})


def test_raises_holodex_api_error_on_transport_failure(monkeypatch):
    def fake_get(*args, **kwargs):
        raise requests.ConnectionError("connection refused")

    monkeypatch.setattr(holodex_client._HOLODEX_SESSION, "get", fake_get)

    with pytest.raises(HolodexAPIError, match="failed"):
        holodex_get("/live", {"channel_id": "abc123"})


def test_raises_holodex_api_error_on_timeout(monkeypatch):
    def fake_get(*args, **kwargs):
        raise requests.Timeout("timed out")

    monkeypatch.setattr(holodex_client._HOLODEX_SESSION, "get", fake_get)

    with pytest.raises(HolodexAPIError, match="timed out"):
        holodex_get("/live", {"channel_id": "abc123"})


def test_raises_holodex_api_error_on_malformed_non_json_response(monkeypatch):
    monkeypatch.setattr(
        holodex_client._HOLODEX_SESSION,
        "get",
        lambda *a, **k: _FakeResponse(json_raises=True),
    )

    with pytest.raises(HolodexAPIError, match="malformed"):
        holodex_get("/live", {"channel_id": "abc123"})


def test_uses_get_holodex_api_key_for_authentication_not_a_raw_env_var(monkeypatch):
    """Confirms the client goes through H1's accessor rather than reading an env var itself —
    swapping what get_holodex_api_key() returns must be the only way to change the header sent."""
    monkeypatch.setattr(holodex_client, "get_holodex_api_key", lambda: "a-different-key")
    captured = {}
    monkeypatch.setattr(
        holodex_client._HOLODEX_SESSION,
        "get",
        lambda url, params=None, headers=None, timeout=None: captured.update(headers=headers) or _FakeResponse(json_data=[]),
    )

    holodex_get("/live", {"channel_id": "abc123"})

    assert captured["headers"] == {"X-APIKEY": "a-different-key"}


def test_no_real_network_call_is_reachable_without_a_mocked_session(monkeypatch):
    """Guards against a future change accidentally bypassing _HOLODEX_SESSION: if this
    call path used a bare `requests.get` instead, this test would try to hit the real
    network and fail/hang here rather than in production."""
    monkeypatch.setattr(
        requests, "get", lambda *a, **k: pytest.fail("must not call requests.get directly; use _HOLODEX_SESSION")
    )
    monkeypatch.setattr(holodex_client._HOLODEX_SESSION, "get", lambda *a, **k: _FakeResponse(json_data=[]))

    holodex_get("/live", {"channel_id": "abc123"})


def test_a_429_carries_its_status_and_a_numeric_retry_after(monkeypatch):
    monkeypatch.setattr(
        holodex_client._HOLODEX_SESSION,
        "get",
        lambda *a, **k: _FakeResponse(status_code=429, text="slow down", headers={"Retry-After": "17"}),
    )

    with pytest.raises(HolodexAPIError) as raised:
        holodex_get("/users/live")

    assert raised.value.status_code == 429
    assert raised.value.retry_after_seconds == 17.0
    assert raised.value.timed_out is False


@pytest.mark.parametrize("header", [None, "", "soon", "-5", "Wed, 21 Oct 2026 07:28:00 GMT"])
def test_a_missing_or_non_numeric_retry_after_is_none(monkeypatch, header):
    headers = {} if header is None else {"Retry-After": header}
    monkeypatch.setattr(
        holodex_client._HOLODEX_SESSION, "get", lambda *a, **k: _FakeResponse(status_code=429, headers=headers)
    )

    with pytest.raises(HolodexAPIError) as raised:
        holodex_get("/users/live")

    assert raised.value.status_code == 429
    assert raised.value.retry_after_seconds is None


def test_a_timeout_is_flagged_as_timed_out(monkeypatch):
    def fake_get(*args, **kwargs):
        raise requests.Timeout("read timed out")

    monkeypatch.setattr(holodex_client._HOLODEX_SESSION, "get", fake_get)

    with pytest.raises(HolodexAPIError) as raised:
        holodex_get("/users/live")

    assert raised.value.timed_out is True
    assert raised.value.status_code is None
