"""Test support for App Check: a signing key, a fake JWKS and a token factory (SEC-API-BOT-002, roadmap MT-25/MT-26/MT-27)."""

from __future__ import annotations

import base64
import json
import time
from typing import Any

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

PROJECT_NUMBER = "123456789012"
APP_ID = "1:123456789012:web:abcdef0123456789"
ISSUER = f"https://firebaseappcheck.googleapis.com/{PROJECT_NUMBER}"


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


class SigningKey:
    """A test RSA key whose public half is published through a fake JWKS."""

    def __init__(self, kid: str) -> None:
        self.kid = kid
        self.private = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    def jwk(self) -> dict[str, str]:
        numbers = self.private.public_key().public_numbers()
        to_b64 = lambda n: b64url(n.to_bytes((n.bit_length() + 7) // 8, "big"))  # noqa: E731
        return {"kty": "RSA", "alg": "RS256", "use": "sig", "kid": self.kid, "n": to_b64(numbers.n), "e": to_b64(numbers.e)}

    def sign(self, signing_input: bytes) -> bytes:
        return self.private.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())


def jwks_document(*keys: SigningKey) -> dict[str, Any]:
    return {"keys": [key.jwk() for key in keys]}


def make_token(
    key: SigningKey,
    *,
    now: float | None = None,
    ttl: float = 3600,
    claims: dict[str, Any] | None = None,
    header: dict[str, Any] | None = None,
    drop_claims: tuple[str, ...] = (),
    signature: bytes | None = None,
) -> str:
    """A compact RS256 App Check-style JWT. `claims`/`header` override fields; `drop_claims` removes some."""
    now = time.time() if now is None else now
    payload: dict[str, Any] = {
        "iss": ISSUER,
        "aud": [f"projects/{PROJECT_NUMBER}", "projects/some-project-id"],
        "sub": APP_ID,
        "iat": int(now),
        "exp": int(now + ttl),
    }
    payload.update(claims or {})
    for name in drop_claims:
        payload.pop(name, None)
    head: dict[str, Any] = {"alg": "RS256", "typ": "JWT", "kid": key.kid}
    head.update(header or {})
    signing_input = f"{b64url(json.dumps(head).encode())}.{b64url(json.dumps(payload).encode())}"
    sig = signature if signature is not None else key.sign(signing_input.encode("ascii"))
    return f"{signing_input}.{b64url(sig)}"
