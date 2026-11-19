"""The API never clears an inactive push-subscription marker with the SAME dead endpoint (so "inactive" cannot silently become "healthy").

Stage A of the release (API Lambda) is tested with this module alone: it needs only the API code and the remote-config store, none of the dispatcher modules.
"""

from __future__ import annotations

import json

import pytest

from api import api_handler, client_credential_api
from stores import client_credential_store, remote_config_store

SUBSCRIPTION = {"endpoint": "https://web.push.apple.com/abc", "keys": {"p256dh": "k", "auth": "a"}}
@pytest.fixture
def push_api(monkeypatch):
    """The real handler over an in-memory remote-config store with one registered client (c1) and its secret."""
    rows: dict[tuple[str, str], dict] = {}
    stored_hash = client_credential_api.hash_secret("c1-secret")
    monkeypatch.setattr(client_credential_store, "get_secret_hash", lambda client_id: stored_hash if client_id == "c1" else None)
    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: rows.get((client_id, key)))

    def put(record):
        """A PutItem replaces the WHOLE item, so any inactive marker is gone -- exactly like the real store."""
        rows[(record["clientId"], record["key"])] = {"clientId": record["clientId"], "key": record["key"], "value": record["value"], "updatedAt": record["updatedAt"]}

    monkeypatch.setattr(remote_config_store, "put_remote_config", put)
    return rows


def _put_subscription(endpoint: str, *, secret: str = "c1-secret") -> dict:
    """PUT /clients/c1/push-subscription through lambda_handler."""
    body = {"endpoint": endpoint, "keys": {"p256dh": "k", "auth": "a"}}
    event = {"routeKey": "PUT /clients/{clientId}/push-subscription", "pathParameters": {"clientId": "c1"}, "headers": {"x-client-secret": secret}, "body": json.dumps(body)}
    return api_handler.lambda_handler(event, None)


def test_the_same_endpoint_is_refused_while_it_is_marked_inactive_and_the_marker_stays(push_api):
    """409 with a stable code; nothing is written, so the marker (and the dispatcher's refusal to send to it) survives."""
    push_api[("c1", "pushSubscription")] = {"clientId": "c1", "key": "pushSubscription", "value": SUBSCRIPTION, "updatedAt": "t0", "inactiveAt": "2026-11-16T00:00:00+00:00", "inactiveReason": "push_service_http_410"}

    response = _put_subscription(SUBSCRIPTION["endpoint"])

    assert response["statusCode"] == 409 and json.loads(response["body"])["code"] == "SUBSCRIPTION_INACTIVE"
    assert push_api[("c1", "pushSubscription")]["inactiveAt"] == "2026-11-16T00:00:00+00:00" and push_api[("c1", "pushSubscription")]["updatedAt"] == "t0"


def test_a_different_endpoint_replaces_the_inactive_subscription_and_clears_the_marker(push_api):
    """The recovery path: a new subscription (new endpoint) is accepted, the whole item is replaced, the marker is gone."""
    push_api[("c1", "pushSubscription")] = {"clientId": "c1", "key": "pushSubscription", "value": SUBSCRIPTION, "updatedAt": "t0", "inactiveAt": "t", "inactiveReason": "r"}

    response = _put_subscription("https://web.push.apple.com/NEW-ENDPOINT")

    assert response["statusCode"] == 200
    assert push_api[("c1", "pushSubscription")]["value"]["endpoint"] == "https://web.push.apple.com/NEW-ENDPOINT" and "inactiveAt" not in push_api[("c1", "pushSubscription")]


def test_re_registering_the_same_endpoint_is_fine_while_it_is_active(push_api):
    """The guard applies to an INACTIVE record only: a healthy client re-sending its own subscription (every enable does) is unaffected."""
    push_api[("c1", "pushSubscription")] = {"clientId": "c1", "key": "pushSubscription", "value": SUBSCRIPTION, "updatedAt": "t0"}

    assert _put_subscription(SUBSCRIPTION["endpoint"])["statusCode"] == 200


def test_a_first_registration_and_a_wrong_secret_behave_as_before(push_api):
    """No stored record: created. Wrong secret: 403 before anything else, and the guard never reads the record for an unauthenticated caller."""
    assert _put_subscription(SUBSCRIPTION["endpoint"])["statusCode"] == 200
    assert _put_subscription(SUBSCRIPTION["endpoint"], secret="wrong")["statusCode"] == 403


def test_the_subscription_replacement_leaves_the_clients_other_records_untouched(push_api):
    """Recovery never costs the user their preferences or reminder settings: only the pushSubscription item is written."""
    push_api[("c1", "notificationPreference")] = {"clientId": "c1", "key": "notificationPreference", "value": {"enabled": True}, "updatedAt": "t"}
    push_api[("c1", "pushSubscription")] = {"clientId": "c1", "key": "pushSubscription", "value": SUBSCRIPTION, "updatedAt": "t0", "inactiveAt": "t", "inactiveReason": "r"}

    _put_subscription("https://web.push.apple.com/NEW-ENDPOINT")

    assert push_api[("c1", "notificationPreference")]["value"] == {"enabled": True}
