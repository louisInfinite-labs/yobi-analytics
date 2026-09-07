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


class MissingAdminApiKeyError(RuntimeError):
    """Raised when YOBI_ADMIN_API_KEY is not set, or the Secrets Manager alternative can't be read."""


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

    VAPID_PRIVATE_KEY_SECRET_NAME (deployed Lambda) takes priority — the
    Lambda reads the PEM content from Secrets Manager at call time via
    boto3, the same pattern as get_api_key() below, so the key is never
    stored in plaintext Lambda configuration. VAPID_PRIVATE_KEY (the PEM
    content itself, as a literal env var) and VAPID_PRIVATE_KEY_PATH (a PEM
    file on disk, per .env.example) remain as local-development fallbacks,
    checked in that order.
    """
    secret_name = os.getenv("VAPID_PRIVATE_KEY_SECRET_NAME")
    if secret_name:
        try:
            private_key = boto3.client("secretsmanager").get_secret_value(SecretId=secret_name).get("SecretString")
        except (ClientError, BotoCoreError) as exc:
            raise MissingVapidCredentialsError(f"Could not read secret {secret_name!r} from Secrets Manager: {exc}") from exc
        if not private_key:
            raise MissingVapidCredentialsError(
                f"Secret {secret_name!r} has no SecretString value "
                "(it was likely created as SecretBinary instead of plaintext)."
            )
    else:
        private_key = os.getenv("VAPID_PRIVATE_KEY")
        if not private_key:
            key_path = os.getenv("VAPID_PRIVATE_KEY_PATH")
            if key_path:
                with open(key_path, encoding="utf-8") as f:
                    private_key = f.read()
        if not private_key:
            raise MissingVapidCredentialsError(
                "None of VAPID_PRIVATE_KEY_SECRET_NAME, VAPID_PRIVATE_KEY, or VAPID_PRIVATE_KEY_PATH is set. "
                "See .env.example."
            )
    subject = os.getenv("VAPID_CLAIMS_SUB")
    if not subject:
        raise MissingVapidCredentialsError("VAPID_CLAIMS_SUB is not set. See .env.example.")
    return private_key, {"sub": subject}


@functools.cache
def get_admin_api_key() -> str:
    """Return the shared admin API key, preferring Secrets Manager over the plaintext env var fallback.

    YOBI_ADMIN_API_KEY_SECRET_NAME (deployed Lambda) takes priority over
    YOBI_ADMIN_API_KEY (local .env / older plaintext Lambda config) so the
    key is never stored in plaintext Lambda configuration, the same pattern
    as get_api_key() above. @functools.cache only memoizes a successful
    return, never a raised exception, so a transient Secrets Manager failure
    doesn't get "cached" as permanent.
    """
    secret_name = os.getenv("YOBI_ADMIN_API_KEY_SECRET_NAME")
    if secret_name:
        try:
            secret_value = boto3.client("secretsmanager").get_secret_value(SecretId=secret_name).get("SecretString")
        except (ClientError, BotoCoreError) as exc:
            raise MissingAdminApiKeyError(f"Could not read secret {secret_name!r} from Secrets Manager: {exc}") from exc
        if not secret_value:
            raise MissingAdminApiKeyError(
                f"Secret {secret_name!r} has no SecretString value "
                "(it was likely created as SecretBinary instead of plaintext)."
            )
        return secret_value

    api_key = os.getenv("YOBI_ADMIN_API_KEY")
    if not api_key:
        raise MissingAdminApiKeyError(
            "Neither YOBI_ADMIN_API_KEY_SECRET_NAME nor YOBI_ADMIN_API_KEY is set."
        )
    return api_key
