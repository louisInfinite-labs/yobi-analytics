"""SEC-API-003 (launch scope): the per-route throttle structure (roadmap MT-14, stage 1).

Rate (sustained average) and burst (one-wave capacity) are two separate parameters. The values checked here are the
provisional formula-derived launch values; stage 2 replaces them with access-log evidence and keeps these invariants.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from .route_inventory import ADMIN_ROUTES, LAUNCH_THROTTLED_ROUTES, ROUTE_CLASSES

pytestmark = pytest.mark.security

TERRAFORM = Path(__file__).resolve().parents[2] / "terraform"
API_GATEWAY_TF = (TERRAFORM / "api_gateway.tf").read_text(encoding="utf-8")
VARIABLES_TF = (TERRAFORM / "variables.tf").read_text(encoding="utf-8")

STAGE_DEFAULT_RATE = 10  # the stage-wide default; no route may be configured above the whole-stage ceiling
BURST_CEILING = 100  # N_sync bound of the sizing model (a whole design audience acting at once)


def _throttles() -> dict[str, tuple[int, int]]:
    variable = VARIABLES_TF[VARIABLES_TF.index('variable "launch_route_throttles"') :]
    default = re.search(r"default\s*=\s*\{(.*?)\n  \}", variable, re.DOTALL)
    assert default is not None, "launch_route_throttles default map not found"
    return {
        route: (int(rate), int(burst))
        for route, rate, burst in re.findall(r'"([^"]+)"\s*=\s*\{\s*rate\s*=\s*(\d+),\s*burst\s*=\s*(\d+)\s*\}', default.group(1))
    }


def test_the_launch_route_set_is_exactly_the_classified_launch_routes():
    assert set(_throttles()) == LAUNCH_THROTTLED_ROUTES


def test_every_throttled_route_is_a_real_classified_route():
    assert set(_throttles()) <= set(ROUTE_CLASSES)


def test_each_route_has_an_explicit_rate_and_an_explicit_burst_that_are_not_the_stage_default_pair():
    for route, (rate, burst) in _throttles().items():
        assert rate >= 1 and burst >= rate, route
        assert (rate, burst) != (10, 20), f"{route} must not silently inherit the stage default"


def test_rates_and_bursts_stay_inside_the_documented_formula_ranges():
    for route, (rate, burst) in _throttles().items():
        assert rate <= STAGE_DEFAULT_RATE, f"{route}: sustained rate above the stage ceiling"
        assert burst <= BURST_CEILING, f"{route}: burst above the whole-audience wave bound"


def test_write_and_admin_routes_use_the_abuse_ceiling_for_sustained_rate():
    values = _throttles()
    for route in ADMIN_ROUTES | {"POST /clients/{clientId}/credential"}:
        assert values[route][0] == 1, f"{route} sustained rate must be the abuse ceiling"


def test_admin_routes_have_the_floor_burst():
    values = _throttles()
    for route in ADMIN_ROUTES:
        assert values[route][1] <= 5


def test_the_stage_applies_rate_and_burst_per_route_from_the_variable():
    assert 'dynamic "route_settings"' in API_GATEWAY_TF
    assert "for_each = var.launch_route_throttles" in API_GATEWAY_TF
    assert "throttling_rate_limit  = route_settings.value.rate" in API_GATEWAY_TF
    assert "throttling_burst_limit = route_settings.value.burst" in API_GATEWAY_TF


def test_the_stage_default_remains_as_the_safety_net_for_unlisted_routes():
    assert re.search(r"default_route_settings\s*\{[^}]*throttling_rate_limit\s*=\s*10", API_GATEWAY_TF)
