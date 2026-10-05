"""SEC-API-005 (roadmap MT-23A): the /live-streams protection parameters are Terraform-configurable and match the code.

The Terraform variable defaults must equal the in-code defaults (so an unset value behaves identically), every variable
must reach the API Lambda environment under the exact name the policy reads, and the parameters must stay variables.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from api.live_streams_protection import ProtectionConfig

pytestmark = pytest.mark.security

TERRAFORM = Path(__file__).resolve().parents[2] / "terraform"
VARIABLES_TF = (TERRAFORM / "variables.tf").read_text(encoding="utf-8")
LAMBDA_TF = (TERRAFORM / "lambda.tf").read_text(encoding="utf-8")
POLICY_PY = (Path(__file__).resolve().parents[2] / "src" / "api" / "live_streams_protection.py").read_text(encoding="utf-8")

# env var name -> (terraform variable, ProtectionConfig field)
PARAMETERS = {
    "LIVE_STREAMS_REFRESH_WINDOW_SECONDS": ("live_streams_refresh_window_seconds", "refresh_window_seconds"),
    "LIVE_STREAMS_MAX_STALE_SECONDS": ("live_streams_max_stale_seconds", "max_stale_seconds"),
    "LIVE_STREAMS_COOLDOWN_BASE_SECONDS": ("live_streams_cooldown_base_seconds", "cooldown_base_seconds"),
    "LIVE_STREAMS_COOLDOWN_MAX_SECONDS": ("live_streams_cooldown_max_seconds", "cooldown_max_seconds"),
    "LIVE_STREAMS_RETRY_ATTEMPTS": ("live_streams_retry_attempts", "retry_attempts"),
    "LIVE_STREAMS_RETRY_BACKOFF_SECONDS": ("live_streams_retry_backoff_seconds", "retry_backoff_base_seconds"),
    "LIVE_STREAMS_REFRESH_DEADLINE_SECONDS": ("live_streams_refresh_deadline_seconds", "refresh_deadline_seconds"),
}


def _api_block() -> str:
    start = LAMBDA_TF.index('resource "aws_lambda_function" "api"')
    end = LAMBDA_TF.find('\nresource "', start + 10)
    return LAMBDA_TF[start : end if end != -1 else len(LAMBDA_TF)]


def _variable_default(name: str) -> float:
    block = VARIABLES_TF[VARIABLES_TF.index(f'variable "{name}"') :]
    match = re.search(r"default\s*=\s*([0-9.]+)", block)
    assert match, name
    return float(match.group(1))


@pytest.mark.parametrize("env_name", sorted(PARAMETERS))
def test_each_parameter_reaches_the_api_lambda_from_its_variable(env_name):
    variable, _ = PARAMETERS[env_name]

    assert re.search(rf"{env_name}\s*=\s*tostring\(var\.{variable}\)", _api_block()), env_name


@pytest.mark.parametrize("env_name", sorted(PARAMETERS))
def test_each_environment_name_is_the_one_the_policy_reads(env_name):
    assert f'"{env_name}"' in POLICY_PY


@pytest.mark.parametrize("env_name", sorted(PARAMETERS))
def test_each_terraform_default_equals_the_in_code_default(env_name):
    variable, field = PARAMETERS[env_name]

    assert _variable_default(variable) == float(getattr(ProtectionConfig(), field))


def test_every_live_streams_variable_in_terraform_is_wired_and_known():
    declared = set(re.findall(r'variable "(live_streams_[a-z_]+)"', VARIABLES_TF))

    assert declared == {variable for variable, _ in PARAMETERS.values()}


def test_no_live_streams_parameter_is_a_hard_coded_literal_in_the_lambda_block():
    for line in _api_block().splitlines():
        if line.strip().startswith("LIVE_STREAMS_"):
            assert "var." in line, f"parameter must come from a variable: {line.strip()}"
