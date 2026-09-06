"""Local environment configuration loading."""

from __future__ import annotations

import functools
import os

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from dotenv import load_dotenv

load_dotenv()


class MissingAPIKeyError(RuntimeError):
    """Raised when YOUTUBE_API_KEY is not set, or the Secrets Manager alternative can't be read."""


class MissingVapidCredentialsError(RuntimeError):
    """Raised when no usable VAPID private key/claims are configured."""


@functools.cache
def get_api_key() -> str:
    """Return the YouTube Data API key, preferring Secrets Manager over the plaintext env var fallback.

    YOUTUBE_API_KEY_SECRET_NAME (deployed Lambda) takes priority over
    YOUTUBE_API_KEY (local .env) so the key is never stored in plaintext
    Lambda configuration, where it previously leaked twice via unfiltered
    `aws lambda` CLI output (docs/aws-setup.zh-TW.md). @functools.cache keeps
    repeat calls within a warm Lambda container, or the two call sites in
    main.py, from each paying for a separate Secrets Manager request — it
    only memoizes a successful return, never a raised exception, so a
    transient failure doesn't get "cached" as permanent. Every failure mode
    (unreadable secret, wrong secret shape, missing env var) raises
    MissingAPIKeyError, matching what main.py's call sites already catch.
    """
    secret_name = os.getenv("YOUTUBE_API_KEY_SECRET_NAME")
    if secret_name:
        try:
            secret_value = boto3.client("secretsmanager").get_secret_value(SecretId=secret_name).get("SecretString")
        except (ClientError, BotoCoreError) as exc:
            raise MissingAPIKeyError(f"Could not read secret {secret_name!r} from Secrets Manager: {exc}") from exc
        if not secret_value:
            raise MissingAPIKeyError(
                f"Secret {secret_name!r} has no SecretString value "
                "(it was likely created as SecretBinary instead of plaintext)."
            )
        return secret_value

    api_key = os.getenv("YOUTUBE_API_KEY")
    if not api_key:
        raise MissingAPIKeyError(
            "Neither YOUTUBE_API_KEY_SECRET_NAME nor YOUTUBE_API_KEY is set. "
            "Copy .env.example to .env and add your key for local development."
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
