import re
from pathlib import Path

import api_handler

API_GATEWAY_TF = Path(__file__).parent.parent / "terraform" / "api_gateway.tf"


def _terraform_routes() -> set[str]:
    block = re.search(r"api_routes\s*=\s*\[(.*?)\]", API_GATEWAY_TF.read_text(encoding="utf-8"), re.DOTALL)
    assert block is not None, "api_routes list not found in api_gateway.tf"
    return set(re.findall(r'"((?:GET|POST|PUT|DELETE) [^"]+)"', block.group(1)))


# Handlers registered in api_handler that are intentionally not exposed through API Gateway yet.
# Exact-set assertion below: adding a route to Terraform (or a new unexposed handler) fails the test
# until this list is updated.
_HANDLERS_NOT_YET_EXPOSED = {
    "GET /creators/{creatorId}/summary",
    "GET /organizations/{organization}/leaderboard",
}


def test_every_api_gateway_route_has_a_handler():
    assert _terraform_routes() <= set(api_handler._ROUTES)


def test_every_handler_route_is_exposed_except_the_known_unexposed_ones():
    assert set(api_handler._ROUTES) - _terraform_routes() == _HANDLERS_NOT_YET_EXPOSED


def test_dashboard_routes_are_wired():
    routes = _terraform_routes()

    assert {"GET /dashboard/chart-catalog", "GET /dashboard/comparison-items", "GET /dashboard/comparison-data"} <= routes
