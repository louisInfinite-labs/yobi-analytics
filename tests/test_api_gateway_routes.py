import re
from pathlib import Path

from api import api_handler

API_GATEWAY_TF = Path(__file__).parent.parent / "terraform" / "api_gateway.tf"


def _terraform_routes() -> set[str]:
    block = re.search(r"api_routes\s*=\s*\[(.*?)\]", API_GATEWAY_TF.read_text(encoding="utf-8"), re.DOTALL)
    assert block is not None, "api_routes list not found in api_gateway.tf"
    return set(re.findall(r'"((?:GET|POST|PUT|DELETE) [^"]+)"', block.group(1)))


# Handlers registered in api_handler with no API Gateway route. Nothing in the repo (docs, callers,
# tests, deploy probes) says whether they are meant to be public, so exposure is an open owner decision.
# The exact-set assertion below fails when this list goes stale in either direction.
_HANDLERS_WITHOUT_GATEWAY_ROUTE = {
    "GET /creators/{creatorId}/summary",
}


def test_every_api_gateway_route_has_a_handler():
    assert _terraform_routes() <= set(api_handler._ROUTES)


def test_every_handler_route_has_a_gateway_route_except_the_one_without_one():
    assert set(api_handler._ROUTES) - _terraform_routes() == _HANDLERS_WITHOUT_GATEWAY_ROUTE


def test_dashboard_routes_are_wired():
    routes = _terraform_routes()

    assert {"GET /dashboard/chart-catalog", "GET /dashboard/comparison-items", "GET /dashboard/comparison-data"} <= routes


def test_leaderboard_routes_are_wired():
    routes = _terraform_routes()

    assert {"GET /organizations/{organization}/leaderboard", "GET /leaderboard"} <= routes


def test_topics_route_is_wired():
    assert "GET /topics" in _terraform_routes()
