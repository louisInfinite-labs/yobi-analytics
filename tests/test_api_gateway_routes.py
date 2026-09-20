import re
from pathlib import Path

import api_handler

API_GATEWAY_TF = Path(__file__).parent.parent / "terraform" / "api_gateway.tf"


def _terraform_routes() -> set[str]:
    block = re.search(r"api_routes\s*=\s*\[(.*?)\]", API_GATEWAY_TF.read_text(encoding="utf-8"), re.DOTALL)
    assert block is not None, "api_routes list not found in api_gateway.tf"
    return set(re.findall(r'"((?:GET|POST|PUT|DELETE) [^"]+)"', block.group(1)))


def test_every_handler_route_is_configured_in_api_gateway_and_vice_versa():
    assert _terraform_routes() == set(api_handler._ROUTES)


def test_dashboard_routes_are_wired():
    routes = _terraform_routes()

    assert {"GET /dashboard/chart-catalog", "GET /dashboard/comparison-items", "GET /dashboard/comparison-data"} <= routes
