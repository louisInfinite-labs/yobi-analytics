"""Local environment configuration loading."""

from __future__ import annotations

import os

from dotenv import load_dotenv

load_dotenv()


class MissingAPIKeyError(RuntimeError):
    """Raised when YOUTUBE_API_KEY is not set."""


class MissingVapidCredentialsError(RuntimeError):
    """Raised when no usable VAPID private key/claims are configured."""


_cached_api_key: str | None = None


def get_api_key() -> str:
    """Return the YouTube Data API key, preferring Secrets Manager over the plaintext env var fallback.

    YOUTUBE_API_KEY_SECRET_NAME (deployed Lambda) takes priority over
    YOUTUBE_API_KEY (local .env) so the key is never stored in plaintext
    Lambda configuration, where it previously leaked twice via unfiltered
    `aws lambda` CLI output (docs/aws-setup.zh-TW.md). Cached at module level
    so repeat calls within a warm Lambda container, or the two call sites in
    main.py, don't each pay for a separate Secrets Manager request.
    """
    global _cached_api_key
    if _cached_api_key:
        return _cached_api_key

    secret_name = os.getenv("YOUTUBE_API_KEY_SECRET_NAME")
    if secret_name:
        import boto3

        client = boto3.client("secretsmanager")
        _cached_api_key = client.get_secret_value(SecretId=secret_name)["SecretString"]
        return _cached_api_key

    api_key = os.getenv("YOUTUBE_API_KEY")
    if not api_key:
        raise MissingAPIKeyError(
            "Neither YOUTUBE_API_KEY_SECRET_NAME nor YOUTUBE_API_KEY is set. "
            "Copy .env.example to .env and add your key for local development."
        )
    _cached_api_key = api_key
    return _cached_api_key


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
