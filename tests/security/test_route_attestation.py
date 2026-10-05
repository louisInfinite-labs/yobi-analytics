"""SEC-TEST-001 (launch scope, parts 2 and 4) + SEC-API-BOT-001: App Check negatives on EVERY attested route and a no-bypass proof
(roadmap MT-27).

Driven by the MT-01 classification: every route in ATTESTED_ROUTES gets the missing/invalid/expired negatives with spy
proof of zero data-plane calls, and the bypass attempts (header tricks, other credential headers, a valid admin or client
credential) never substitute for a valid App Check token. A route added to Terraform without a classification fails the
inventory meta-test (test_route_inventory.py), so it cannot escape this suite.
"""

from __future__ import annotations

import json

import pytest

from api import api_handler
from api.attestation import AttestationConfig, JwksCache

from .attestation_support import APP_ID, PROJECT_NUMBER, SigningKey, jwks_document, make_token
from .route_inventory import ATTESTED_ROUTES, RETIRED, ROUTE_CLASSES, routes_in_class
from .spies import event, forbid_data_plane

pytestmark = pytest.mark.security

CLIENT = "00000000-0000-4000-8000-000000000001"
PATHS = {
    "clientId": CLIENT,
    "creatorId": "aizawa_ema",
    "videoId": "vid00000001",
    "organization": "hololive",
    "topic": "valorant",
}


@pytest.fixture(scope="module")
def key():
    return SigningKey("kid-routes")


@pytest.fixture(autouse=True)
def enforce(monkeypatch, key):
    config = AttestationConfig(mode="enforce", project_number=PROJECT_NUMBER, app_id=APP_ID)
    cache = JwksCache(lambda: jwks_document(key), config, log=lambda m: None)
    api_handler._set_attestation_for_tests((config, cache))
    yield
    api_handler._set_attestation_for_tests(None)


def _event(route: str, headers: dict | None):
    method, template = route.split(" ", 1)
    path = {name: PATHS[name] for name in PATHS if "{" + name + "}" in template}
    query = {"clientId": CLIENT, "metric": "total"}
    body = {} if method in {"POST", "PUT"} else None
    return event(route, path=path or None, query=query, body=body, headers=headers)


def _run(monkeypatch, route: str, headers: dict | None):
    recorder = forbid_data_plane(monkeypatch)
    return api_handler.lambda_handler(_event(route, headers), None), recorder


# --- every attested route: missing / invalid / expired --------------------------------------------------------------------------------


@pytest.mark.parametrize("route", sorted(ATTESTED_ROUTES))
def test_a_missing_token_is_rejected_with_zero_data_plane_calls(monkeypatch, route):
    response, recorder = _run(monkeypatch, route, None)

    assert response["statusCode"] == 403 and json.loads(response["body"])["code"] == "APP_ATTESTATION_REQUIRED"
    assert recorder.calls == []


@pytest.mark.parametrize("route", sorted(ATTESTED_ROUTES))
def test_an_invalid_token_is_rejected_with_zero_data_plane_calls(monkeypatch, route, key):
    forged = make_token(SigningKey(key.kid))  # right kid, wrong key material

    response, recorder = _run(monkeypatch, route, {"X-Firebase-AppCheck": forged})

    assert response["statusCode"] == 403 and json.loads(response["body"])["code"] == "ATTESTATION_INVALID"
    assert recorder.calls == []


@pytest.mark.parametrize("route", sorted(ATTESTED_ROUTES))
def test_an_expired_token_is_rejected_with_zero_data_plane_calls(monkeypatch, route, key):
    response, recorder = _run(monkeypatch, route, {"X-Firebase-AppCheck": make_token(key, now=1_000, ttl=60)})

    assert response["statusCode"] == 403 and json.loads(response["body"])["code"] == "ATTESTATION_EXPIRED"
    assert recorder.calls == []


@pytest.mark.parametrize("route", sorted(ATTESTED_ROUTES))
def test_a_valid_token_gets_past_attestation_to_the_route_itself(monkeypatch, route, key):
    # The data plane is forbidden, so a request that gets past attestation fails inside the route (500 from the spy) or at
    # the route's own credential check (403 for client/admin routes): either way it is no longer an App Check rejection.
    response, _ = _run(monkeypatch, route, {"X-Firebase-AppCheck": make_token(key)})

    body = json.loads(response["body"])
    assert body.get("code") not in {"APP_ATTESTATION_REQUIRED", "ATTESTATION_INVALID", "ATTESTATION_EXPIRED"}


# --- retired routes are the only exemption ---------------------------------------------------------------------------------------------


@pytest.mark.parametrize("route", sorted(routes_in_class(RETIRED)))
def test_retired_routes_answer_410_without_a_token(monkeypatch, route):
    response, recorder = _run(monkeypatch, route, None)

    assert response["statusCode"] == 410
    assert recorder.calls == []


def test_the_attested_set_is_every_classified_route_except_the_retired_ones():
    assert ATTESTED_ROUTES == {r for r, c in ROUTE_CLASSES.items() if c != RETIRED}


# --- no-bypass proof ---------------------------------------------------------------------------------------------------------------------


def _bypass_attempts(key):
    valid = make_token(key)
    return {
        "token in the Authorization header": {"Authorization": f"Bearer {valid}"},
        "token in a look-alike header": {"X-Firebase-AppCheck-Token": valid},
        "token in a query-style header": {"X-Appcheck": valid},
        "token with a Bearer prefix": {"X-Firebase-AppCheck": f"Bearer {valid}"},
        "two tokens comma-joined": {"X-Firebase-AppCheck": f"{valid}, {valid}"},
        "empty token": {"X-Firebase-AppCheck": ""},
        "whitespace token": {"X-Firebase-AppCheck": "   "},
        "token with a trailing newline": {"X-Firebase-AppCheck": valid + "\n"},
        "valid admin key but no token": {"X-Admin-Key": "anything"},
        "valid-looking client secret but no token": {"X-Client-Secret": "anything"},
        "the debug-token style value": {"X-Firebase-AppCheck": "debug-token-0000"},
        "origin and referer of the production site": {"Origin": "https://example.web.app", "Referer": "https://example.web.app/"},
        "a browser-like user agent": {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130"},
    }


@pytest.mark.parametrize("route", ["GET /live-streams", "GET /creators/{creatorId}/videos/recent", "POST /heartbeat", "POST /remote-config", "PUT /clients/{clientId}/push-subscription"])
def test_no_header_trick_or_other_credential_substitutes_for_a_valid_token(monkeypatch, key, route):
    for label, headers in _bypass_attempts(key).items():
        response, recorder = _run(monkeypatch, route, headers)

        assert response["statusCode"] == 403, f"{route}: {label} must not bypass attestation"
        assert json.loads(response["body"])["code"] in {"APP_ATTESTATION_REQUIRED", "ATTESTATION_INVALID"}, label
        assert recorder.calls == [], label


def test_header_name_case_does_not_matter_but_the_value_must_be_a_valid_token(monkeypatch, key):
    for name in ("x-firebase-appcheck", "X-FIREBASE-APPCHECK", "X-Firebase-AppCheck"):
        response, _ = _run(monkeypatch, "GET /live-streams", {name: make_token(key)})
        assert json.loads(response["body"]).get("code") != "APP_ATTESTATION_REQUIRED", name


def test_attestation_does_not_replace_the_route_credential(monkeypatch, key):
    response, recorder = _run(monkeypatch, "POST /remote-config", {"X-Firebase-AppCheck": make_token(key)})

    assert response["statusCode"] in {403, 503}, "a valid App Check token alone never authorizes an admin route"
    assert json.loads(response["body"]).get("code") != "ATTESTATION_INVALID", "it passed attestation and failed the admin credential"
    assert recorder.calls == [], "no admin write happened"


def test_the_inventory_meta_test_is_what_prevents_an_unclassified_route(monkeypatch):
    from api import api_handler as handler

    unclassified = (set(handler._ROUTES) | set(handler._RETIRED_ROUTES)) - set(ROUTE_CLASSES)

    assert unclassified == set(), "a route without a classification would escape this suite"
