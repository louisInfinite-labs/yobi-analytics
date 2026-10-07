import base64
import json

import pytest

from api import api_handler
from api import client_credential_api
from stores import client_credential_store
from api import heartbeat_api
from stores import heartbeat_store
from api.holodex_client import HolodexAPIError
from api.holodex_normalization import HolodexNormalizationError
from notifications import notification_dispatch
from notifications import push_sender
from ops.config import MissingHolodexApiKeyError
from api import read_api
from api import remote_config_api
from stores import remote_config_store
from api.api_handler import lambda_handler


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


def test_post_heartbeat_rejects_malformed_base64_as_a_clean_400_not_500():
    """base64.b64decode raises binascii.Error (a ValueError) for bad
    padding; it must be caught by _json_body's own try block, not escape as
    an unhandled exception that lambda_handler's catch-all turns into a
    500 without the documented malformed-request response."""
    response = lambda_handler(_event("POST /heartbeat", body="not-valid-base64!!!", is_base64=True), None)

    assert response["statusCode"] == 400


def test_post_heartbeat_rejects_base64_that_decodes_to_non_utf8_bytes():
    non_utf8 = base64.b64encode(b"\xff\xfe\xfd").decode("ascii")

    response = lambda_handler(_event("POST /heartbeat", body=non_utf8, is_base64=True), None)

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


@pytest.fixture
def client_secret(monkeypatch):
    """Register a client secret for clientId 'c1' so client-scoped route tests can supply a matching X-Client-Secret header."""
    secret = "c1-secret"
    stored_hash = client_credential_api.hash_secret(secret)
    monkeypatch.setattr(
        client_credential_store, "get_secret_hash", lambda client_id: stored_hash if client_id == "c1" else None
    )
    return secret


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


# --- POST /clients/{clientId}/credential (registration; issues an X-Client-Secret) ---


def test_post_client_credential_issues_a_secret_and_persists_only_its_hash(monkeypatch):
    # No enrollment/attestation check before issuing — this is the
    # deliberate first-claimant trust model _handle_post_client_credential
    # documents, not a gap this test is meant to close.
    stored = {}
    monkeypatch.setattr(
        client_credential_store,
        "create_secret",
        lambda client_id, secret_hash: stored.update(clientId=client_id, secretHash=secret_hash) or True,
    )

    response = lambda_handler(_event("POST /clients/{clientId}/credential", path={"clientId": "c1"}), None)

    assert response["statusCode"] == 200
    body = _body(response)
    assert body["clientId"] == "c1"
    assert isinstance(body["clientSecret"], str) and len(body["clientSecret"]) > 20
    assert stored["clientId"] == "c1"
    # The stored value is a hash, not the raw secret returned to the caller.
    assert stored["secretHash"] != body["clientSecret"]
    assert stored["secretHash"] == client_credential_api.hash_secret(body["clientSecret"])


def test_post_client_credential_rejects_a_clientid_that_already_has_one(monkeypatch):
    monkeypatch.setattr(client_credential_store, "create_secret", lambda client_id, secret_hash: False)

    response = lambda_handler(_event("POST /clients/{clientId}/credential", path={"clientId": "c1"}), None)

    assert response["statusCode"] == 400


def test_post_client_credential_rejects_a_missing_client_id():
    response = lambda_handler(_event("POST /clients/{clientId}/credential", path={}), None)

    assert response["statusCode"] == 400


# --- GET /remote-config (client-scoped: requires X-Client-Secret) ------------


def test_get_remote_config_with_a_key_returns_a_single_item_list(monkeypatch, client_secret):
    monkeypatch.setattr(
        remote_config_store,
        "get_remote_config",
        lambda client_id, key: {"clientId": client_id, "key": key, "value": True, "updatedAt": "t"},
    )

    response = lambda_handler(
        _event("GET /remote-config", query={"clientId": "c1", "key": "enabled"}, headers={"x-client-secret": client_secret}),
        None,
    )

    assert response["statusCode"] == 200
    assert _body(response) == {
        "clientId": "c1",
        "configs": [{"clientId": "c1", "key": "enabled", "value": True, "updatedAt": "t"}],
    }


def test_get_remote_config_with_an_unset_key_returns_an_empty_list(monkeypatch, client_secret):
    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: None)

    response = lambda_handler(
        _event("GET /remote-config", query={"clientId": "c1", "key": "enabled"}, headers={"x-client-secret": client_secret}),
        None,
    )

    assert response["statusCode"] == 200
    assert _body(response) == {"clientId": "c1", "configs": []}


def test_get_remote_config_without_a_key_returns_every_stored_key(monkeypatch, client_secret):
    monkeypatch.setattr(
        remote_config_store,
        "list_remote_config",
        lambda client_id: [{"clientId": client_id, "key": "enabled", "value": True, "updatedAt": "t"}],
    )

    response = lambda_handler(
        _event("GET /remote-config", query={"clientId": "c1"}, headers={"x-client-secret": client_secret}), None
    )

    assert response["statusCode"] == 200
    assert _body(response)["configs"] == [{"clientId": "c1", "key": "enabled", "value": True, "updatedAt": "t"}]


def test_get_remote_config_without_a_key_excludes_the_push_subscription_entry(monkeypatch, client_secret):
    """A generic 'every stored key' read must not hand back the Web Push
    subscription's own endpoint/encryption material alongside it, even from
    the owning client itself (see api_handler._handle_get_remote_config)."""
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

    response = lambda_handler(
        _event("GET /remote-config", query={"clientId": "c1"}, headers={"x-client-secret": client_secret}), None
    )

    assert response["statusCode"] == 200
    configs = _body(response)["configs"]
    assert [record["key"] for record in configs] == ["enabled"]


def test_get_remote_config_with_an_explicit_push_subscription_key_still_returns_it(monkeypatch, client_secret):
    monkeypatch.setattr(
        remote_config_store,
        "get_remote_config",
        lambda client_id, key: {"clientId": client_id, "key": key, "value": {"endpoint": "https://fcm.googleapis.com/x"}, "updatedAt": "t"},
    )

    response = lambda_handler(
        _event(
            "GET /remote-config",
            query={"clientId": "c1", "key": "pushSubscription"},
            headers={"x-client-secret": client_secret},
        ),
        None,
    )

    assert response["statusCode"] == 200
    assert _body(response)["configs"][0]["key"] == "pushSubscription"


def test_get_remote_config_rejects_a_missing_client_id():
    response = lambda_handler(_event("GET /remote-config", query={}), None)

    assert response["statusCode"] == 400


def test_get_remote_config_without_a_client_secret_header_returns_403(client_secret):
    response = lambda_handler(_event("GET /remote-config", query={"clientId": "c1"}), None)

    assert response["statusCode"] == 403


def test_get_remote_config_with_a_wrong_client_secret_returns_403(client_secret):
    response = lambda_handler(
        _event("GET /remote-config", query={"clientId": "c1"}, headers={"x-client-secret": "wrong"}), None
    )

    assert response["statusCode"] == 403


def test_get_remote_config_for_a_clientid_with_no_registered_credential_returns_403(monkeypatch):
    monkeypatch.setattr(client_credential_store, "get_secret_hash", lambda client_id: None)

    response = lambda_handler(
        _event("GET /remote-config", query={"clientId": "never-registered"}, headers={"x-client-secret": "anything"}), None
    )

    assert response["statusCode"] == 403


# --- PUT/DELETE /clients/{clientId}/push-subscription (client-scoped: requires X-Client-Secret) ---


def _subscription_body():
    return {"endpoint": "https://fcm.googleapis.com/fcm/send/abc", "keys": {"p256dh": "p256dh-key", "auth": "auth-key"}}


def test_put_push_subscription_persists_it_with_a_valid_client_secret(monkeypatch, client_secret):
    stored = {}
    monkeypatch.setattr(remote_config_store, "put_remote_config", lambda record: stored.update(record))

    response = lambda_handler(
        _event(
            "PUT /clients/{clientId}/push-subscription",
            path={"clientId": "c1"},
            body=json.dumps(_subscription_body()),
            headers={"x-client-secret": client_secret},
        ),
        None,
    )

    assert response["statusCode"] == 200
    assert stored["clientId"] == "c1"
    assert stored["key"] == "pushSubscription"
    assert stored["value"]["endpoint"] == _subscription_body()["endpoint"]


def test_put_push_subscription_without_a_client_secret_returns_403(monkeypatch, client_secret):
    def _boom(record):
        raise AssertionError("should never persist a subscription without a valid client secret")

    monkeypatch.setattr(remote_config_store, "put_remote_config", _boom)

    response = lambda_handler(
        _event("PUT /clients/{clientId}/push-subscription", path={"clientId": "c1"}, body=json.dumps(_subscription_body())),
        None,
    )

    assert response["statusCode"] == 403


def test_put_push_subscription_rejects_a_malformed_subscription(monkeypatch, client_secret):
    def _boom(record):
        raise AssertionError("should never persist an invalid subscription")

    monkeypatch.setattr(remote_config_store, "put_remote_config", _boom)

    response = lambda_handler(
        _event(
            "PUT /clients/{clientId}/push-subscription",
            path={"clientId": "c1"},
            body=json.dumps({"endpoint": "not-https"}),
            headers={"x-client-secret": client_secret},
        ),
        None,
    )

    assert response["statusCode"] == 400


def test_delete_push_subscription_with_a_valid_client_secret(monkeypatch, client_secret):
    deleted = {}
    monkeypatch.setattr(remote_config_store, "delete_remote_config", lambda client_id, key: deleted.update(clientId=client_id, key=key))

    response = lambda_handler(
        _event("DELETE /clients/{clientId}/push-subscription", path={"clientId": "c1"}, headers={"x-client-secret": client_secret}),
        None,
    )

    assert response["statusCode"] == 200
    assert deleted == {"clientId": "c1", "key": "pushSubscription"}


def test_delete_push_subscription_without_a_client_secret_returns_403(monkeypatch, client_secret):
    def _boom(client_id, key):
        raise AssertionError("should never delete a subscription without a valid client secret")

    monkeypatch.setattr(remote_config_store, "delete_remote_config", _boom)

    response = lambda_handler(_event("DELETE /clients/{clientId}/push-subscription", path={"clientId": "c1"}), None)

    assert response["statusCode"] == 403


# --- PUT /clients/{clientId}/notification-preference (client-scoped: requires X-Client-Secret) ---
# A field-level update: only the fields in the body are written, each atomically.


def _preference_body():
    return {
        "enabled": True,
        "notificationLevel": "all",
        "notificationTimeZone": "Asia/Tokyo",
        "deliveryWindows": ["08:00", "18:00"],
    }


def _stored_preference_value(**overrides):
    value = {
        "enabled": True,
        "notificationLevel": "all",
        "notificationTimeZone": "Asia/Tokyo",
        "deliveryWindows": ["08:00", "18:00"],
        "quietHours": ["22:00", "07:00"],
        "temporaryMute": "2026-09-03T12:00:00+00:00",
        "creatorOverride": {"aizawa_ema": False},
    }
    value.update(overrides)
    return value


def _put_preference(body, client_secret, *, with_secret=True):
    return lambda_handler(
        _event(
            "PUT /clients/{clientId}/notification-preference",
            path={"clientId": "c1"},
            body=json.dumps(body),
            headers={"x-client-secret": client_secret} if with_secret else {},
        ),
        None,
    )


def _boom(*_a, **_kw):
    raise AssertionError("must not be called")


def test_put_notification_preference_creates_the_first_record_with_a_valid_client_secret(monkeypatch, client_secret):
    created = []
    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: None)
    monkeypatch.setattr(remote_config_store, "put_remote_config_if_absent", lambda record: created.append(record) or True)
    monkeypatch.setattr(remote_config_store, "update_remote_config_fields", _boom)

    response = _put_preference(_preference_body(), client_secret)

    assert response["statusCode"] == 200
    assert created[0]["clientId"] == "c1"
    assert created[0]["key"] == "notificationPreference"
    assert created[0]["value"]["enabled"] is True


def test_put_notification_preference_first_write_fills_level_and_windows_defaults(monkeypatch, client_secret):
    created = []
    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: None)
    monkeypatch.setattr(remote_config_store, "put_remote_config_if_absent", lambda record: created.append(record) or True)

    response = _put_preference({"enabled": True, "notificationTimeZone": "Asia/Tokyo"}, client_secret)

    assert response["statusCode"] == 200
    assert created[0]["value"] == {
        "enabled": True,
        "notificationTimeZone": "Asia/Tokyo",
        "notificationLevel": "all",
        "deliveryWindows": ["08:00", "18:00"],
    }


def test_put_notification_preference_first_write_still_requires_enabled_and_a_time_zone(monkeypatch, client_secret):
    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: None)
    monkeypatch.setattr(remote_config_store, "put_remote_config_if_absent", _boom)

    assert _put_preference({"enabled": True}, client_secret)["statusCode"] == 400
    assert _put_preference({"notificationTimeZone": "Asia/Tokyo"}, client_secret)["statusCode"] == 400


def test_put_notification_preference_updates_only_the_fields_sent_and_never_rewrites_the_rest(monkeypatch, client_secret):
    """The on/off toggle sends just `enabled`: quiet hours, mute, creator
    overrides and delivery windows saved elsewhere must be left untouched."""
    updates = []
    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: {"value": _stored_preference_value()})
    monkeypatch.setattr(
        remote_config_store,
        "update_remote_config_fields",
        lambda client_id, key, fields, updated_at: updates.append((client_id, key, fields)) or True,
    )
    monkeypatch.setattr(remote_config_store, "put_remote_config", _boom)
    monkeypatch.setattr(remote_config_store, "put_remote_config_if_absent", _boom)

    response = _put_preference({"enabled": False}, client_secret)

    assert response["statusCode"] == 200
    assert updates == [("c1", "notificationPreference", {"enabled": False})]
    assert _body(response)["value"]["quietHours"] == ["22:00", "07:00"]


def test_put_notification_preference_can_clear_a_field_by_sending_null(monkeypatch, client_secret):
    updates = []
    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: {"value": _stored_preference_value()})
    monkeypatch.setattr(
        remote_config_store, "update_remote_config_fields", lambda client_id, key, fields, updated_at: updates.append(fields) or True
    )

    response = _put_preference({"quietHours": None}, client_secret)

    assert response["statusCode"] == 200
    assert updates == [{"quietHours": None}]


def test_put_notification_preference_rejects_an_update_that_would_make_the_whole_preference_invalid(monkeypatch, client_secret):
    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: {"value": _stored_preference_value()})
    monkeypatch.setattr(remote_config_store, "update_remote_config_fields", _boom)

    assert _put_preference({"quietHours": ["25:00", "07:00"]}, client_secret)["statusCode"] == 400


def test_put_notification_preference_retries_as_an_update_when_another_device_created_the_record_first(monkeypatch, client_secret):
    reads = iter([None, {"value": _stored_preference_value()}])
    updates = []
    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: next(reads))
    monkeypatch.setattr(remote_config_store, "put_remote_config_if_absent", lambda record: False)
    monkeypatch.setattr(
        remote_config_store, "update_remote_config_fields", lambda client_id, key, fields, updated_at: updates.append(fields) or True
    )

    response = _put_preference({"enabled": True, "notificationTimeZone": "Asia/Tokyo"}, client_secret)

    assert response["statusCode"] == 200
    assert updates == [{"enabled": True, "notificationTimeZone": "Asia/Tokyo"}]


def test_put_notification_preference_rejects_unknown_fields_and_empty_updates(monkeypatch, client_secret):
    monkeypatch.setattr(remote_config_store, "get_remote_config", _boom)

    assert _put_preference({"enabled": True, "somethingElse": 1}, client_secret)["statusCode"] == 400
    assert _put_preference({}, client_secret)["statusCode"] == 400


def test_put_notification_preference_without_a_client_secret_returns_403(monkeypatch, client_secret):
    monkeypatch.setattr(remote_config_store, "get_remote_config", _boom)
    monkeypatch.setattr(remote_config_store, "put_remote_config_if_absent", _boom)
    monkeypatch.setattr(remote_config_store, "update_remote_config_fields", _boom)

    response = _put_preference(_preference_body(), client_secret, with_secret=False)

    assert response["statusCode"] == 403


def test_put_notification_preference_rejects_a_malformed_preference(monkeypatch, client_secret):
    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: None)
    monkeypatch.setattr(remote_config_store, "put_remote_config_if_absent", _boom)

    assert _put_preference({"enabled": "not-a-bool", "notificationTimeZone": "Asia/Tokyo"}, client_secret)["statusCode"] == 400


# --- PUT/DELETE /clients/{clientId}/creator-reminder/{creatorId}/{scope} (client-scoped) ---
# One remote-config item per setting: nothing is read, merged or rewritten.


def _put_creator_reminder(creator_id, scope, body, client_secret, *, with_secret=True):
    return lambda_handler(
        _event(
            "PUT /clients/{clientId}/creator-reminder/{creatorId}/{scope}",
            path={"clientId": "c1", "creatorId": creator_id, "scope": scope},
            body=json.dumps(body),
            headers={"x-client-secret": client_secret} if with_secret else {},
        ),
        None,
    )


def _delete_creator_reminder(creator_id, scope, client_secret, *, with_secret=True):
    return lambda_handler(
        _event(
            "DELETE /clients/{clientId}/creator-reminder/{creatorId}/{scope}",
            path={"clientId": "c1", "creatorId": creator_id, "scope": scope},
            headers={"x-client-secret": client_secret} if with_secret else {},
        ),
        None,
    )


def test_put_creator_reminder_writes_exactly_one_item_for_creator_all(monkeypatch, client_secret):
    puts = []
    monkeypatch.setattr(remote_config_store, "put_remote_config", lambda record: puts.append(record))
    for reader in ("get_remote_config", "list_remote_config", "list_remote_config_by_prefix", "delete_remote_config"):
        monkeypatch.setattr(remote_config_store, reader, _boom)

    response = _put_creator_reminder("aizawa_ema", "all", {"notifyAtStart": True, "advanceReminder": "30min"}, client_secret)

    assert response["statusCode"] == 200
    assert [(r["clientId"], r["key"], r["value"]) for r in puts] == [
        ("c1", "creatorReminder#aizawa_ema#all", {"notifyAtStart": True, "advanceReminder": "30min"})
    ]


def test_put_creator_reminder_writes_a_creator_topic_item_under_the_canonical_topic_id(monkeypatch, client_secret):
    puts = []
    monkeypatch.setattr(remote_config_store, "put_remote_config", lambda record: puts.append(record))

    response = _put_creator_reminder("aizawa_ema", "singing", {"notifyAtStart": True, "advanceReminder": "1hour"}, client_secret)

    assert response["statusCode"] == 200
    assert [r["key"] for r in puts] == ["creatorReminder#aizawa_ema#singing"]


@pytest.mark.parametrize("scope", ["valo", "gta", "other", "ALL"])
def test_put_creator_reminder_rejects_a_scope_that_is_not_all_or_a_canonical_topic(monkeypatch, client_secret, scope):
    monkeypatch.setattr(remote_config_store, "put_remote_config", _boom)

    response = _put_creator_reminder("aizawa_ema", scope, {"notifyAtStart": True, "advanceReminder": None}, client_secret)

    assert response["statusCode"] == 400


def test_put_creator_reminder_rejects_a_creator_id_that_would_make_the_key_ambiguous(monkeypatch, client_secret):
    monkeypatch.setattr(remote_config_store, "put_remote_config", _boom)

    response = _put_creator_reminder("ema#all", "sf6", {"notifyAtStart": True, "advanceReminder": None}, client_secret)

    assert response["statusCode"] == 400


def test_put_creator_reminder_rejects_a_malformed_setting(monkeypatch, client_secret):
    monkeypatch.setattr(remote_config_store, "put_remote_config", _boom)

    assert _put_creator_reminder("aizawa_ema", "all", {"notifyAtStart": "not-a-bool"}, client_secret)["statusCode"] == 400
    assert _put_creator_reminder("aizawa_ema", "all", {"notifyAtStart": True, "advanceReminder": "2hours"}, client_secret)[
        "statusCode"
    ] == 400


def test_put_creator_reminder_without_a_client_secret_returns_403(monkeypatch, client_secret):
    monkeypatch.setattr(remote_config_store, "put_remote_config", _boom)

    response = _put_creator_reminder("aizawa_ema", "all", {"notifyAtStart": True, "advanceReminder": None}, client_secret, with_secret=False)

    assert response["statusCode"] == 403


def test_delete_creator_reminder_deletes_only_that_one_item(monkeypatch, client_secret):
    deleted = []
    monkeypatch.setattr(remote_config_store, "delete_remote_config", lambda client_id, key: deleted.append((client_id, key)))
    monkeypatch.setattr(remote_config_store, "put_remote_config", _boom)
    monkeypatch.setattr(remote_config_store, "list_remote_config_by_prefix", _boom)

    response = _delete_creator_reminder("aizawa_ema", "all", client_secret)

    assert response["statusCode"] == 200
    assert deleted == [("c1", "creatorReminder#aizawa_ema#all")]


def test_delete_creator_reminder_for_a_topic_leaves_creator_all_alone(monkeypatch, client_secret):
    deleted = []
    monkeypatch.setattr(remote_config_store, "delete_remote_config", lambda client_id, key: deleted.append(key))

    _delete_creator_reminder("aizawa_ema", "sf6", client_secret)

    assert deleted == ["creatorReminder#aizawa_ema#sf6"]


def test_delete_creator_reminder_rejects_a_bad_scope_and_requires_a_client_secret(monkeypatch, client_secret):
    monkeypatch.setattr(remote_config_store, "delete_remote_config", _boom)

    assert _delete_creator_reminder("aizawa_ema", "gta", client_secret)["statusCode"] == 400
    assert _delete_creator_reminder("aizawa_ema", "all", client_secret, with_secret=False)["statusCode"] == 403


# --- PUT /clients/{clientId}/stream-notification-override/{videoId} (client-scoped) ---


def test_put_stream_notification_override_writes_exactly_one_item_for_that_stream(monkeypatch, client_secret):
    """An override is notification preference only -- it carries no
    scheduledStartMs of its own (that always comes from the system-wide
    streamSchedule snapshot at dispatch time, so a reschedule is never
    stale) -- and is its own item, so it can never touch the creator 全部 /
    topic reminders it outranks or another stream's override."""
    puts = []
    monkeypatch.setattr(remote_config_store, "put_remote_config", lambda record: puts.append(record))
    for reader in ("get_remote_config", "list_remote_config", "list_remote_config_by_prefix", "delete_remote_config"):
        monkeypatch.setattr(remote_config_store, reader, _boom)

    response = lambda_handler(
        _event(
            "PUT /clients/{clientId}/stream-notification-override/{videoId}",
            path={"clientId": "c1", "videoId": "v1"},
            body=json.dumps({"creatorId": "aizawa_ema", "notifyAtStart": True, "advanceReminder": "1hour"}),
            headers={"x-client-secret": client_secret},
        ),
        None,
    )

    assert response["statusCode"] == 200
    assert [(r["key"], r["value"]) for r in puts] == [
        ("streamOverride#v1", {"creatorId": "aizawa_ema", "notifyAtStart": True, "advanceReminder": "1hour"})
    ]


def test_put_stream_notification_override_without_a_client_secret_returns_403(monkeypatch, client_secret):
    monkeypatch.setattr(remote_config_store, "put_remote_config", _boom)

    response = lambda_handler(
        _event(
            "PUT /clients/{clientId}/stream-notification-override/{videoId}",
            path={"clientId": "c1", "videoId": "v1"},
            body=json.dumps({"creatorId": "aizawa_ema", "notifyAtStart": True, "advanceReminder": "1hour"}),
        ),
        None,
    )

    assert response["statusCode"] == 403


def test_put_stream_notification_override_rejects_a_missing_creator_id_and_an_ambiguous_video_id(monkeypatch, client_secret):
    monkeypatch.setattr(remote_config_store, "put_remote_config", _boom)

    def _put(video_id, body):
        return lambda_handler(
            _event(
                "PUT /clients/{clientId}/stream-notification-override/{videoId}",
                path={"clientId": "c1", "videoId": video_id},
                body=json.dumps(body),
                headers={"x-client-secret": client_secret},
            ),
            None,
        )

    assert _put("v1", {"notifyAtStart": True, "advanceReminder": "1hour"})["statusCode"] == 400
    assert _put("a#b", {"creatorId": "aizawa_ema", "notifyAtStart": True, "advanceReminder": None})["statusCode"] == 400


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


# --- GET /live-streams -----------------------------------------------------


def test_get_live_streams_returns_200(monkeypatch):
    monkeypatch.setattr(read_api, "get_live_streams", lambda query: {"streams": []})

    response = lambda_handler(_event("GET /live-streams"), None)

    assert response["statusCode"] == 200
    assert _body(response) == {"streams": []}


@pytest.mark.parametrize(
    "exc",
    [
        HolodexAPIError("Holodex API request to '/live' timed out"),
        HolodexNormalizationError("Expected a list from Holodex's /live response, got dict"),
        MissingHolodexApiKeyError("Neither HOLODEX_SECRET_NAME nor HOLODEX_API_KEY is set."),
    ],
    ids=["client_failure", "normalization_failure", "missing_api_key"],
)
def test_get_live_streams_maps_every_holodex_failure_to_503_not_a_fabricated_result(monkeypatch, capsys, exc):
    def _boom(query):
        raise exc

    monkeypatch.setattr(read_api, "get_live_streams", _boom)

    response = lambda_handler(_event("GET /live-streams"), None)

    assert response["statusCode"] == 503
    assert _body(response)["code"] == "HOLODEX_UNAVAILABLE"
    assert _body(response)["error"] == "Live stream data is temporarily unavailable"


@pytest.mark.parametrize(
    "exc",
    [
        HolodexAPIError("Holodex API request to '/users/live' timed out"),
        HolodexNormalizationError("Expected a list from Holodex's /users/live response, got dict"),
        MissingHolodexApiKeyError("Neither HOLODEX_SECRET_NAME nor HOLODEX_API_KEY is set."),
    ],
    ids=["client_failure", "normalization_failure", "missing_api_key"],
)
def test_get_live_streams_failure_never_leaks_exception_details_to_the_client(monkeypatch, capsys, exc):
    """The raw exception -- which can carry Holodex's own response text or
    Secrets Manager failure details -- must never reach the HTTP response,
    even though it's still logged server-side for diagnosis."""

    def _boom(query):
        raise exc

    monkeypatch.setattr(read_api, "get_live_streams", _boom)

    response = lambda_handler(_event("GET /live-streams"), None)

    assert str(exc) not in response["body"]
    assert str(exc) in capsys.readouterr().out


def test_get_live_streams_calls_read_api_rather_than_duplicating_http_logic(monkeypatch):
    """api_handler must delegate to read_api.get_live_streams, not call
    holodex_client/holodex_normalization directly itself."""
    captured = {}

    def fake_get_live_streams(query):
        captured["query"] = query
        return {"streams": []}

    monkeypatch.setattr(read_api, "get_live_streams", fake_get_live_streams)

    response = lambda_handler(_event("GET /live-streams", query={"foo": "bar"}), None)

    assert response["statusCode"] == 200
    assert captured["query"] == {"foo": "bar"}


def test_get_recent_streams_returns_200(monkeypatch):
    monkeypatch.setattr(read_api, "get_recent_streams", lambda query: {"creatorId": "aizawa_ema", "streams": [], "hasMore": False})

    response = lambda_handler(_event("GET /recent-streams", query={"creatorId": "aizawa_ema"}), None)

    assert response["statusCode"] == 200
    assert _body(response) == {"creatorId": "aizawa_ema", "streams": [], "hasMore": False}


def test_get_recent_streams_calls_read_api_rather_than_duplicating_http_logic(monkeypatch):
    captured = {}

    def fake_get_recent_streams(query):
        captured["query"] = query
        return {"creatorId": "aizawa_ema", "streams": [], "hasMore": False}

    monkeypatch.setattr(read_api, "get_recent_streams", fake_get_recent_streams)

    response = lambda_handler(_event("GET /recent-streams", query={"creatorId": "aizawa_ema", "limit": "2"}), None)

    assert response["statusCode"] == 200
    assert captured["query"] == {"creatorId": "aizawa_ema", "limit": "2"}


def test_get_recent_streams_unknown_creator_returns_404(monkeypatch):
    def _boom(query):
        raise read_api.ScopeNotFoundError("No creator found for creatorId 'does_not_exist'")

    monkeypatch.setattr(read_api, "get_recent_streams", _boom)

    response = lambda_handler(_event("GET /recent-streams", query={"creatorId": "does_not_exist"}), None)

    assert response["statusCode"] == 404


def test_get_recent_streams_bad_limit_returns_400(monkeypatch):
    def _boom(query):
        raise read_api.ClientError("limit must be at most 20, got 999")

    monkeypatch.setattr(read_api, "get_recent_streams", _boom)

    response = lambda_handler(_event("GET /recent-streams", query={"creatorId": "aizawa_ema", "limit": "999"}), None)

    assert response["statusCode"] == 400


@pytest.mark.parametrize(
    "exc",
    [
        HolodexAPIError("Holodex API request to '/videos' timed out"),
        HolodexNormalizationError("Expected a list from Holodex's /videos response, got dict"),
        MissingHolodexApiKeyError("Neither HOLODEX_SECRET_NAME nor HOLODEX_API_KEY is set."),
    ],
    ids=["client_failure", "normalization_failure", "missing_api_key"],
)
def test_get_recent_streams_maps_every_holodex_failure_to_a_safe_503(monkeypatch, capsys, exc):
    """Reuses the exact same dispatch-level Holodex exception handling
    get_live_streams already goes through -- no separate error path was
    added for this route. str(exc) must never reach the client."""

    def _boom(query):
        raise exc

    monkeypatch.setattr(read_api, "get_recent_streams", _boom)

    response = lambda_handler(_event("GET /recent-streams", query={"creatorId": "aizawa_ema"}), None)

    assert response["statusCode"] == 503
    assert _body(response)["code"] == "HOLODEX_UNAVAILABLE"
    assert _body(response)["error"] == "Live stream data is temporarily unavailable"
    assert str(exc) not in response["body"]
    assert str(exc) in capsys.readouterr().out
