"""SEC-API-BOT-002 (roadmap MT-28): the attestation settings and the App Check CORS header are Terraform variables, never
fabricated values, and production can only be `monitor` or `enforce` (default `enforce`), never `off`.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from api.attestation import AttestationConfig

pytestmark = pytest.mark.security

REPO = Path(__file__).resolve().parents[2]
TERRAFORM = REPO / "terraform"
API_GATEWAY_TF = (TERRAFORM / "api_gateway.tf").read_text(encoding="utf-8")
LAMBDA_TF = (TERRAFORM / "lambda.tf").read_text(encoding="utf-8")
VARIABLES_TF = (TERRAFORM / "variables.tf").read_text(encoding="utf-8")
ALL_TF = "\n".join(p.read_text(encoding="utf-8") for p in sorted(TERRAFORM.glob("*.tf")))


def _variable(name: str) -> str:
    start = VARIABLES_TF.index(f'variable "{name}"')
    nxt = VARIABLES_TF.find('\nvariable "', start + 5)
    return VARIABLES_TF[start : nxt if nxt != -1 else len(VARIABLES_TF)]


def test_cors_keeps_the_existing_headers_and_adds_the_app_check_header_only_when_attestation_is_enabled():
    allow = re.search(r"allow_headers\s*=\s*concat\((.*?)\)\n", API_GATEWAY_TF, re.DOTALL)

    assert allow is not None
    always, conditional = allow.group(1).split("var.attestation_enabled", 1)
    assert {"content-type", "x-admin-key", "x-client-secret"} <= set(re.findall(r'"([^"]+)"', always))
    assert "x-firebase-appcheck" not in always, "the App Check header ships with the attestation configuration (MT-31)"
    assert re.findall(r'"([^"]+)"', conditional) == ["x-firebase-appcheck"]


def test_the_mode_can_only_be_monitor_or_enforce_and_defaults_to_enforce():
    block = _variable("attestation_mode")

    assert re.search(r'default\s*=\s*"enforce"', block)
    assert 'contains(["monitor", "enforce"], var.attestation_mode)' in block
    assert '"off"' not in block.split("validation", 1)[1].split("error_message")[0]


def test_attestation_is_disabled_by_default_so_a_deploy_before_the_firebase_values_is_not_an_outage():
    assert re.search(r'default\s*=\s*false', _variable("attestation_enabled"))


def test_no_firebase_deployment_value_is_committed():
    for name in ("appcheck_project_number", "appcheck_app_id"):
        assert re.search(r'default\s*=\s*""', _variable(name)), f"{name} must default to empty, never a fabricated value"
    assert not re.search(r'"\d{10,}"', ALL_TF), "no numeric project number may appear in Terraform"
    assert ":web:" not in ALL_TF and "web.app" not in ALL_TF and "firebaseapp.com" not in ALL_TF


def test_enabling_attestation_without_real_values_is_a_plan_time_error():
    api_block = LAMBDA_TF[LAMBDA_TF.index('resource "aws_lambda_function" "api"') : LAMBDA_TF.index('resource "aws_lambda_function" "notification_dispatcher"')]

    assert "precondition" in api_block
    assert "var.attestation_enabled" in api_block and "appcheck_project_number" in api_block and "appcheck_app_id" in api_block


def test_the_environment_is_added_only_when_enabled_and_uses_the_names_the_code_reads():
    locals_block = LAMBDA_TF[LAMBDA_TF.index("attestation_environment") :]
    names = set(re.findall(r"\b(YOBI_ATTESTATION_MODE|APPCHECK_[A-Z_]+)\b", locals_block))

    assert "var.attestation_enabled ?" in locals_block and "} : {}" in locals_block
    assert names == {
        "YOBI_ATTESTATION_MODE",
        "APPCHECK_PROJECT_NUMBER",
        "APPCHECK_APP_ID",
        "APPCHECK_JWKS_REFRESH_SECONDS",
        "APPCHECK_JWKS_GRACE_SECONDS",
    }
    source = (REPO / "src" / "api" / "attestation.py").read_text(encoding="utf-8")
    for name in names:
        assert f'"{name}"' in source, f"the code does not read {name}"


def test_the_mode_in_the_lambda_environment_is_never_a_literal():
    locals_block = LAMBDA_TF[LAMBDA_TF.index("attestation_environment") :]

    assert re.search(r"YOBI_ATTESTATION_MODE\s*=\s*var\.attestation_mode", locals_block)


def test_the_jwks_refresh_cannot_exceed_the_documented_six_hour_ceiling_and_defaults_match_the_code():
    refresh = _variable("appcheck_jwks_refresh_seconds")
    grace = _variable("appcheck_jwks_grace_seconds")

    assert "<= 21600" in refresh
    config = AttestationConfig()
    assert float(re.search(r"default\s*=\s*(\d+)", refresh).group(1)) == 10800 and config.refresh_interval_seconds == 10800
    assert float(re.search(r"default\s*=\s*(\d+)", grace).group(1)) == config.grace_seconds


def test_no_24_hour_token_ttl_is_frozen_anywhere_in_the_attestation_configuration():
    assert "ttl" not in _variable("attestation_mode").lower()
    for name in ("attestation_enabled", "attestation_mode", "appcheck_project_number", "appcheck_app_id"):
        assert "86400" not in _variable(name)
