"""Local environment configuration loading."""

from __future__ import annotations

import os

from dotenv import load_dotenv

load_dotenv()


class MissingAPIKeyError(RuntimeError):
    """Raised when YOUTUBE_API_KEY is not set."""


class MissingVapidCredentialsError(RuntimeError):
    """Raised when no usable VAPID private key/claims are configured."""


def get_api_key() -> str:
    api_key = os.getenv("YOUTUBE_API_KEY")
    if not api_key:
        raise MissingAPIKeyError(
            "YOUTUBE_API_KEY is not set. Copy .env.example to .env and add your key."
        )
    return api_key


def get_vapid_credentials() -> tuple[str, dict[str, str]]:
    """Return (vapid_private_key_pem, vapid_claims) for push_sender.py (Roadmap 4.6).

    VAPID_PRIVATE_KEY (the PEM content itself) takes priority — that's how a
    deployed Lambda gets it, e.g. a Secrets Manager entry surfaced as an
    environment variable, since the Lambda deployment package is read-only
    and the key must never be committed into it. VAPID_PRIVATE_KEY_PATH (a
    PEM file on disk, per .env.example) is the local-development fallback.
    """
    private_key = os.getenv("VAPID_PRIVATE_KEY")
    if not private_key:
        key_path = os.getenv("VAPID_PRIVATE_KEY_PATH")
        if key_path:
            with open(key_path, encoding="utf-8") as f:
                private_key = f.read()
    if not private_key:
        raise MissingVapidCredentialsError(
            "Neither VAPID_PRIVATE_KEY nor VAPID_PRIVATE_KEY_PATH is set. See .env.example."
        )
    subject = os.getenv("VAPID_CLAIMS_SUB")
    if not subject:
        raise MissingVapidCredentialsError("VAPID_CLAIMS_SUB is not set. See .env.example.")
    return private_key, {"sub": subject}
