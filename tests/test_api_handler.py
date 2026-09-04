import base64
import json

import pytest

import api_handler
import heartbeat_api
import heartbeat_store
import notification_dispatch
import push_sender
import read_api
import remote_config_api
import remote_config_store
from api_handler import lambda_handler


def _event(route_key, *, query=None, path=None, body=None, is_base64=False, headers=None):
    return {
        "routeKey": route_key,
        "queryStringParameters": query,
        "pathParameters": path,
        "body": body,
        "isBase64Encoded": is_base64,
        "headers": headers or {},
    }


def _body(payload):
    return json.loads(payload["body"])


# --- routing ------------------------------------------------------------


def test_unknown_route_returns_404():
    response = lambda_handler(_event("GET /no-such-route"), None)

    assert response["statusCode"] == 404
    assert "No such route" in _body(response)["error"]


# --- GET /videos/{videoId}/growth ----------------------------------------


def test_get_video_growth_returns_200_with_the_read_api_response(monkeypatch):
    monkeypatch.setattr(read_api, "get_video_growth", lambda query: {"videoId": query["videoId"], "status": "ok"})

    response = lambda_handler(
        _event("GET /videos/{videoId}/growth", query={"reportDate": "2026-09-01"}, path={"videoId": "v1"}), None
    )

    assert response["statusCode"] == 200
    assert _body(response) == {"videoId": "v1", "status": "ok"}


def test_get_video_growth_maps_video_not_found_to_404(monkeypatch):
    def _boom(query):
        raise read_api.VideoNotFoundError("no such video")

    monkeypatch.setattr(read_api, "get_video_growth", _boom)

    response = lambda_handler(_event("GET /videos/{videoId}/growth", path={"videoId": "no_such"}), None)

    assert response["statusCode"] == 404
    assert _body(response)["error"] == "no such video"


def test_get_video_growth_maps_client_error_to_400(monkeypatch):
    def _boom(query):
        raise read_api.ClientError("bad reportDate")

    monkeypatch.setattr(read_api, "get_video_growth", _boom)

    response = lambda_handler(_event("GET /videos/{videoId}/growth", path={"videoId": "v1"}), None)

    assert response["statusCode"] == 400
    assert _body(response)["error"] == "bad reportDate"


def test_path_parameters_take_precedence_over_same_named_query_parameters(monkeypatch):
    captured = {}

    def _capture(query):
        captured.update(query)
        return {}

    monkeypatch.setattr(read_api, "get_video_growth", _capture)

    lambda_handler(
        _event("GET /videos/{videoId}/growth", query={"videoId": "from_query"}, path={"videoId": "from_path"}), None
    )

    assert captured["videoId"] == "from_path"


def test_an_unexpected_exception_returns_500_without_leaking_details(monkeypatch):
    def _boom(query):
        raise RuntimeError("something internal broke")

    monkeypatch.setattr(read_api, "get_video_growth", _boom)

    response = lambda_handler(_event("GET /videos/{videoId}/growth", path={"videoId": "v1"}), None)

    assert response["statusCode"] == 500
    assert "something internal broke" not in _body(response)["error"]


# --- GET /creators/{creatorId}/trending & /organizations/{organization}/trending ----


def test_get_creator_trending_returns_200(monkeypatch):
    monkeypatch.setattr(read_api, "get_creator_trending", lambda query: {"creatorId": query["creatorId"]})

    response = lambda_handler(
        _event("GET /creators/{creatorId}/trending", query={"period": "7d"}, path={"creatorId": "c1"}), None
    )

    assert response["statusCode"] == 200
    assert _body(response) == {"creatorId": "c1"}


def test_get_organization_trending_returns_200(monkeypatch):
    monkeypatch.setattr(read_api, "get_organization_trending", lambda query: {"organization": query["organization"]})

    response = lambda_handler(
        _event("GET /organizations/{organization}/trending", path={"organization": "vspo"}), None
    )

    assert response["statusCode"] == 200
    assert _body(response) == {"organization": "vspo"}


# --- POST /heartbeat ------------------------------------------------------


def test_post_heartbeat_persists_the_record_and_returns_it(monkeypatch):
    stored = {}
    monkeypatch.setattr(
        heartbeat_api, "record_heartbeat", lambda body: {"clientId": body["clientId"], "lastSeenAt": "t", "appVersion": "1.0"}
    )
    monkeypatch.setattr(heartbeat_store, "put_heartbeat", lambda record: stored.update(record))

    response = lambda_handler(
        _event("POST /heartbeat", body=json.dumps({"clientId": "c1", "appVersion": "1.0"})), None
    )

    assert response["statusCode"] == 200
    assert _body(response) == {"clientId": "c1", "lastSeenAt": "t", "appVersion": "1.0"}
    assert stored == {"clientId": "c1", "lastSeenAt": "t", "appVersion": "1.0"}


def test_post_heartbeat_rejects_a_malformed_body(monkeypatch):
    def _boom(record):
        raise AssertionError("should never persist a rejected heartbeat")

    monkeypatch.setattr(heartbeat_store, "put_heartbeat", _boom)

    response = lambda_handler(_event("POST /heartbeat", body=json.dumps({"appVersion": "1.0"})), None)

    assert response["statusCode"] == 400


def test_post_heartbeat_decodes_a_base64_body(monkeypatch):
    monkeypatch.setattr(
        heartbeat_api, "record_heartbeat", lambda body: {"clientId": body["clientId"], "lastSeenAt": "t", "appVersion": "1.0"}
    )
    monkeypatch.setattr(heartbeat_store, "put_heartbeat", lambda record: None)
    encoded = base64.b64encode(json.dumps({"clientId": "c1", "appVersion": "1.0"}).encode("utf-8")).decode("ascii")

    response = lambda_handler(_event("POST /heartbeat", body=encoded, is_base64=True), None)

    assert response["statusCode"] == 200


def test_post_heartbeat_rejects_non_json_body():
    response = lambda_handler(_event("POST /heartbeat", body="not json"), None)

    assert response["statusCode"] == 400


def test_post_heartbeat_rejects_a_non_object_json_body():
    response = lambda_handler(_event("POST /heartbeat", body=json.dumps([1, 2, 3])), None)

    assert response["statusCode"] == 400


@pytest.mark.parametrize("body", ['{"clientId": NaN}', '{"clientId": Infinity}', '{"clientId": -Infinity}'])
def test_a_body_with_a_non_standard_json_constant_is_rejected_as_malformed(body):
    """json.loads accepts NaN/Infinity/-Infinity as a non-standard extension;
    reject them as a clean 400 rather than letting a non-finite float reach
    a handler (see api_handler._reject_json_constant)."""
    response = lambda_handler(_event("POST /heartbeat", body=body), None)

    assert response["statusCode"] == 400


# --- GET /heartbeat/{clientId}/status --------------------------------------


def test_get_heartbeat_status_returns_the_stored_status(monkeypatch):
    monkeypatch.setattr(heartbeat_store, "get_heartbeat", lambda client_id: {"lastSeenAt": "t", "appVersion": "1.0"})
    monkeypatch.setattr(heartbeat_api, "online_status", lambda last_seen_at: "online")

    response = lambda_handler(_event("GET /heartbeat/{clientId}/status", path={"clientId": "c1"}), None)

    assert response["statusCode"] == 200
    assert _body(response) == {"clientId": "c1", "status": "online", "lastSeenAt": "t", "appVersion": "1.0"}


def test_get_heartbeat_status_for_an_unknown_client_returns_400(monkeypatch):
    monkeypatch.setattr(heartbeat_store, "get_heartbeat", lambda client_id: None)

    response = lambda_handler(_event("GET /heartbeat/{clientId}/status", path={"clientId": "no_such"}), None)

    assert response["statusCode"] == 400


# --- POST /remote-config ----------------------------------------------------


@pytest.fixture
def admin_key(monkeypatch):
    """Configure the admin API key so admin-protected route tests can supply a matching header."""
    monkeypatch.setenv("YOBI_ADMIN_API_KEY", "s3cret")
    return "s3cret"


def test_post_remote_config_persists_the_record_and_returns_it(monkeypatch, admin_key):
    stored = {}
    monkeypatch.setattr(
        remote_config_api,
        "write_remote_config",
        lambda body: {"clientId": body["clientId"], "key": body["key"], "value": body["value"], "updatedAt": "t"},
    )
    monkeypatch.setattr(remote_config_store, "put_remote_config", lambda record: stored.update(record))

    response = lambda_handler(
        _event(
            "POST /remote-config",
            body=json.dumps({"clientId": "c1", "key": "enabled", "value": True}),
            headers={"x-admin-key": admin_key},
        ),
        None,
    )

    assert response["statusCode"] == 200
    assert _body(response) == {"clientId": "c1", "key": "enabled", "value": True, "updatedAt": "t"}
    assert stored["clientId"] == "c1"


def test_post_remote_config_rejects_a_malformed_body(monkeypatch, admin_key):
    def _boom(record):
        raise AssertionError("should never persist a rejected write")

    monkeypatch.setattr(remote_config_store, "put_remote_config", _boom)

    response = lambda_handler(
        _event("POST /remote-config", body=json.dumps({"clientId": "c1"}), headers={"x-admin-key": admin_key}), None
    )

    assert response["statusCode"] == 400


def test_post_remote_config_without_an_admin_key_header_returns_403(monkeypatch, admin_key):
    def _boom(*a, **kw):
        raise AssertionError("should never reach a handler without a valid admin key")

    monkeypatch.setattr(remote_config_api, "write_remote_config", _boom)

    response = lambda_handler(_event("POST /remote-config", body=json.dumps({"clientId": "c1"})), None)

    assert response["statusCode"] == 403


def test_post_remote_config_with_a_wrong_admin_key_returns_403(monkeypatch, admin_key):
    def _boom(*a, **kw):
        raise AssertionError("should never reach a handler with an invalid admin key")

    monkeypatch.setattr(remote_config_api, "write_remote_config", _boom)

    response = lambda_handler(
        _event("POST /remote-config", body=json.dumps({"clientId": "c1"}), headers={"x-admin-key": "wrong"}), None
    )

    assert response["statusCode"] == 403


def test_post_remote_config_with_a_non_ascii_admin_key_header_returns_403_not_500(monkeypatch, admin_key):
    """hmac.compare_digest raises TypeError on a non-ASCII str; the admin-key
    check must stay byte-safe so a malformed header can't turn into an
    unhandled 500 instead of a clean 403."""
    monkeypatch.setattr(remote_config_api, "write_remote_config", lambda body: (_ for _ in ()).throw(AssertionError))

    response = lambda_handler(
        _event("POST /remote-config", body=json.dumps({"clientId": "c1"}), headers={"x-admin-key": "wröng"}), None
    )

    assert response["statusCode"] == 403


def test_post_remote_config_admin_key_check_is_case_insensitive_on_header_name(monkeypatch, admin_key):
    monkeypatch.setattr(
        remote_config_api,
        "write_remote_config",
        lambda body: {"clientId": body["clientId"], "key": body["key"], "value": body["value"], "updatedAt": "t"},
    )
    monkeypatch.setattr(remote_config_store, "put_remote_config", lambda record: None)

    response = lambda_handler(
        _event(
            "POST /remote-config",
            body=json.dumps({"clientId": "c1", "key": "enabled", "value": True}),
            headers={"X-Admin-Key": admin_key},
        ),
        None,
    )

    assert response["statusCode"] == 200


def test_post_remote_config_returns_503_when_admin_key_is_not_configured(monkeypatch):
    def _boom(*a, **kw):
        raise AssertionError("should never reach a handler when the admin key itself isn't configured")

    monkeypatch.setattr(remote_config_api, "write_remote_config", _boom)
    monkeypatch.delenv("YOBI_ADMIN_API_KEY", raising=False)

    response = lambda_handler(
        _event("POST /remote-config", body=json.dumps({"clientId": "c1"}), headers={"x-admin-key": "anything"}), None
    )

    assert response["statusCode"] == 503


def test_post_heartbeat_does_not_require_an_admin_key(monkeypatch):
    """POST /heartbeat is a client reporting its own state, not authoring config
    for another client — it must stay open with no admin key configured."""
    monkeypatch.setattr(
        heartbeat_api, "record_heartbeat", lambda body: {"clientId": body["clientId"], "lastSeenAt": "t", "appVersion": "1.0"}
    )
    monkeypatch.setattr(heartbeat_store, "put_heartbeat", lambda record: None)
    monkeypatch.delenv("YOBI_ADMIN_API_KEY", raising=False)

    response = lambda_handler(
        _event("POST /heartbeat", body=json.dumps({"clientId": "c1", "appVersion": "1.0"})), None
    )

    assert response["statusCode"] == 200


# --- GET /remote-config ------------------------------------------------------


def test_get_remote_config_with_a_key_returns_a_single_item_list(monkeypatch):
    monkeypatch.setattr(
        remote_config_store,
        "get_remote_config",
        lambda client_id, key: {"clientId": client_id, "key": key, "value": True, "updatedAt": "t"},
    )

    response = lambda_handler(_event("GET /remote-config", query={"clientId": "c1", "key": "enabled"}), None)

    assert response["statusCode"] == 200
    assert _body(response) == {
        "clientId": "c1",
        "configs": [{"clientId": "c1", "key": "enabled", "value": True, "updatedAt": "t"}],
    }


def test_get_remote_config_with_an_unset_key_returns_an_empty_list(monkeypatch):
    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: None)

    response = lambda_handler(_event("GET /remote-config", query={"clientId": "c1", "key": "enabled"}), None)

    assert response["statusCode"] == 200
    assert _body(response) == {"clientId": "c1", "configs": []}


def test_get_remote_config_without_a_key_returns_every_stored_key(monkeypatch):
    monkeypatch.setattr(
        remote_config_store,
        "list_remote_config",
        lambda client_id: [{"clientId": client_id, "key": "enabled", "value": True, "updatedAt": "t"}],
    )

    response = lambda_handler(_event("GET /remote-config", query={"clientId": "c1"}), None)

    assert response["statusCode"] == 200
    assert _body(response)["configs"] == [{"clientId": "c1", "key": "enabled", "value": True, "updatedAt": "t"}]


def test_get_remote_config_without_a_key_excludes_the_push_subscription_entry(monkeypatch):
    """A generic 'every stored key' read is reachable by anyone who knows a
    clientId (self-service, no admin key) — it must not hand back the Web
    Push subscription's own endpoint/encryption material alongside it."""
    monkeypatch.setattr(
        remote_config_store,
        "list_remote_config",
        lambda client_id: [
            {"clientId": client_id, "key": "enabled", "value": True, "updatedAt": "t"},
            {
                "clientId": client_id,
                "key": "pushSubscription",
                "value": {"endpoint": "https://fcm.googleapis.com/x", "keys": {"p256dh": "k", "auth": "a"}},
                "updatedAt": "t",
            },
        ],
    )

    response = lambda_handler(_event("GET /remote-config", query={"clientId": "c1"}), None)

    assert response["statusCode"] == 200
    configs = _body(response)["configs"]
    assert [record["key"] for record in configs] == ["enabled"]


def test_get_remote_config_with_an_explicit_push_subscription_key_still_returns_it(monkeypatch):
    monkeypatch.setattr(
        remote_config_store,
        "get_remote_config",
        lambda client_id, key: {"clientId": client_id, "key": key, "value": {"endpoint": "https://fcm.googleapis.com/x"}, "updatedAt": "t"},
    )

    response = lambda_handler(_event("GET /remote-config", query={"clientId": "c1", "key": "pushSubscription"}), None)

    assert response["statusCode"] == 200
    assert _body(response)["configs"][0]["key"] == "pushSubscription"


def test_get_remote_config_rejects_a_missing_client_id():
    response = lambda_handler(_event("GET /remote-config", query={}), None)

    assert response["statusCode"] == 400


# --- PUT/DELETE /clients/{clientId}/push-subscription (self-service, no admin key) ---


def _subscription_body():
    return {"endpoint": "https://fcm.googleapis.com/fcm/send/abc", "keys": {"p256dh": "p256dh-key", "auth": "auth-key"}}


def test_put_push_subscription_does_not_require_an_admin_key(monkeypatch):
    stored = {}
    monkeypatch.setattr(remote_config_store, "put_remote_config", lambda record: stored.update(record))
    monkeypatch.delenv("YOBI_ADMIN_API_KEY", raising=False)

    response = lambda_handler(
        _event("PUT /clients/{clientId}/push-subscription", path={"clientId": "c1"}, body=json.dumps(_subscription_body())),
        None,
    )

    assert response["statusCode"] == 200
    assert stored["clientId"] == "c1"
    assert stored["key"] == "pushSubscription"
    assert stored["value"]["endpoint"] == _subscription_body()["endpoint"]


def test_put_push_subscription_rejects_a_malformed_subscription(monkeypatch):
    def _boom(record):
        raise AssertionError("should never persist an invalid subscription")

    monkeypatch.setattr(remote_config_store, "put_remote_config", _boom)

    response = lambda_handler(
        _event("PUT /clients/{clientId}/push-subscription", path={"clientId": "c1"}, body=json.dumps({"endpoint": "not-https"})),
        None,
    )

    assert response["statusCode"] == 400


def test_delete_push_subscription_does_not_require_an_admin_key(monkeypatch):
    deleted = {}
    monkeypatch.setattr(remote_config_store, "delete_remote_config", lambda client_id, key: deleted.update(clientId=client_id, key=key))
    monkeypatch.delenv("YOBI_ADMIN_API_KEY", raising=False)

    response = lambda_handler(_event("DELETE /clients/{clientId}/push-subscription", path={"clientId": "c1"}), None)

    assert response["statusCode"] == 200
    assert deleted == {"clientId": "c1", "key": "pushSubscription"}


# --- PUT /clients/{clientId}/notification-preference (self-service, no admin key) ---


def _preference_body():
    return {
        "enabled": True,
        "notificationLevel": "all",
        "notificationTimeZone": "Asia/Tokyo",
        "deliveryWindows": ["08:00", "18:00"],
    }


def test_put_notification_preference_does_not_require_an_admin_key(monkeypatch):
    stored = {}
    monkeypatch.setattr(remote_config_store, "put_remote_config", lambda record: stored.update(record))
    monkeypatch.delenv("YOBI_ADMIN_API_KEY", raising=False)

    response = lambda_handler(
        _event(
            "PUT /clients/{clientId}/notification-preference",
            path={"clientId": "c1"},
            body=json.dumps(_preference_body()),
        ),
        None,
    )

    assert response["statusCode"] == 200
    assert stored["clientId"] == "c1"
    assert stored["key"] == "notificationPreference"
    assert stored["value"]["enabled"] is True


def test_put_notification_preference_rejects_a_malformed_preference(monkeypatch):
    def _boom(record):
        raise AssertionError("should never persist an invalid preference")

    monkeypatch.setattr(remote_config_store, "put_remote_config", _boom)

    response = lambda_handler(
        _event(
            "PUT /clients/{clientId}/notification-preference",
            path={"clientId": "c1"},
            body=json.dumps({"enabled": "not-a-bool"}),
        ),
        None,
    )

    assert response["statusCode"] == 400


# --- GET /admin/heartbeat-stats (admin-protected) ---


def test_get_admin_heartbeat_stats_requires_an_admin_key(monkeypatch, admin_key):
    monkeypatch.setattr(
        heartbeat_store,
        "list_all",
        lambda: [
            {"clientId": "c1", "lastSeenAt": "2026-09-03T00:00:00+00:00"},
            {"clientId": "c2", "lastSeenAt": "2020-01-01T00:00:00+00:00"},
        ],
    )
    monkeypatch.setattr(heartbeat_api, "online_status", lambda last_seen_at: "online" if last_seen_at.startswith("2026") else "offline")

    response = lambda_handler(_event("GET /admin/heartbeat-stats", headers={"x-admin-key": admin_key}), None)

    assert response["statusCode"] == 200
    assert _body(response) == {"totalClients": 2, "onlineNow": 1}


def test_get_admin_heartbeat_stats_without_admin_key_returns_403(monkeypatch, admin_key):
    def _boom():
        raise AssertionError("should never scan heartbeats without a valid admin key")

    monkeypatch.setattr(heartbeat_store, "list_all", _boom)

    response = lambda_handler(_event("GET /admin/heartbeat-stats"), None)

    assert response["statusCode"] == 403
