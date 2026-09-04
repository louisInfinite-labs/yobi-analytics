"""Pure logic for the client-secret hardening on top of Roadmap 4.3's clientId (PR #18 CodeRabbit finding).

A Roadmap 4.3 clientId is a browser-generated UUID with no cryptographic
binding to whoever holds it — CodeRabbit's PR #18 review pointed out that
api_handler.py's self-service routes (GET /remote-config, and the
push-subscription/notification-preference PUT/DELETE routes) trusted a
caller-supplied clientId as proof of ownership, so anyone who learned or
guessed a clientId could read or overwrite that client's stored data.

This module is the storage-agnostic half of the fix: generating a random
secret and hashing it for storage, the same "never store/compare the raw
value" shape a password would get. client_credential_store.py is the
DynamoDB-specific layer in front of it, and api_handler.py wires both into
a new POST /clients/{clientId}/credential registration route plus a
X-Client-Secret check in front of every route this secret now protects.
"""

from __future__ import annotations

import hashlib
import secrets

# 32 raw bytes (256 bits) before URL-safe base64 encoding — well beyond
# brute-forceable, and generated with the same `secrets` module the stdlib
# itself recommends for tokens/passwords rather than `random`.
_SECRET_BYTES = 32


def generate_secret() -> str:
    """A new random, URL-safe client secret. Returned to the caller once, at registration — never stored raw."""
    return secrets.token_urlsafe(_SECRET_BYTES)


def hash_secret(secret: str) -> str:
    """One-way SHA-256 hex digest of a client secret, for storage/comparison instead of the raw value."""
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()
