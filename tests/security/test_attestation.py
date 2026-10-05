"""SEC-API-BOT-002 (P0): App Check verification, key cache and fail-closed behaviour (roadmap MT-25).

Uses a test signing key and a fake JWKS: valid, expired, wrong audience/issuer/subject, `alg: none`, wrong algorithm and
type, unknown kid, rotation, refresh failure inside the grace period, cold-cache outage (fail closed) and grace expiry.
"""

from __future__ import annotations

import base64
import importlib.metadata as metadata
import json

import pytest

from api.attestation import (
    MAX_REFRESH_INTERVAL_SECONDS,
    AttestationConfig,
    AttestationConfigError,
    AttestationExpired,
    AttestationInvalid,
    AttestationMissing,
    AttestationUnavailable,
    JwksCache,
    verify_token,
)

from .attestation_support import APP_ID, ISSUER, PROJECT_NUMBER, SigningKey, b64url, jwks_document, make_token

pytestmark = pytest.mark.security

NOW = 1_800_000_000.0


@pytest.fixture(scope="module")
def key_a():
    return SigningKey("kid-a")


@pytest.fixture(scope="module")
def key_b():
    return SigningKey("kid-b")


class Clock:
    def __init__(self, now: float = NOW) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


class Jwks:
    """A fake JWKS endpoint: set `document` or `error` to script it; counts fetches."""

    def __init__(self, *keys: SigningKey) -> None:
        self.document = jwks_document(*keys)
        self.error: Exception | None = None
        self.fetches = 0

    def __call__(self):
        self.fetches += 1
        if self.error is not None:
            raise self.error
        return self.document


def config(**overrides) -> AttestationConfig:
    values = {"mode": "enforce", "project_number": PROJECT_NUMBER, "app_id": APP_ID}
    values.update(overrides)
    return AttestationConfig(**values)


def setup(*keys: SigningKey, **cfg):
    clock, jwks = Clock(), Jwks(*keys)
    conf = config(**cfg)
    cache = JwksCache(jwks, conf, clock=clock, log=lambda message: None)
    return conf, cache, jwks, clock


def verify(token, conf, cache, clock):
    return verify_token(token, conf, cache, now=clock.now)


# --- valid ---------------------------------------------------------------------------------------------------------------


def test_a_valid_token_is_accepted_and_its_claims_returned(key_a):
    conf, cache, _, clock = setup(key_a)

    claims = verify(make_token(key_a, now=NOW), conf, cache, clock)

    assert claims["sub"] == APP_ID and claims["iss"] == ISSUER


def test_no_per_request_network_call_after_the_first_the_cache_serves_the_rest(key_a):
    conf, cache, jwks, clock = setup(key_a)

    for _ in range(50):
        verify(make_token(key_a, now=NOW), conf, cache, clock)

    assert jwks.fetches == 1


# --- missing / malformed ---------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("token", [None, "", "   "])
def test_a_missing_token_is_reported_as_missing(key_a, token):
    conf, cache, _, clock = setup(key_a)

    with pytest.raises(AttestationMissing) as raised:
        verify(token, conf, cache, clock)

    assert raised.value.code == "APP_ATTESTATION_REQUIRED"


@pytest.mark.parametrize(
    "token",
    ["abc", "a.b", "a.b.c.d", "..", "a..c", "!!!.@@@.###", "e30.e30.", "x" * 5000],
)
def test_malformed_tokens_are_invalid_not_errors(key_a, token):
    conf, cache, _, clock = setup(key_a)

    with pytest.raises(AttestationInvalid) as raised:
        verify(token, conf, cache, clock)

    assert raised.value.code == "ATTESTATION_INVALID"


def test_a_non_object_payload_or_header_is_invalid(key_a):
    conf, cache, _, clock = setup(key_a)
    arrays = f"{b64url(b'[1]')}.{b64url(b'[2]')}.{b64url(b'sig')}"

    with pytest.raises(AttestationInvalid):
        verify(arrays, conf, cache, clock)


# --- algorithm / type / key confusion -----------------------------------------------------------------------------------------


@pytest.mark.parametrize("alg", ["none", "None", "HS256", "RS384", "ES256", "", None])
def test_only_rs256_is_accepted_including_alg_none(key_a, alg):
    conf, cache, _, clock = setup(key_a)

    with pytest.raises(AttestationInvalid):
        verify(make_token(key_a, now=NOW, header={"alg": alg}), conf, cache, clock)


def test_alg_none_with_an_empty_signature_is_rejected(key_a):
    conf, cache, _, clock = setup(key_a)
    unsigned = make_token(key_a, now=NOW, header={"alg": "none"}, signature=b"")

    with pytest.raises(AttestationInvalid):
        verify(unsigned.rsplit(".", 1)[0] + ".", conf, cache, clock)


@pytest.mark.parametrize("typ", ["JWE", "at+jwt", "", None])
def test_the_token_type_must_be_jwt(key_a, typ):
    conf, cache, _, clock = setup(key_a)

    with pytest.raises(AttestationInvalid):
        verify(make_token(key_a, now=NOW, header={"typ": typ}), conf, cache, clock)


def test_an_hs256_token_signed_with_the_public_modulus_is_rejected(key_a):
    import hashlib
    import hmac

    conf, cache, _, clock = setup(key_a)
    head = b64url(json.dumps({"alg": "HS256", "typ": "JWT", "kid": key_a.kid}).encode())
    body = b64url(json.dumps({"iss": ISSUER, "aud": [f"projects/{PROJECT_NUMBER}"], "sub": APP_ID, "exp": int(NOW) + 600}).encode())
    mac = hmac.new(json.dumps(key_a.jwk()).encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()

    with pytest.raises(AttestationInvalid):
        verify(f"{head}.{body}.{b64url(mac)}", conf, cache, clock)


@pytest.mark.parametrize("kid", [None, "", 5])
def test_a_token_that_names_no_signing_key_is_invalid(key_a, kid):
    conf, cache, _, clock = setup(key_a)

    with pytest.raises(AttestationInvalid):
        verify(make_token(key_a, now=NOW, header={"kid": kid}), conf, cache, clock)


# --- signature ------------------------------------------------------------------------------------------------------------------


def test_a_tampered_payload_fails_the_signature(key_a):
    conf, cache, _, clock = setup(key_a)
    head, body, sig = make_token(key_a, now=NOW).split(".")
    forged = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    forged["sub"] = "attacker"
    forged_body = b64url(json.dumps(forged).encode())

    with pytest.raises(AttestationInvalid):
        verify(f"{head}.{forged_body}.{sig}", conf, cache, clock)


def test_a_token_signed_by_a_different_key_with_the_right_kid_is_invalid(key_a):
    impostor = SigningKey("kid-a")  # same kid, different key material
    conf, cache, _, clock = setup(key_a)

    with pytest.raises(AttestationInvalid):
        verify(make_token(impostor, now=NOW), conf, cache, clock)


def test_a_truncated_signature_is_invalid(key_a):
    conf, cache, _, clock = setup(key_a)
    token = make_token(key_a, now=NOW)

    with pytest.raises(AttestationInvalid):
        verify(token[:-12], conf, cache, clock)


# --- claims: issuer / audience / subject / expiry -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    "claims",
    [
        {"iss": "https://firebaseappcheck.googleapis.com/999999999999"},
        {"iss": "https://evil.example/123456789012"},
        {"iss": None},
        {"aud": ["projects/999999999999"]},
        {"aud": "projects/999999999999"},
        {"aud": []},
        {"aud": None},
        {"sub": "1:999999999999:web:other"},
        {"sub": None},
    ],
)
def test_a_token_for_another_project_or_app_is_invalid(key_a, claims):
    conf, cache, _, clock = setup(key_a)

    with pytest.raises(AttestationInvalid):
        verify(make_token(key_a, now=NOW, claims=claims), conf, cache, clock)


@pytest.mark.parametrize("claim", ["iss", "aud", "sub", "exp"])
def test_a_token_missing_a_required_claim_is_invalid(key_a, claim):
    conf, cache, _, clock = setup(key_a)

    with pytest.raises(AttestationInvalid):
        verify(make_token(key_a, now=NOW, drop_claims=(claim,)), conf, cache, clock)


def test_a_single_string_audience_that_names_the_project_is_accepted(key_a):
    conf, cache, _, clock = setup(key_a)

    claims = verify(make_token(key_a, now=NOW, claims={"aud": f"projects/{PROJECT_NUMBER}"}), conf, cache, clock)

    assert claims["aud"] == f"projects/{PROJECT_NUMBER}"


def test_an_expired_token_is_reported_as_expired_only_when_everything_else_is_valid(key_a):
    conf, cache, _, clock = setup(key_a)
    token = make_token(key_a, now=NOW - 7200, ttl=3600)  # expired an hour ago

    with pytest.raises(AttestationExpired) as raised:
        verify(token, conf, cache, clock)

    assert raised.value.code == "ATTESTATION_EXPIRED"


def test_an_expired_token_for_another_project_is_invalid_not_expired(key_a):
    conf, cache, _, clock = setup(key_a)
    token = make_token(key_a, now=NOW - 7200, ttl=3600, claims={"sub": "someone-else"})

    with pytest.raises(AttestationInvalid):
        verify(token, conf, cache, clock)


def test_a_small_clock_skew_is_tolerated_but_not_a_large_one(key_a):
    conf, cache, _, clock = setup(key_a, clock_skew_seconds=60)

    verify(make_token(key_a, now=NOW - 3600 - 30, ttl=3600), conf, cache, clock)  # 30 s past expiry
    with pytest.raises(AttestationExpired):
        verify(make_token(key_a, now=NOW - 3600 - 61, ttl=3600), conf, cache, clock)


# --- key cache: rotation, unknown kid, grace, fail closed -------------------------------------------------------------------------


def test_an_unknown_kid_is_invalid_and_forces_at_most_one_rate_limited_refresh(key_a, key_b):
    conf, cache, jwks, clock = setup(key_a)
    verify(make_token(key_a, now=NOW), conf, cache, clock)
    fetches_before = jwks.fetches

    for _ in range(25):  # an attacker spraying random kids must not trigger an upstream fetch each time
        with pytest.raises(AttestationInvalid):
            verify(make_token(key_b, now=NOW), conf, cache, clock)

    assert jwks.fetches - fetches_before <= 1


def test_key_rotation_is_picked_up_without_an_outage(key_a, key_b):
    conf, cache, jwks, clock = setup(key_a)
    verify(make_token(key_a, now=NOW), conf, cache, clock)
    jwks.document = jwks_document(key_a, key_b)  # Google publishes a new key
    clock.now += 120  # past the minimum forced-refresh spacing

    claims = verify(make_token(key_b, now=clock.now), conf, cache, clock)

    assert claims["sub"] == APP_ID


def test_a_refresh_failure_inside_the_grace_period_keeps_using_the_cached_keys(key_a):
    conf, cache, jwks, clock = setup(key_a, refresh_interval_seconds=3600, grace_seconds=1800)
    verify(make_token(key_a, now=NOW), conf, cache, clock)
    jwks.error = OSError("network down")
    clock.now += 3600 + 600  # refresh due, 10 minutes into the grace period

    claims = verify(make_token(key_a, now=clock.now), conf, cache, clock)

    assert claims["sub"] == APP_ID


def test_after_the_grace_period_a_failed_refresh_fails_closed(key_a):
    conf, cache, jwks, clock = setup(key_a, refresh_interval_seconds=3600, grace_seconds=1800)
    verify(make_token(key_a, now=NOW), conf, cache, clock)
    jwks.error = OSError("network down")
    clock.now += 3600 + 1801  # beyond refresh interval + grace

    with pytest.raises(AttestationUnavailable) as raised:
        verify(make_token(key_a, now=clock.now), conf, cache, clock)

    assert raised.value.code == "ATTESTATION_UNAVAILABLE"


def test_a_cold_cache_with_unreachable_keys_fails_closed_never_open(key_a):
    conf, cache, jwks, clock = setup(key_a)
    jwks.error = OSError("network down")

    with pytest.raises(AttestationUnavailable):
        verify(make_token(key_a, now=NOW), conf, cache, clock)


def test_a_jwks_with_no_usable_keys_is_treated_as_unavailable(key_a):
    conf, cache, jwks, clock = setup(key_a)
    jwks.document = {"keys": [{"kty": "EC", "kid": "x"}, "garbage"]}

    with pytest.raises(AttestationUnavailable):
        verify(make_token(key_a, now=NOW), conf, cache, clock)


def test_the_cache_refreshes_after_the_interval(key_a):
    conf, cache, jwks, clock = setup(key_a, refresh_interval_seconds=3600)
    verify(make_token(key_a, now=NOW), conf, cache, clock)
    clock.now += 3601

    verify(make_token(key_a, now=clock.now), conf, cache, clock)

    assert jwks.fetches == 2


# --- configuration (pins and parameters come from configuration, not code constants) --------------------------------------------


def test_the_configuration_reads_pins_and_parameters_from_the_environment():
    env = {
        "YOBI_ATTESTATION_MODE": "Monitor",
        "APPCHECK_PROJECT_NUMBER": "123456789012",
        "APPCHECK_APP_ID": APP_ID,
        "APPCHECK_JWKS_GRACE_SECONDS": "900",
    }

    conf = AttestationConfig.from_environment(env)

    assert (conf.mode, conf.project_number, conf.app_id, conf.grace_seconds) == ("monitor", "123456789012", APP_ID, 900.0)


def test_an_unset_mode_is_off_and_needs_no_pins():
    conf = AttestationConfig.from_environment({})

    assert conf.mode == "off" and conf.project_number == ""


@pytest.mark.parametrize(
    "env",
    [
        {"YOBI_ATTESTATION_MODE": "enforce"},
        {"YOBI_ATTESTATION_MODE": "enforce", "APPCHECK_PROJECT_NUMBER": "my-project-id", "APPCHECK_APP_ID": APP_ID},
        {"YOBI_ATTESTATION_MODE": "bogus"},
        {"YOBI_ATTESTATION_MODE": "enforce", "APPCHECK_PROJECT_NUMBER": "123", "APPCHECK_APP_ID": "a", "APPCHECK_JWKS_REFRESH_SECONDS": str(MAX_REFRESH_INTERVAL_SECONDS + 1)},
        {"YOBI_ATTESTATION_MODE": "enforce", "APPCHECK_PROJECT_NUMBER": "123", "APPCHECK_APP_ID": "a", "APPCHECK_JWKS_GRACE_SECONDS": "-1"},
        {"YOBI_ATTESTATION_MODE": "enforce", "APPCHECK_PROJECT_NUMBER": "123", "APPCHECK_APP_ID": "a", "APPCHECK_JWKS_GRACE_SECONDS": "abc"},
    ],
)
def test_an_unusable_configuration_raises_instead_of_silently_verifying_against_nothing(env):
    with pytest.raises(AttestationConfigError):
        AttestationConfig.from_environment(env)


def test_no_pin_or_grace_constant_is_hard_coded_in_the_verifier():
    from pathlib import Path

    source = (Path(__file__).resolve().parents[2] / "src" / "api" / "attestation.py").read_text(encoding="utf-8")

    assert PROJECT_NUMBER not in source and APP_ID not in source
    assert "grace_seconds: float = 3600" in source  # a default, overridable by APPCHECK_JWKS_GRACE_SECONDS


def test_cryptography_is_an_existing_runtime_dependency_so_no_new_dependency_is_added():
    requirements = [r.lower() for r in (metadata.requires("pywebpush") or [])]

    assert any(r.startswith("cryptography") for r in requirements)
