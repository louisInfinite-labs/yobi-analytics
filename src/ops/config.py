"""Runtime-secret loading (YouTube, Holodex, VAPID, admin key).

Every deployed secret is read through ONE choke point in this module: AWS Systems Manager Parameter Store, a SecureString in the free Standard
tier, read with ``ssm:GetParameter`` + ``WithDecryption`` -- in memory only, never logged. The Lambda environment carries only the parameter NAME
(``*_SSM_PARAMETER``), never a value. The plaintext environment variable / file of each secret remains for local development only.

A missing, unreadable or empty parameter is a real error (the getter's own ``Missing...Error``): there is no second source to fall back to.
(The Secrets Manager secrets these replaced, and the controlled transition fallback to them, were removed once every consumer was proven to read
from SSM.) Which backend served a secret is logged once per process as ``secret source: <description> source=ssm``; the value is never part of
any log line or error message.
"""

from __future__ import annotations

import functools
import os

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from dotenv import load_dotenv

load_dotenv()

_logged_sources: set[tuple[str, str]] = set()


def _log_source(description: str, source: str) -> None:
    """Print which backend served a secret, once per process per (secret, source). Never includes the value."""
    key = (description, source)
    if key in _logged_sources:
        return
    _logged_sources.add(key)
    print(f"secret source: {description} source={source}")


def _get_ssm_parameter(parameter_name: str, *, error_class: type[Exception], description: str) -> str:
    """Read one SecureString parameter from SSM Parameter Store, WithDecryption=true.

    ClientError/BotoCoreError (including ParameterNotFound and AccessDeniedException) -> the caller's own typed error; an empty value is also an
    error. Not cached here: each caller applies caching (or deliberately does not).
    """
    try:
        response = boto3.client("ssm").get_parameter(Name=parameter_name, WithDecryption=True)
    except (ClientError, BotoCoreError) as exc:
        raise error_class(f"Could not read SSM parameter {parameter_name!r} ({description}): {exc}") from exc
    value = response.get("Parameter", {}).get("Value")
    if not value:
        raise error_class(
            f"SSM parameter {parameter_name!r} ({description}) has no value "
            "(it may not have been created yet, or was created with an empty value)."
        )
    return value


def _load_deployed_secret(*, ssm_env: str, error_class: type[Exception], description: str) -> str | None:
    """The SSM parameter's value when its locator env var is set; None when it is not (local development)."""
    ssm_parameter = os.getenv(ssm_env)
    if not ssm_parameter:
        return None
    value = _get_ssm_parameter(ssm_parameter, error_class=error_class, description=description)
    _log_source(description, "ssm")
    return value


class MissingAPIKeyError(RuntimeError):
    """Raised when the YouTube API key is not configured, or its SSM parameter can't be read."""


class MissingVapidCredentialsError(RuntimeError):
    """Raised when no usable VAPID private key/claims are configured."""


class MissingAdminApiKeyError(RuntimeError):
    """Raised when the admin API key is not configured, or its SSM parameter can't be read."""


class MissingHolodexApiKeyError(RuntimeError):
    """Raised when the Holodex API key is not configured, or its SSM parameter can't be read."""


@functools.cache
def get_api_key() -> str:
    """Return the YouTube Data API key: SSM Parameter Store (YOUTUBE_API_KEY_SSM_PARAMETER), else the plaintext YOUTUBE_API_KEY (local .env).

    The memoization keeps repeat calls within a warm Lambda container (and the two call sites in main.py) from each paying for a separate SSM
    request. functools.cache remembers only a successful return, never a raised exception, so a transient failure is not cached as permanent. Every
    failure mode raises MissingAPIKeyError, which is what main.py's call sites already catch.
    """
    key = _load_deployed_secret(
        ssm_env="YOUTUBE_API_KEY_SSM_PARAMETER",
        error_class=MissingAPIKeyError,
        description="YouTube Data API key",
    )
    if key:
        return key
    api_key = os.getenv("YOUTUBE_API_KEY")
    if not api_key:
        raise MissingAPIKeyError(
            "Neither YOUTUBE_API_KEY_SSM_PARAMETER nor YOUTUBE_API_KEY is set. "
            "Copy .env.example to .env and add your key for local development."
        )
    return api_key


def get_vapid_credentials() -> tuple[str, dict[str, str]]:
    """Return (vapid_private_key_pem, vapid_claims) for push_sender.py (Roadmap 4.6).

    The PEM comes from SSM (VAPID_PRIVATE_KEY_SSM_PARAMETER); VAPID_PRIVATE_KEY (the PEM content itself) and VAPID_PRIVATE_KEY_PATH (a PEM file on disk, per .env.example) remain
    local-development fallbacks, checked in that order. Not cached: the dispatcher reads it once per run.
    """
    private_key = _load_deployed_secret(
        ssm_env="VAPID_PRIVATE_KEY_SSM_PARAMETER",
        error_class=MissingVapidCredentialsError,
        description="VAPID private key",
    )
    if not private_key:
        private_key = os.getenv("VAPID_PRIVATE_KEY")
        if not private_key:
            key_path = os.getenv("VAPID_PRIVATE_KEY_PATH")
            if key_path:
                with open(key_path, encoding="utf-8") as f:
                    private_key = f.read()
        if not private_key:
            raise MissingVapidCredentialsError(
                "None of VAPID_PRIVATE_KEY_SSM_PARAMETER, VAPID_PRIVATE_KEY, "
                "or VAPID_PRIVATE_KEY_PATH is set. See .env.example."
            )
    subject = os.getenv("VAPID_CLAIMS_SUB")
    if not subject:
        raise MissingVapidCredentialsError("VAPID_CLAIMS_SUB is not set. See .env.example.")
    return private_key, {"sub": subject}


def get_admin_api_key() -> str:
    """Return the shared admin API key: SSM (YOBI_ADMIN_API_KEY_SSM_PARAMETER), else the plaintext YOBI_ADMIN_API_KEY.

    Deliberately NOT @functools.cache'd unlike get_api_key(): this key is compared against every admin-protected request, so a rotated key
    (e.g. after an exposure) must take effect on the very next request, not only once a warm Lambda container happens to recycle.
    """
    key = _load_deployed_secret(
        ssm_env="YOBI_ADMIN_API_KEY_SSM_PARAMETER",
        error_class=MissingAdminApiKeyError,
        description="admin API key",
    )
    if key:
        return key
    api_key = os.getenv("YOBI_ADMIN_API_KEY")
    if not api_key:
        raise MissingAdminApiKeyError(
            "Neither YOBI_ADMIN_API_KEY_SSM_PARAMETER nor YOBI_ADMIN_API_KEY is set."
        )
    return api_key


@functools.cache
def get_holodex_api_key() -> str:
    """Return the Holodex API key: SSM (HOLODEX_SSM_PARAMETER), else the plaintext HOLODEX_API_KEY (local .env).

    The locator is named HOLODEX_SSM_PARAMETER rather than HOLODEX_API_KEY_* to avoid any resemblance to the frontend's
    old VITE_HOLODEX_API_KEY, which this key replaces. The memoization (same rules as get_api_key()) is safe because the key is only used
    to call Holodex outbound, never compared against caller input.
    """
    key = _load_deployed_secret(
        ssm_env="HOLODEX_SSM_PARAMETER",
        error_class=MissingHolodexApiKeyError,
        description="Holodex API key",
    )
    if key:
        return key
    api_key = os.getenv("HOLODEX_API_KEY")
    if not api_key:
        raise MissingHolodexApiKeyError(
            "Neither HOLODEX_SSM_PARAMETER nor HOLODEX_API_KEY is set. "
            "Copy .env.example to .env and add your key for local development."
        )
    return api_key
