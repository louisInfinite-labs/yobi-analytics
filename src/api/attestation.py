"""Firebase App Check token verification (SEC-API-BOT-002, roadmap MT-25).

Pure verification: given the value of the `X-Firebase-AppCheck` header, decide whether it is a valid App Check token for
THIS project and web app. No request is made on the hot path: signing keys come from a JWKS cache that is refreshed on a
bounded interval, with a bounded grace period if a refresh fails, and a cold cache with unreachable keys FAILS CLOSED.

Verification follows Firebase's documented custom-backend procedure and is stricter where it can be:
  - header: algorithm RS256 only, type JWT, a `kid` that names a cached signing key (algorithm "none"/HS* are rejected);
  - signature: RSASSA-PKCS1-v1_5 / SHA-256 against that key;
  - issuer `https://firebaseappcheck.googleapis.com/<PROJECT_NUMBER>`; audience contains `projects/<PROJECT_NUMBER>`;
  - subject equals the pinned production web-app id (so a token from any other project/app, including a development
    project, is invalid); `exp` has not passed (a small clock skew is allowed).

This only proves the request carried valid app attestation. It does NOT prove a human is operating the browser.
Pins, intervals and the grace period are configuration, not code constants. The verifier uses `cryptography`, which is
already a runtime dependency (pywebpush); no new dependency is added.
"""

from __future__ import annotations

import base64
import json
import os
import re
import time
from dataclasses import dataclass
from typing import Any, Callable, Mapping

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

MODE_OFF, MODE_MONITOR, MODE_ENFORCE = "off", "monitor", "enforce"
MODES = (MODE_OFF, MODE_MONITOR, MODE_ENFORCE)

DEFAULT_JWKS_URL = "https://firebaseappcheck.googleapis.com/v1/jwks"
ISSUER_PREFIX = "https://firebaseappcheck.googleapis.com/"
# Firebase documents that the signing keys rotate and may be cached for up to 6 hours: the ceiling for a refresh interval.
MAX_REFRESH_INTERVAL_SECONDS = 6 * 3600
_MAX_GRACE_SECONDS = 24 * 3600
_B64URL = re.compile(r"[A-Za-z0-9_-]+")


class AttestationError(Exception):
    """Base class; `code` is the stable response code (baseline section 13.1)."""

    code = "ATTESTATION_INVALID"


class AttestationMissing(AttestationError):
    code = "APP_ATTESTATION_REQUIRED"


class AttestationInvalid(AttestationError):
    code = "ATTESTATION_INVALID"


class AttestationExpired(AttestationError):
    code = "ATTESTATION_EXPIRED"


class AttestationUnavailable(AttestationError):
    """Signing keys cannot be obtained and no trustworthy cached keys exist. Fail closed: this is a 503, never a pass."""

    code = "ATTESTATION_UNAVAILABLE"


class AttestationConfigError(ValueError):
    """The attestation configuration is unusable (a production deploy must treat this as fail-closed)."""


@dataclass(frozen=True)
class AttestationConfig:
    mode: str = MODE_OFF
    project_number: str = ""  # the numeric Firebase project number (issuer/audience), never the project id
    app_id: str = ""  # the pinned production web-app id (the token subject)
    jwks_url: str = DEFAULT_JWKS_URL
    refresh_interval_seconds: float = 3 * 3600  # must not exceed the 6 h documented caching ceiling
    grace_seconds: float = 3600  # how long still-trusted cached keys may be used after a failed refresh
    min_forced_refresh_seconds: float = 60  # an unknown `kid` may force a refresh, at most this often
    clock_skew_seconds: float = 60
    max_token_length: int = 4096
    fetch_timeout_seconds: float = 3.0

    def __post_init__(self) -> None:
        if self.mode not in MODES:
            raise AttestationConfigError(f"mode must be one of {MODES}")
        if not 0 < self.refresh_interval_seconds <= MAX_REFRESH_INTERVAL_SECONDS:
            raise AttestationConfigError("refresh_interval_seconds must be positive and at most the 6 hour caching ceiling")
        if not 0 <= self.grace_seconds <= _MAX_GRACE_SECONDS:
            raise AttestationConfigError("grace_seconds must be a finite, bounded value")
        if self.mode != MODE_OFF and not (self.project_number.isdigit() and self.app_id):
            raise AttestationConfigError("monitor/enforce modes need a numeric project number and a web app id")

    @classmethod
    def from_environment(cls, environ: Mapping[str, str] | None = None) -> "AttestationConfig":
        """Read YOBI_ATTESTATION_MODE / APPCHECK_* settings. Unset mode means `off`; invalid settings raise."""
        env = os.environ if environ is None else environ

        def text(name: str, default: str = "") -> str:
            return (env.get(name) or "").strip() or default

        def number(name: str, default: float) -> float:
            raw = text(name)
            try:
                return float(raw) if raw else default
            except ValueError as exc:
                raise AttestationConfigError(f"{name} must be a number") from exc

        defaults = cls()
        return cls(
            mode=text("YOBI_ATTESTATION_MODE", MODE_OFF).lower(),
            project_number=text("APPCHECK_PROJECT_NUMBER"),
            app_id=text("APPCHECK_APP_ID"),
            jwks_url=text("APPCHECK_JWKS_URL", defaults.jwks_url),
            refresh_interval_seconds=number("APPCHECK_JWKS_REFRESH_SECONDS", defaults.refresh_interval_seconds),
            grace_seconds=number("APPCHECK_JWKS_GRACE_SECONDS", defaults.grace_seconds),
            clock_skew_seconds=number("APPCHECK_CLOCK_SKEW_SECONDS", defaults.clock_skew_seconds),
        )


# --------------------------------------------------------------------------------------------------------------- JWKS


class JwksCache:
    """Signing keys by `kid`, refreshed on a bounded interval, with a bounded grace period and fail-closed behaviour."""

    def __init__(
        self,
        fetch: Callable[[], Mapping[str, Any]],
        config: AttestationConfig,
        clock: Callable[[], float] = time.time,
        log: Callable[[str], None] = print,
    ) -> None:
        self._fetch = fetch
        self._config = config
        self._clock = clock
        self._log = log
        self._keys: dict[str, rsa.RSAPublicKey] = {}
        self._fetched_at: float | None = None
        self._last_forced: float | None = None

    def key_for(self, kid: str) -> rsa.RSAPublicKey | None:
        """The key for `kid`, or None if no such key exists. Raises AttestationUnavailable (fail closed) if keys can't be had."""
        self._ensure_fresh()
        key = self._keys.get(kid)
        if key is not None:
            return key
        # An unknown kid may mean the keys rotated: allow ONE refresh, rate-limited so random kids cannot amplify upstream calls.
        now = self._clock()
        if self._last_forced is None or now - self._last_forced >= self._config.min_forced_refresh_seconds:
            self._last_forced = now
            self._refresh(forced=True)
            return self._keys.get(kid)
        return None

    def _ensure_fresh(self) -> None:
        if self._fetched_at is not None and self._clock() - self._fetched_at < self._config.refresh_interval_seconds:
            return
        self._refresh(forced=False)

    def _refresh(self, *, forced: bool) -> None:
        now = self._clock()
        try:
            keys = _parse_jwks(self._fetch())
        except Exception as exc:  # noqa: BLE001 - any failure to obtain keys is handled by the grace/fail-closed rule below
            age = None if self._fetched_at is None else now - self._fetched_at
            if self._keys and age is not None and age <= self._config.refresh_interval_seconds + self._config.grace_seconds:
                self._log(f"attestation: JWKS refresh failed ({type(exc).__name__}); using cached keys inside the grace period")
                return
            raise AttestationUnavailable("App Check signing keys are unavailable") from exc
        self._keys = keys
        self._fetched_at = now


def _parse_jwks(document: Mapping[str, Any]) -> dict[str, rsa.RSAPublicKey]:
    keys: dict[str, rsa.RSAPublicKey] = {}
    for jwk in document.get("keys", []):
        if not isinstance(jwk, dict) or jwk.get("kty") != "RSA" or not isinstance(jwk.get("kid"), str):
            continue
        try:
            n = int.from_bytes(_b64url_decode(jwk["n"]), "big")
            e = int.from_bytes(_b64url_decode(jwk["e"]), "big")
            keys[jwk["kid"]] = rsa.RSAPublicNumbers(e, n).public_key()
        except (KeyError, ValueError, TypeError):
            continue
    if not keys:
        raise ValueError("JWKS contained no usable RSA keys")
    return keys


def fetch_jwks_over_http(config: AttestationConfig) -> Mapping[str, Any]:
    """Fetch the signing keys (bounded timeout). Only ever called by the JwksCache, never per request."""
    import requests

    response = requests.get(config.jwks_url, timeout=config.fetch_timeout_seconds)
    response.raise_for_status()
    return response.json()


# --------------------------------------------------------------------------------------------------------- verification


def _b64url_decode(value: str) -> bytes:
    if not isinstance(value, str) or not _B64URL.fullmatch(value):
        raise ValueError("not base64url")
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def verify_token(token: str | None, config: AttestationConfig, keys: JwksCache, *, now: float | None = None) -> dict[str, Any]:
    """Return the verified claims, or raise an AttestationError whose `code` is the stable response code."""
    if token is None or not isinstance(token, str) or not token.strip():
        raise AttestationMissing("no App Check token presented")
    if len(token) > config.max_token_length:
        raise AttestationInvalid("token too large")
    parts = token.split(".")
    if len(parts) != 3 or not all(parts):
        raise AttestationInvalid("malformed token")
    try:
        header = json.loads(_b64url_decode(parts[0]))
        payload = json.loads(_b64url_decode(parts[1]))
        signature = _b64url_decode(parts[2])
    except (ValueError, TypeError):
        raise AttestationInvalid("malformed token") from None
    if not isinstance(header, dict) or not isinstance(payload, dict):
        raise AttestationInvalid("malformed token")

    if header.get("alg") != "RS256" or header.get("typ") != "JWT":
        raise AttestationInvalid("unsupported token type or algorithm")
    kid = header.get("kid")
    if not isinstance(kid, str) or not kid:
        raise AttestationInvalid("token names no signing key")

    key = keys.key_for(kid)  # may raise AttestationUnavailable (fail closed)
    if key is None:
        raise AttestationInvalid("unknown signing key")
    try:
        key.verify(signature, f"{parts[0]}.{parts[1]}".encode("ascii"), padding.PKCS1v15(), hashes.SHA256())
    except InvalidSignature:
        raise AttestationInvalid("bad signature") from None

    _check_claims(payload, config)
    now = time.time() if now is None else now
    exp = payload.get("exp")
    if isinstance(exp, bool) or not isinstance(exp, (int, float)):
        raise AttestationInvalid("token has no expiry")
    if now > exp + config.clock_skew_seconds:
        raise AttestationExpired("token expired")
    return payload


def _check_claims(payload: Mapping[str, Any], config: AttestationConfig) -> None:
    if payload.get("iss") != f"{ISSUER_PREFIX}{config.project_number}":
        raise AttestationInvalid("wrong issuer")
    audience = payload.get("aud")
    audiences = audience if isinstance(audience, list) else [audience]
    if f"projects/{config.project_number}" not in [a for a in audiences if isinstance(a, str)]:
        raise AttestationInvalid("wrong audience")
    if payload.get("sub") != config.app_id:
        raise AttestationInvalid("wrong app")
