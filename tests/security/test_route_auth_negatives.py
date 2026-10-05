"""SEC-TEST-001 (launch scope, part 3): the admin-key and client-secret negatives on every protected route.

Driven by the route classification, so a route added to the admin / client-scoped class automatically gets these
negatives. Each rejection must happen before any data-plane work (a spy fails the request on any store access).
"""

from __future__ import annotations

import pytest

from api import api_handler, client_credential_api
from ops import config

from .route_inventory import ADMIN_ROUTES, CLIENT_SCOPED_ROUTES
from .spies import event, forbid_data_plane

pytestmark = pytest.mark.security

CLIENT_A = "00000000-0000-4000-8000-00000000000a"
CLIENT_B = "00000000-0000-4000-8000-00000000000b"
SECRET_A = "secret-of-client-a"
SECRET_B = "secret-of-client-b"
ADMIN_KEY = "admin-key-value"

_SUBSCRIPTION = {"endpoint": "https://fcm.googleapis.com/fcm/send/x", "keys": {"p256dh": "AAAA", "auth": "BBBB"}}
_BODIES = {
    "PUT /clients/{clientId}/push-subscription": _SUBSCRIPTION,
    "PUT /clients/{clientId}/notification-preference": {"enabled": True, "deliveryWindows": ["08:00"]},
    "POST /remote-config": {"clientId": CLIENT_A, "key": "enabled", "value": True},
}


def _client_event(route: str, headers: dict | None) -> dict:
    return event(route, path={"clientId": CLIENT_A}, query={"clientId": CLIENT_A}, body=_BODIES.get(route, {}), headers=headers)


def _admin_event(route: str, headers: dict | None) -> dict:
    return event(route, body=_BODIES.get(route), headers=headers)


@pytest.fixture
def credentials(monkeypatch):
    """Two registered clients (only their hashes are stored) and a configured admin key; no data plane is reachable."""
    hashes = {CLIENT_A: client_credential_api.hash_secret(SECRET_A), CLIENT_B: client_credential_api.hash_secret(SECRET_B)}
    recorder = forbid_data_plane(monkeypatch)

    class _Credentials:
        @staticmethod
        def get_secret_hash(client_id):
            return hashes.get(client_id)

    monkeypatch.setattr(api_handler, "client_credential_store", _Credentials)
    monkeypatch.setattr(config, "get_admin_api_key", lambda: ADMIN_KEY)
    return recorder


CLIENT_NEGATIVES = {
    "missing header": None,
    "empty secret": {"X-Client-Secret": ""},
    "wrong secret": {"X-Client-Secret": "not-the-secret"},
    "another client's secret": {"X-Client-Secret": SECRET_B},
    "non-ASCII secret": {"X-Client-Secret": "秘密-ünïcode"},
    "secret with different case": {"X-Client-Secret": SECRET_A.upper()},
}


@pytest.mark.parametrize("route", sorted(CLIENT_SCOPED_ROUTES))
@pytest.mark.parametrize("label", sorted(CLIENT_NEGATIVES))
def test_client_scoped_routes_reject_every_bad_client_secret(credentials, route, label):
    response = api_handler.lambda_handler(_client_event(route, CLIENT_NEGATIVES[label]), None)

    assert response["statusCode"] == 403, (route, label, response["body"])
    assert credentials.calls == [], f"{route} touched a data plane before the secret was verified: {credentials.calls}"


@pytest.mark.parametrize("route", sorted(CLIENT_SCOPED_ROUTES))
def test_an_unregistered_client_is_refused_the_same_as_a_wrong_secret(credentials, route):
    unregistered = "00000000-0000-4000-8000-0000000000ff"
    ev = event(route, path={"clientId": unregistered}, query={"clientId": unregistered}, body=_BODIES.get(route, {}),
               headers={"X-Client-Secret": SECRET_A})

    response = api_handler.lambda_handler(ev, None)

    assert response["statusCode"] == 403
    assert credentials.calls == []


ADMIN_NEGATIVES = {
    "missing header": None,
    "empty key": {"X-Admin-Key": ""},
    "wrong key": {"X-Admin-Key": "wrong"},
    "non-ASCII key": {"X-Admin-Key": "鍵-ünï"},
    "key with different case": {"X-Admin-Key": ADMIN_KEY.upper()},
    "key with trailing whitespace": {"X-Admin-Key": ADMIN_KEY + " "},
}


@pytest.mark.parametrize("route", sorted(ADMIN_ROUTES))
@pytest.mark.parametrize("label", sorted(ADMIN_NEGATIVES))
def test_admin_routes_reject_every_bad_admin_key(credentials, route, label):
    response = api_handler.lambda_handler(_admin_event(route, ADMIN_NEGATIVES[label]), None)

    assert response["statusCode"] == 403, (route, label, response["body"])
    assert credentials.calls == []


@pytest.mark.parametrize("route", sorted(ADMIN_ROUTES))
def test_admin_routes_fail_closed_when_the_admin_key_is_not_configured(monkeypatch, route):
    recorder = forbid_data_plane(monkeypatch)

    def _unreadable():
        raise config.MissingAdminApiKeyError("not configured")

    monkeypatch.setattr(config, "get_admin_api_key", _unreadable)

    response = api_handler.lambda_handler(_admin_event(route, {"X-Admin-Key": ADMIN_KEY}), None)

    assert response["statusCode"] == 503
    assert recorder.calls == []


def test_header_names_are_case_insensitive_but_values_are_not(credentials):
    lowered = api_handler.lambda_handler(_admin_event("GET /admin/heartbeat-stats", {"x-admin-key": ADMIN_KEY}), None)

    # Correct key under a lower-cased header name passes auth and then reaches the (forbidden) data plane -> 500 from the
    # spy, not 403: proof the negatives above are rejected by the key check, not by something unrelated.
    assert lowered["statusCode"] == 500
    assert credentials.calls, "the correct admin key must get past authentication"


def test_a_correct_client_secret_gets_past_authentication(credentials):
    response = api_handler.lambda_handler(_client_event("GET /remote-config", {"X-Client-Secret": SECRET_A}), None)

    assert response["statusCode"] == 500  # reached the forbidden data plane, i.e. authentication passed
    assert credentials.calls
