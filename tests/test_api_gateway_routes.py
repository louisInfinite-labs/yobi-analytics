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
# The exact-set assertion below fails when this list goes stale in either direction. R7 (AWS Cost
# Recovery): GET /creators/{creatorId}/summary -- the one entry this set used to carry -- was removed
# entirely (handler and all), so this is empty rather than deleted: a future dead handler should still
# be caught here, not silently exempted.
_HANDLERS_WITHOUT_GATEWAY_ROUTE: set[str] = set()


def test_every_api_gateway_route_has_a_handler():
    assert _terraform_routes() <= set(api_handler._ROUTES)


def test_every_handler_route_has_a_gateway_route_except_the_ones_without_one():
    assert set(api_handler._ROUTES) - _terraform_routes() == _HANDLERS_WITHOUT_GATEWAY_ROUTE


def test_dashboard_routes_are_wired():
    routes = _terraform_routes()

    assert {"GET /dashboard/chart-catalog", "GET /dashboard/comparison-items", "GET /dashboard/comparison-data"} <= routes


def test_topics_route_is_wired():
    assert "GET /topics" in _terraform_routes()


# --- R7 (AWS Cost Recovery): zero-consumer routes must no longer be exposed --


def test_removed_leaderboard_and_summary_routes_are_no_longer_exposed():
    routes = _terraform_routes()

    assert "GET /organizations/{organization}/leaderboard" not in routes
    assert "GET /leaderboard" not in routes
    assert "GET /topics/{topic}/leaderboard" not in routes
    assert "GET /creators/{creatorId}/summary" not in routes
    assert "GET /creators/{creatorId}/summary" not in api_handler._ROUTES
