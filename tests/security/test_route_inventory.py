"""SEC-TEST-001 (launch scope, part 1): every route is classified, and each class matches how the handler really enforces it.

Fails on any Terraform / handler route that is not in tests/security/route_inventory.py, and on any stale entry there.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

from api import api_handler

from .route_inventory import (
    ADMIN,
    ADMIN_ROUTES,
    ATTESTED_ROUTES,
    CLIENT_SCOPED,
    CLIENT_SCOPED_ROUTES,
    RETIRED,
    ROUTE_CLASSES,
    routes_in_class,
)

pytestmark = pytest.mark.security

REPO = Path(__file__).resolve().parents[2]
API_GATEWAY_TF = REPO / "terraform" / "api_gateway.tf"
API_HANDLER_PY = REPO / "src" / "api" / "api_handler.py"


def _terraform_routes() -> set[str]:
    block = re.search(r"api_routes\s*=\s*\[(.*?)\]", API_GATEWAY_TF.read_text(encoding="utf-8"), re.DOTALL)
    assert block is not None, "api_routes list not found in api_gateway.tf"
    return set(re.findall(r'"((?:GET|POST|PUT|DELETE) [^"]+)"', block.group(1)))


def test_every_terraform_route_is_classified_and_no_classification_is_stale():
    terraform = _terraform_routes()

    assert terraform - set(ROUTE_CLASSES) == set(), "unclassified routes: add them to route_inventory.py"
    assert set(ROUTE_CLASSES) - terraform == set(), "stale classification entries (route no longer in Terraform)"


def test_every_handler_route_is_classified_and_no_classification_is_stale():
    handler_routes = set(api_handler._ROUTES) | set(api_handler._RETIRED_ROUTES)

    assert handler_routes - set(ROUTE_CLASSES) == set()
    assert set(ROUTE_CLASSES) - handler_routes == set()


def test_the_retired_class_is_exactly_the_handlers_retired_routes():
    assert routes_in_class(RETIRED) == set(api_handler._RETIRED_ROUTES)


def test_the_admin_class_is_exactly_the_handlers_admin_protected_routes():
    assert ADMIN_ROUTES == set(api_handler._ADMIN_PROTECTED_ROUTES)


def _functions_calling_require_client_secret() -> set[str]:
    tree = ast.parse(API_HANDLER_PY.read_text(encoding="utf-8"))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef):
            for call in ast.walk(node):
                if isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and call.func.id == "_require_client_secret":
                    names.add(node.name)
    return names


def test_a_route_is_client_scoped_exactly_when_its_handler_requires_the_client_secret():
    enforcing = _functions_calling_require_client_secret()
    by_handler = {route: handler.__name__ for route, handler in api_handler._ROUTES.items()}

    declared = {route for route, name in by_handler.items() if name in enforcing}

    assert declared == CLIENT_SCOPED_ROUTES, "classification and the handler's client-secret enforcement disagree"


def test_every_route_class_is_one_of_the_known_classes():
    known = {"retired", "public_read", "public_liveness", "client_bootstrap", CLIENT_SCOPED, ADMIN}

    assert set(ROUTE_CLASSES.values()) <= known


def test_at_launch_every_route_except_the_retired_410s_is_attested():
    assert ATTESTED_ROUTES == set(ROUTE_CLASSES) - set(api_handler._RETIRED_ROUTES)
    assert ATTESTED_ROUTES, "the attested set must not be empty"
