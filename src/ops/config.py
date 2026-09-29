"""Local environment configuration loading.

AWS Cost Recovery (third pass, Scope I): every *_SSM_PARAMETER env var below
is the repository-side half of a Secrets Manager -> SSM Parameter Store
SecureString migration, prepared but NOT cut over -- Secrets Manager charges
$0.40/secret/month + $0.05/10k API calls with no free tier; SSM Parameter
Store's Standard tier (SecureString storage + standard-throughput
GetParameter calls) is free. Each *_SSM_PARAMETER check takes priority over
its existing *_SECRET_NAME sibling, mirroring exactly the precedence
*_SECRET_NAME already has over the plaintext env var fallback -- so setting
none of the new env vars (true today, since Terraform hasn't been applied)
is a complete no-op, and setting one later needs no code change, only a
config/IaC one, at whatever pace each secret is migrated. See _get_ssm_
parameter's own docstring for the read path, and the third-pass report's
Scope I section for the full, sequenced live-cutover checklist (create the
real parameter -> grant IAM ssm:GetParameter -> apply Terraform's new env
var -> verify -> only then remove the old Secrets Manager path).

No secret value is read, created, or committed anywhere in this migration --
this module still only ever reads whatever value already lives in AWS at
call time, exactly like the Secrets Manager path it's replacing.
"""

from __future__ import annotations

import functools
import os

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from dotenv import load_dotenv

load_dotenv()


def _get_ssm_parameter(parameter_name: str, *, error_class: type[Exception], description: str) -> str:
    """Read one SecureString parameter from SSM Parameter Store, WithDecryption=true.

    Mirrors the existing Secrets Manager call sites' own error handling
    exactly (ClientError/BotoCoreError -> the caller's own typed error), so
    swapping which backend a given secret uses changes no caller-visible
    failure mode. Not cached here — each of this module's *_SSM_PARAMETER
    call sites applies caching (or deliberately doesn't) the same way it
    already does for its own Secrets Manager path, for the same reasons
    (see get_api_key/get_admin_api_key's own docstrings).
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
    """Return the YouTube Data API key, preferring SSM Parameter Store, then
    Secrets Manager, then the plaintext env var fallback.

    YOUTUBE_API_KEY_SSM_PARAMETER (AWS Cost Recovery, third pass, Scope I --
    see this module's own docstring) takes priority over
    YOUTUBE_API_KEY_SECRET_NAME (deployed Lambda), which itself takes
    priority over YOUTUBE_API_KEY (local .env), so the key is never stored
    in plaintext Lambda configuration, where it previously leaked twice via
    unfiltered `aws lambda` CLI output (docs/aws-setup.zh-TW.md).
    @functools.cache keeps repeat calls within a warm Lambda container, or
    the two call sites in main.py, from each paying for a separate
    SSM/Secrets Manager request — it only memoizes a successful return,
    never a raised exception, so a transient failure doesn't get "cached" as
    permanent. Every failure mode (unreadable parameter/secret, wrong shape,
    missing env var) raises MissingAPIKeyError, matching what main.py's call
    sites already catch.
    """
    ssm_parameter = os.getenv("YOUTUBE_API_KEY_SSM_PARAMETER")
    if ssm_parameter:
        return _get_ssm_parameter(ssm_parameter, error_class=MissingAPIKeyError, description="YouTube Data API key")

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
            "None of YOUTUBE_API_KEY_SSM_PARAMETER, YOUTUBE_API_KEY_SECRET_NAME, or YOUTUBE_API_KEY is set. "
            "Copy .env.example to .env and add your key for local development."
        )
    return api_key


def get_vapid_credentials() -> tuple[str, dict[str, str]]:
    """Return (vapid_private_key_pem, vapid_claims) for push_sender.py (Roadmap 4.6).

    VAPID_PRIVATE_KEY_SSM_PARAMETER (AWS Cost Recovery, third pass, Scope I)
    takes priority over VAPID_PRIVATE_KEY_SECRET_NAME (deployed Lambda),
    which itself takes priority — the Lambda reads the PEM content from
    SSM/Secrets Manager at call time via boto3, the same pattern as
    get_api_key() above, so the key is never stored in plaintext Lambda
    configuration. VAPID_PRIVATE_KEY (the PEM content itself, as a literal
    env var) and VAPID_PRIVATE_KEY_PATH (a PEM file on disk, per
    .env.example) remain as local-development fallbacks, checked in that
    order. Not cached, same as the Secrets Manager path it precedes — this
    function's own callers don't call it often enough for that to matter,
    unlike get_api_key's own two call sites per run.
    """
    ssm_parameter = os.getenv("VAPID_PRIVATE_KEY_SSM_PARAMETER")
    secret_name = os.getenv("VAPID_PRIVATE_KEY_SECRET_NAME")
    if ssm_parameter:
        private_key = _get_ssm_parameter(
            ssm_parameter, error_class=MissingVapidCredentialsError, description="VAPID private key"
        )
    elif secret_name:
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
                "None of VAPID_PRIVATE_KEY_SSM_PARAMETER, VAPID_PRIVATE_KEY_SECRET_NAME, VAPID_PRIVATE_KEY, "
                "or VAPID_PRIVATE_KEY_PATH is set. See .env.example."
            )
    subject = os.getenv("VAPID_CLAIMS_SUB")
    if not subject:
        raise MissingVapidCredentialsError("VAPID_CLAIMS_SUB is not set. See .env.example.")
    return private_key, {"sub": subject}


def get_admin_api_key() -> str:
    """Return the shared admin API key, preferring SSM Parameter Store, then
    Secrets Manager, then the plaintext env var fallback.

    YOBI_ADMIN_API_KEY_SSM_PARAMETER (AWS Cost Recovery, third pass, Scope I)
    takes priority over YOBI_ADMIN_API_KEY_SECRET_NAME (deployed Lambda),
    which itself takes priority over YOBI_ADMIN_API_KEY (local .env / older
    plaintext Lambda config) so the key is never stored in plaintext Lambda
    configuration, the same pattern as get_api_key() above. Deliberately NOT
    @functools.cache'd unlike get_api_key() — this key is compared against
    every admin-protected request, so a rotated key (e.g. after an exposure)
    must take effect on the very next request, not only once a warm Lambda
    container happens to recycle. This uncached requirement applies exactly
    as much to the new SSM path as it always did to the Secrets Manager
    one — neither is memoized here. YOUTUBE_API_KEY has no such requirement
    (it's never compared against caller input), so caching it stays safe.
    """
    ssm_parameter = os.getenv("YOBI_ADMIN_API_KEY_SSM_PARAMETER")
    if ssm_parameter:
        return _get_ssm_parameter(ssm_parameter, error_class=MissingAdminApiKeyError, description="admin API key")

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
            "None of YOBI_ADMIN_API_KEY_SSM_PARAMETER, YOBI_ADMIN_API_KEY_SECRET_NAME, or YOBI_ADMIN_API_KEY is set."
        )
    return api_key


@functools.cache
def get_holodex_api_key() -> str:
    """Return the Holodex API key, preferring Secrets Manager over the plaintext env var fallback.

    HOLODEX_SECRET_NAME (deployed Lambda) takes priority over HOLODEX_API_KEY
    (local .env) so the key is never stored in plaintext Lambda
    configuration, the same pattern as get_api_key() above. Named
    HOLODEX_SECRET_NAME rather than HOLODEX_API_KEY_SECRET_NAME (unlike the
    YOUTUBE_*/YOBI_ADMIN_* pairs) to deliberately avoid any resemblance to
    the frontend's old VITE_HOLODEX_API_KEY, which this key replaces.
    @functools.cache is safe here for the same reason as get_api_key(): this
    key is only used to call Holodex outbound, never compared against
    caller input, so memoizing a successful read across a warm container is
    safe; a raised exception is never cached.
    """
    secret_name = os.getenv("HOLODEX_SECRET_NAME")
    if secret_name:
        try:
            secret_value = boto3.client("secretsmanager").get_secret_value(SecretId=secret_name).get("SecretString")
        except (ClientError, BotoCoreError) as exc:
            raise MissingHolodexApiKeyError(f"Could not read secret {secret_name!r} from Secrets Manager: {exc}") from exc
        if not secret_value:
            raise MissingHolodexApiKeyError(
                f"Secret {secret_name!r} has no SecretString value "
                "(it was likely created as SecretBinary instead of plaintext)."
            )
        return secret_value

    api_key = os.getenv("HOLODEX_API_KEY")
    if not api_key:
        raise MissingHolodexApiKeyError(
            "Neither HOLODEX_SECRET_NAME nor HOLODEX_API_KEY is set. "
            "Copy .env.example to .env and add your key for local development."
        )
    return api_key
