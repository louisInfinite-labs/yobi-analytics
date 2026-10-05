"""SEC-API-BOT-001/002 (P0): the dispatch integration, modes and response semantics (roadmap MT-26).

`off` skips verification (local only); `monitor` verifies and logs but never rejects; `enforce` rejects with the stable
codes of baseline section 13.1: 403 for missing/invalid/expired, 503 when verification infrastructure is unavailable.
A rejected request does zero data-plane work, and security events never contain the token.
"""

from __future__ import annotations

import json

import pytest

from api import api_handler
from api.attestation import AttestationConfig, JwksCache

from .attestation_support import APP_ID, PROJECT_NUMBER, SigningKey, jwks_document, make_token
from .spies import event, forbid_data_plane

pytestmark = pytest.mark.security


@pytest.fixture(scope="module")
def key():
    return SigningKey("kid-dispatch")


class Jwks:
    def __init__(self, *keys) -> None:
        self.document = jwks_document(*keys)
        self.error: Exception | None = None

    def __call__(self):
        if self.error is not None:
            raise self.error
        return self.document


def install(monkeypatch, key, mode, jwks=None):
    jwks = jwks or Jwks(key)
    config = AttestationConfig(mode=mode, project_number=PROJECT_NUMBER, app_id=APP_ID)
    cache = JwksCache(jwks, config, log=lambda message: None)
    api_handler._set_attestation_for_tests((config, cache))
    monkeypatch.setitem(api_handler._ROUTES, "GET /topics", lambda ev: {"ok": True})
    return jwks


@pytest.fixture(autouse=True)
def reset_attestation():
    yield
    api_handler._set_attestation_for_tests(None)


def call(token=None, route="GET /topics", headers=None):
    all_headers = dict(headers or {})
    if token is not None:
        all_headers["X-Firebase-AppCheck"] = token
    return api_handler.lambda_handler(event(route, headers=all_headers), None)


def code_of(response):
    return json.loads(response["body"]).get("code")


# --- enforce: response semantics ----------------------------------------------------------------------------------------------


def test_enforce_rejects_a_missing_token_with_403_app_attestation_required(monkeypatch, key):
    install(monkeypatch, key, "enforce")

    response = call()

    assert response["statusCode"] == 403 and code_of(response) == "APP_ATTESTATION_REQUIRED"


def test_enforce_rejects_an_invalid_token_with_403_attestation_invalid(monkeypatch, key):
    install(monkeypatch, key, "enforce")

    response = call(make_token(key, claims={"sub": "other-app"}))

    assert response["statusCode"] == 403 and code_of(response) == "ATTESTATION_INVALID"


def test_enforce_rejects_an_expired_token_with_403_attestation_expired(monkeypatch, key):
    install(monkeypatch, key, "enforce")

    response = call(make_token(key, now=1_000, ttl=60))

    assert response["statusCode"] == 403 and code_of(response) == "ATTESTATION_EXPIRED"


def test_enforce_answers_503_when_verification_is_unavailable_and_never_passes(monkeypatch, key):
    jwks = install(monkeypatch, key, "enforce")
    jwks.error = OSError("signing keys unreachable")

    response = call(make_token(key))

    assert response["statusCode"] == 503 and code_of(response) == "ATTESTATION_UNAVAILABLE"


def test_enforce_lets_a_valid_token_through_to_the_route(monkeypatch, key):
    install(monkeypatch, key, "enforce")

    response = call(make_token(key))

    assert response["statusCode"] == 200 and json.loads(response["body"]) == {"ok": True}


def test_the_error_body_names_only_the_code_not_which_sub_check_failed(monkeypatch, key):
    install(monkeypatch, key, "enforce")

    bad_sub = call(make_token(key, claims={"sub": "x"}))
    bad_iss = call(make_token(key, claims={"iss": "x"}))

    assert bad_sub["body"] == bad_iss["body"], "no oracle: every invalid token yields the identical body"


# --- zero data-plane work on rejection ----------------------------------------------------------------------------------------------


@pytest.mark.parametrize("token_kind", ["missing", "invalid", "expired"])
def test_a_rejected_request_does_no_data_plane_work(monkeypatch, key, token_kind):
    install(monkeypatch, key, "enforce")
    recorder = forbid_data_plane(monkeypatch)
    token = {"missing": None, "invalid": "not.a.jwt", "expired": make_token(key, now=1_000, ttl=60)}[token_kind]

    response = api_handler.lambda_handler(event("GET /creators/{creatorId}/videos/recent", path={"creatorId": "aizawa_ema"}, headers={"x-firebase-appcheck": token} if token else {}), None)

    assert response["statusCode"] == 403
    assert recorder.calls == []


# --- monitor / off ------------------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("token_kind", ["missing", "invalid", "expired"])
def test_monitor_never_rejects_and_logs_the_event_class(monkeypatch, key, capsys, token_kind):
    install(monkeypatch, key, "monitor")
    token = {"missing": None, "invalid": "not.a.jwt", "expired": make_token(key, now=1_000, ttl=60)}[token_kind]

    response = call(token)

    assert response["statusCode"] == 200
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith('{"securityEvent"')]
    expected = {"missing": "attest_missing", "invalid": "attest_invalid", "expired": "attest_expired"}[token_kind]
    assert events == [{"securityEvent": expected, "route": "GET /topics", "mode": "monitor"}]


def test_monitor_also_lets_requests_through_when_verification_is_unavailable(monkeypatch, key, capsys):
    jwks = install(monkeypatch, key, "monitor")
    jwks.error = OSError("down")

    assert call(make_token(key))["statusCode"] == 200
    assert "attest_unavailable" in capsys.readouterr().out


def test_a_valid_token_in_monitor_mode_logs_nothing(monkeypatch, key, capsys):
    install(monkeypatch, key, "monitor")

    call(make_token(key))

    assert "securityEvent" not in capsys.readouterr().out


def test_off_skips_verification_entirely(monkeypatch, key):
    install(monkeypatch, key, "off")

    assert call()["statusCode"] == 200


def test_security_events_never_contain_the_token(monkeypatch, key, capsys):
    install(monkeypatch, key, "enforce")
    token = make_token(key, claims={"sub": "x"})

    call(token)

    out = capsys.readouterr().out
    assert token not in out and token.split(".")[1] not in out


# --- exempt routes ------------------------------------------------------------------------------------------------------------------


def test_retired_routes_answer_410_without_a_token_in_every_mode(monkeypatch, key):
    for mode in ("enforce", "monitor", "off"):
        install(monkeypatch, key, mode)

        response = call(route="GET /leaderboard")

        assert response["statusCode"] == 410 and code_of(response) == "ENDPOINT_RETIRED"


# --- configuration ------------------------------------------------------------------------------------------------------------------


def test_an_unusable_configuration_fails_closed_with_503(monkeypatch):
    monkeypatch.setenv("YOBI_ATTESTATION_MODE", "enforce")  # no pins configured
    monkeypatch.delenv("APPCHECK_PROJECT_NUMBER", raising=False)
    monkeypatch.delenv("APPCHECK_APP_ID", raising=False)
    api_handler._set_attestation_for_tests(None)

    response = api_handler.lambda_handler(event("GET /topics"), None)

    assert response["statusCode"] == 503 and code_of(response) == "ATTESTATION_UNAVAILABLE"


def test_an_unset_mode_is_off_so_a_rollout_that_precedes_its_configuration_is_not_an_outage(monkeypatch):
    for name in ("YOBI_ATTESTATION_MODE", "APPCHECK_PROJECT_NUMBER", "APPCHECK_APP_ID"):
        monkeypatch.delenv(name, raising=False)
    api_handler._set_attestation_for_tests(None)
    monkeypatch.setitem(api_handler._ROUTES, "GET /topics", lambda ev: {"ok": True})

    assert api_handler.lambda_handler(event("GET /topics"), None)["statusCode"] == 200


def test_the_environment_drives_the_modes(monkeypatch, key):
    monkeypatch.setenv("YOBI_ATTESTATION_MODE", "enforce")
    monkeypatch.setenv("APPCHECK_PROJECT_NUMBER", PROJECT_NUMBER)
    monkeypatch.setenv("APPCHECK_APP_ID", APP_ID)
    api_handler._set_attestation_for_tests(None)
    monkeypatch.setitem(api_handler._ROUTES, "GET /topics", lambda ev: {"ok": True})

    assert call()["statusCode"] == 403
