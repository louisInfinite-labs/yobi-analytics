"""Runtime-secret loading (YouTube, Holodex, VAPID, admin key).

Every deployed secret is read through ONE choke point in this module, in this precedence:

1. ``*_SSM_PARAMETER`` -- the name of an AWS Systems Manager Parameter Store SecureString (Standard tier, free; Secrets Manager charges
   $0.40/secret/month plus API calls). Read with ``ssm:GetParameter`` + ``WithDecryption`` -- in memory only, never logged.
2. ``*_SECRET_NAME`` -- the old AWS Secrets Manager secret. TRANSITION ONLY: it is used when no SSM locator is configured, and as a
   controlled fallback when the SSM parameter does not exist yet (``ParameterNotFound``) or this role may not read it yet
   (``AccessDeniedException``) -- the two states a half-finished migration is in. Any other SSM failure (throttling, an empty value, a
   network error ...) is a real error and is raised, never papered over by the old path. This fallback is removed once every consumer is
   proven to read from SSM (the cutover is then SSM-only).
3. The plaintext environment variable / file -- local development only.

Lambda environments carry only the parameter / secret NAMES (locators), never a value. Which backend actually served a secret is logged once
per process as ``secret source: <description> source=ssm|secretsmanager`` -- the value is never part of any log line or error message.
"""

from __future__ import annotations

import functools
import os

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from dotenv import load_dotenv

load_dotenv()

# The only SSM errors that count as "the new parameter is not usable YET" and may fall back to the old Secrets Manager secret.
_SSM_FALLBACK_ERROR_CODES = frozenset({"ParameterNotFound", "AccessDeniedException"})

_logged_sources: set[tuple[str, str, str]] = set()


def _log_source(description: str, source: str, reason: str = "") -> None:
    """Print which backend served a secret, once per process per (secret, source, reason). Never includes the value."""
    key = (description, source, reason)
    if key in _logged_sources:
        return
    _logged_sources.add(key)
    suffix = f" fallback_reason={reason}" if reason else ""
    print(f"secret source: {description} source={source}{suffix}")


class _SsmParameterUnavailable(Exception):
    """Internal: the SSM parameter does not exist yet, or this role cannot read it yet (see _SSM_FALLBACK_ERROR_CODES)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _get_ssm_parameter(parameter_name: str, *, error_class: type[Exception], description: str, can_fall_back: bool = False) -> str:
    """Read one SecureString parameter from SSM Parameter Store, WithDecryption=true.

    ClientError/BotoCoreError -> the caller's own typed error, exactly like the Secrets Manager call sites, with ONE exception: when
    can_fall_back is True (an old Secrets Manager locator is still configured) a ParameterNotFound / AccessDeniedException raises the internal
    _SsmParameterUnavailable instead, so the loader can use the old secret during the migration. An empty value is never a fallback case.
    Not cached here: each caller applies caching (or deliberately does not) the same way it always did.
    """
    try:
        response = boto3.client("ssm").get_parameter(Name=parameter_name, WithDecryption=True)
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if can_fall_back and code in _SSM_FALLBACK_ERROR_CODES:
            raise _SsmParameterUnavailable(code) from None
        raise error_class(f"Could not read SSM parameter {parameter_name!r} ({description}): {exc}") from exc
    except BotoCoreError as exc:
        raise error_class(f"Could not read SSM parameter {parameter_name!r} ({description}): {exc}") from exc
    value = response.get("Parameter", {}).get("Value")
    if not value:
        raise error_class(
            f"SSM parameter {parameter_name!r} ({description}) has no value "
            "(it may not have been created yet, or was created with an empty value)."
        )
    return value


def _get_secrets_manager_secret(secret_name: str, *, error_class: type[Exception], description: str) -> str:
    """Read one plaintext SecretString from AWS Secrets Manager (the pre-migration path)."""
    try:
        secret_value = boto3.client("secretsmanager").get_secret_value(SecretId=secret_name).get("SecretString")
    except (ClientError, BotoCoreError) as exc:
        raise error_class(f"Could not read secret {secret_name!r} from Secrets Manager: {exc}") from exc
    if not secret_value:
        raise error_class(
            f"Secret {secret_name!r} has no SecretString value "
            "(it was likely created as SecretBinary instead of plaintext)."
        )
    return secret_value


def _load_deployed_secret(*, ssm_env: str, secret_env: str, error_class: type[Exception], description: str) -> str | None:
    """The deployed-secret precedence (see the module docstring); None when neither locator is configured (local development)."""
    ssm_parameter = os.getenv(ssm_env)
    secret_name = os.getenv(secret_env)
    fallback_reason = ""
    if ssm_parameter:
        try:
            value = _get_ssm_parameter(ssm_parameter, error_class=error_class, description=description, can_fall_back=bool(secret_name))
        except _SsmParameterUnavailable as unavailable:
            fallback_reason = f"ssm_{unavailable.code}"
        else:
            _log_source(description, "ssm")
            return value
    if secret_name:
        value = _get_secrets_manager_secret(secret_name, error_class=error_class, description=description)
        _log_source(description, "secretsmanager", fallback_reason)
        return value
    return None


class MissingAPIKeyError(RuntimeError):
    """Raised when YOUTUBE_API_KEY is not set, or the Secrets Manager alternative can't be read."""


class MissingVapidCredentialsError(RuntimeError):
    """Raised when no usable VAPID private key/claims are configured."""


class MissingAdminApiKeyError(RuntimeError):
    """Raised when YOBI_ADMIN_API_KEY is not set, or the Secrets Manager alternative can't be read."""


class MissingHolodexApiKeyError(RuntimeError):
    """Raised when HOLODEX_API_KEY is not set, or the Secrets Manager alternative can't be read."""


@functools.cache
def get_api_key() -> str:
    """Return the YouTube Data API key: SSM Parameter Store first (YOUTUBE_API_KEY_SSM_PARAMETER), the old Secrets Manager secret
    (YOUTUBE_API_KEY_SECRET_NAME) as the transition fallback, then the plaintext YOUTUBE_API_KEY (local .env) -- see the module docstring.

    @functools.cache keeps repeat calls within a warm Lambda container (and the two call sites in main.py) from each paying for a separate
    SSM request. It only memoizes a successful return, never a raised exception, so a transient failure is not cached as permanent. Every
    failure mode raises MissingAPIKeyError, which is what main.py's call sites already catch.
    """
    key = _load_deployed_secret(
        ssm_env="YOUTUBE_API_KEY_SSM_PARAMETER",
        secret_env="YOUTUBE_API_KEY_SECRET_NAME",
        error_class=MissingAPIKeyError,
        description="YouTube Data API key",
    )
    if key:
        return key
    api_key = os.getenv("YOUTUBE_API_KEY")
    if not api_key:
        raise MissingAPIKeyError(
            "None of YOUTUBE_API_KEY_SSM_PARAMETER, YOUTUBE_API_KEY_SECRET_NAME, or YOUTUBE_API_KEY is set. "
            "Copy .env.example to .env and add your key for local development."
        )
    return api_key


def get_vapid_credentials() -> tuple[str, dict[str, str]]:
    """Return (vapid_private_key_pem, vapid_claims) for push_sender.py (Roadmap 4.6).

    The PEM comes from SSM (VAPID_PRIVATE_KEY_SSM_PARAMETER), then the old Secrets Manager secret (VAPID_PRIVATE_KEY_SECRET_NAME) as the
    transition fallback; VAPID_PRIVATE_KEY (the PEM content itself) and VAPID_PRIVATE_KEY_PATH (a PEM file on disk, per .env.example) remain
    local-development fallbacks, checked in that order. Not cached: the dispatcher reads it once per run.
    """
    private_key = _load_deployed_secret(
        ssm_env="VAPID_PRIVATE_KEY_SSM_PARAMETER",
        secret_env="VAPID_PRIVATE_KEY_SECRET_NAME",
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
                "None of VAPID_PRIVATE_KEY_SSM_PARAMETER, VAPID_PRIVATE_KEY_SECRET_NAME, VAPID_PRIVATE_KEY, "
                "or VAPID_PRIVATE_KEY_PATH is set. See .env.example."
            )
    subject = os.getenv("VAPID_CLAIMS_SUB")
    if not subject:
        raise MissingVapidCredentialsError("VAPID_CLAIMS_SUB is not set. See .env.example.")
    return private_key, {"sub": subject}


def get_admin_api_key() -> str:
    """Return the shared admin API key: SSM (YOBI_ADMIN_API_KEY_SSM_PARAMETER), then the old Secrets Manager secret
    (YOBI_ADMIN_API_KEY_SECRET_NAME) as the transition fallback, then the plaintext YOBI_ADMIN_API_KEY.

    Deliberately NOT @functools.cache'd unlike get_api_key(): this key is compared against every admin-protected request, so a rotated key
    (e.g. after an exposure) must take effect on the very next request, not only once a warm Lambda container happens to recycle.
    """
    key = _load_deployed_secret(
        ssm_env="YOBI_ADMIN_API_KEY_SSM_PARAMETER",
        secret_env="YOBI_ADMIN_API_KEY_SECRET_NAME",
        error_class=MissingAdminApiKeyError,
        description="admin API key",
    )
    if key:
        return key
    api_key = os.getenv("YOBI_ADMIN_API_KEY")
    if not api_key:
        raise MissingAdminApiKeyError(
            "None of YOBI_ADMIN_API_KEY_SSM_PARAMETER, YOBI_ADMIN_API_KEY_SECRET_NAME, or YOBI_ADMIN_API_KEY is set."
        )
    return api_key


@functools.cache
def get_holodex_api_key() -> str:
    """Return the Holodex API key: SSM (HOLODEX_SSM_PARAMETER), then the old Secrets Manager secret (HOLODEX_SECRET_NAME) as the
    transition fallback, then the plaintext HOLODEX_API_KEY (local .env).

    The locator is named HOLODEX_SECRET_NAME / HOLODEX_SSM_PARAMETER rather than HOLODEX_API_KEY_* to avoid any resemblance to the frontend's
    old VITE_HOLODEX_API_KEY, which this key replaces. @functools.cache is safe for the same reason as get_api_key(): the key is only used
    to call Holodex outbound, never compared against caller input, and a raised exception is never cached.
    """
    key = _load_deployed_secret(
        ssm_env="HOLODEX_SSM_PARAMETER",
        secret_env="HOLODEX_SECRET_NAME",
        error_class=MissingHolodexApiKeyError,
        description="Holodex API key",
    )
    if key:
        return key
    api_key = os.getenv("HOLODEX_API_KEY")
    if not api_key:
        raise MissingHolodexApiKeyError(
            "None of HOLODEX_SSM_PARAMETER, HOLODEX_SECRET_NAME, or HOLODEX_API_KEY is set. "
            "Copy .env.example to .env and add your key for local development."
        )
    return api_key
