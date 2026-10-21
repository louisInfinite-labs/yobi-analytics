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
from tracking.livestream_lifecycle import LiveSnapshotStaleError
from api import read_api
from api import remote_config_api
from stores import notification_slot_store
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


def _preference_body():
    return {
        "enabled": True,
        "notificationLevel": "all",
        "notificationTimeZone": "Asia/Tokyo",
        "deliveryWindows": ["08:00", "18:00"],
    }


@pytest.fixture(autouse=True)
def slot_index(monkeypatch):
    """The slot-recipient index calls a preference write makes, recorded instead of reaching DynamoDB."""
    calls = {"sync": [], "remove": [], "zones": []}

    def _sync(client_id, *, zone, slots, now_iso):
        calls["sync"].append((client_id, tuple(slots), now_iso))
        calls["zones"].append(zone)

    monkeypatch.setattr(notification_slot_store, "sync_client_slots", _sync)
    monkeypatch.setattr(notification_slot_store, "remove_client", lambda client_id: calls["remove"].append(client_id))
    # A preference write also reads what the client had stored before (to stamp the per-creator new-video activation): nothing, by default.
    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: None)
    return calls


def _put_preference(body, client_secret):
    return lambda_handler(
        _event(
            "PUT /clients/{clientId}/notification-preference",
            path={"clientId": "c1"},
            body=json.dumps(body),
            headers={"x-client-secret": client_secret},
        ),
        None,
    )


def test_an_enabled_preference_indexes_the_client_under_its_own_zone_and_local_slots(monkeypatch, client_secret, slot_index):
    monkeypatch.setattr(remote_config_store, "put_remote_config", lambda record: None)

    response = _put_preference({**_preference_body(), "deliveryWindows": ["18:00", "08:30", "08:30"]}, client_secret)

    assert response["statusCode"] == 200
    [(client_id, slots, now_iso)] = slot_index["sync"]
    assert (client_id, slots) == ("c1", (17, 36))  # 08:30 -> 17, 18:00 -> 36, deduplicated and sorted
    assert now_iso == json.loads(response["body"])["updatedAt"]
    assert slot_index["zones"] == ["Asia/Tokyo"]
    assert slot_index["remove"] == []


def test_the_canonical_preference_keeps_the_zone_and_the_local_times_the_client_chose_unconverted(monkeypatch, client_secret, slot_index):
    stored = {}
    monkeypatch.setattr(remote_config_store, "put_remote_config", lambda record: stored.update(record))

    body = {**_preference_body(), "notificationTimeZone": "Asia/Hong_Kong", "deliveryWindows": ["08:00", "18:00"]}
    response = _put_preference(body, client_secret)

    assert response["statusCode"] == 200
    # The backend stores what the user chose -- IANA zone + LOCAL wall-clock times -- and indexes the LOCAL slots under that zone. Nothing
    # is converted to Japan time or to a UTC offset, which would silently break at a daylight-saving transition.
    assert stored["value"]["notificationTimeZone"] == "Asia/Hong_Kong"
    assert stored["value"]["deliveryWindows"] == ["08:00", "18:00"]
    assert slot_index["zones"] == ["Asia/Hong_Kong"] and slot_index["sync"][0][1] == (16, 36)


def test_a_changed_browser_time_zone_reindexes_the_same_local_times_under_the_new_zone(monkeypatch, client_secret, slot_index):
    monkeypatch.setattr(remote_config_store, "put_remote_config", lambda record: None)

    _put_preference({**_preference_body(), "notificationTimeZone": "Asia/Hong_Kong"}, client_secret)
    _put_preference({**_preference_body(), "notificationTimeZone": "Europe/London"}, client_secret)

    assert slot_index["zones"] == ["Asia/Hong_Kong", "Europe/London"]
    assert [call[1] for call in slot_index["sync"]] == [(16, 36), (16, 36)]  # the local 08:00 / 18:00 did not move


@pytest.mark.parametrize("zone", ["Mars/Olympus_Mons", "", None, "UTC+9", "Asia/Tokyo|16"])
def test_an_unknown_or_missing_time_zone_is_rejected_before_anything_is_written(monkeypatch, client_secret, slot_index, zone):
    monkeypatch.setattr(remote_config_store, "put_remote_config", _boom)

    response = _put_preference({**_preference_body(), "notificationTimeZone": zone}, client_secret)

    assert response["statusCode"] == 400
    assert slot_index == {"sync": [], "remove": [], "zones": []}


def test_a_disabled_preference_removes_the_client_from_the_index(monkeypatch, client_secret, slot_index):
    monkeypatch.setattr(remote_config_store, "put_remote_config", lambda record: None)

    response = _put_preference({**_preference_body(), "enabled": False}, client_secret)

    assert response["statusCode"] == 200
    assert slot_index["remove"] == ["c1"]
    assert slot_index["sync"] == []


@pytest.mark.parametrize(
    "windows",
    [
        ["08:10"],  # not on a half-hour boundary
        ["06:00", "07:00", "08:00", "09:00", "10:00"],  # more than 4
        [],  # none
        ["25:00"],
        [800],
    ],
)
def test_a_new_preference_with_invalid_delivery_slots_is_rejected_before_anything_is_written(monkeypatch, client_secret, slot_index, windows):
    monkeypatch.setattr(remote_config_store, "put_remote_config", _boom)

    response = _put_preference({**_preference_body(), "deliveryWindows": windows}, client_secret)

    assert response["statusCode"] == 400
    assert slot_index == {"sync": [], "remove": [], "zones": []}


def test_four_distinct_half_hour_slots_are_accepted(monkeypatch, client_secret, slot_index):
    monkeypatch.setattr(remote_config_store, "put_remote_config", lambda record: None)

    response = _put_preference({**_preference_body(), "deliveryWindows": ["00:00", "07:30", "12:00", "23:30"]}, client_secret)

    assert response["statusCode"] == 200
    assert slot_index["sync"][0][1] == (0, 15, 24, 47)


def test_the_index_is_written_before_the_preference_so_a_failed_index_write_stores_nothing(monkeypatch, client_secret):
    monkeypatch.setattr(remote_config_store, "put_remote_config", _boom)

    def _failing_sync(client_id, *, zone, slots, now_iso):
        raise notification_slot_store.NotificationSlotStoreError("table unreachable")

    monkeypatch.setattr(notification_slot_store, "sync_client_slots", _failing_sync)

    response = _put_preference(_preference_body(), client_secret)

    assert response["statusCode"] == 500


def test_put_notification_preference_persists_it_with_a_valid_client_secret(monkeypatch, client_secret):
    stored = {}
    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: None)  # nothing stored before
    monkeypatch.setattr(remote_config_store, "put_remote_config", lambda record: stored.update(record))

    response = lambda_handler(
        _event(
            "PUT /clients/{clientId}/notification-preference",
            path={"clientId": "c1"},
            body=json.dumps(_preference_body()),
            headers={"x-client-secret": client_secret},
        ),
        None,
    )

    assert response["statusCode"] == 200
    assert stored["clientId"] == "c1"
    assert stored["key"] == "notificationPreference"
    assert stored["value"]["enabled"] is True


def test_put_notification_preference_persists_the_short_card_members_unchanged(monkeypatch, client_secret):
    stored = {}
    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: None)  # nothing stored before
    monkeypatch.setattr(remote_config_store, "put_remote_config", lambda record: stored.update(record))
    body = {**_preference_body(), "newVideoShortCreatorOverride": {"aizawa_ema": True, "shirakami_fubuki": False}}

    response = lambda_handler(
        _event(
            "PUT /clients/{clientId}/notification-preference",
            path={"clientId": "c1"},
            body=json.dumps(body),
            headers={"x-client-secret": client_secret},
        ),
        None,
    )

    assert response["statusCode"] == 200
    assert stored["value"]["newVideoShortCreatorOverride"] == {"aizawa_ema": True, "shirakami_fubuki": False}
    assert "newVideoTopicOverride" not in stored["value"] and "newVideoShortEnabled" not in stored["value"]


# --- the backend owns the per-creator new-video activation instant ----------------


def _in_memory_remote_config(monkeypatch) -> dict:
    """An in-memory remote-config store ({(clientId, key): record}) behind the handler -- no AWS."""
    stored: dict = {}
    monkeypatch.setattr(remote_config_store, "get_remote_config", lambda client_id, key: stored.get((client_id, key)))
    monkeypatch.setattr(remote_config_store, "put_remote_config", lambda record: stored.__setitem__((record["clientId"], record["key"]), record))
    return stored


def _frozen_clock(monkeypatch, instant):
    """Make the handler's datetime.now() return `instant` (subclass, so every other datetime classmethod keeps working)."""

    class _Frozen(api_handler.datetime):
        @classmethod
        def now(cls, tz=None):
            return instant.astimezone(tz) if tz else instant

    monkeypatch.setattr(api_handler, "datetime", _Frozen)


def _put_stamped_preference(client_secret, **fields):
    body = {**_preference_body(), **fields}
    response = lambda_handler(
        _event(
            "PUT /clients/{clientId}/notification-preference",
            path={"clientId": "c1"},
            body=json.dumps(body),
            headers={"x-client-secret": client_secret},
        ),
        None,
    )
    assert response["statusCode"] == 200
    return _body(response)["value"]


def test_put_stamps_the_activation_of_each_enabled_creator_with_the_server_clock_and_ignores_a_forged_one(monkeypatch, client_secret):
    from datetime import datetime, timezone

    _in_memory_remote_config(monkeypatch)
    _frozen_clock(monkeypatch, datetime(2026, 9, 10, 3, 0, tzinfo=timezone.utc))

    value = _put_stamped_preference(
        client_secret,
        newVideoCreatorOverride={"aizawa_ema": True, "shirakami_fubuki": False},
        newVideoActivatedAt={"aizawa_ema": "2020-01-01T00:00:00+00:00", "shirakami_fubuki": "2020-01-01T00:00:00+00:00"},
    )

    assert value["newVideoActivatedAt"] == {"aizawa_ema": "2026-09-10T03:00:00+00:00"}


def test_put_keeps_the_boundary_through_unrelated_edits_and_restarts_it_after_off_and_on(monkeypatch, client_secret):
    from datetime import datetime, timezone

    stored = _in_memory_remote_config(monkeypatch)
    on = {"newVideoCreatorOverride": {"aizawa_ema": True}}

    _frozen_clock(monkeypatch, datetime(2026, 9, 10, 3, 0, tzinfo=timezone.utc))
    _put_stamped_preference(client_secret, **on)

    _frozen_clock(monkeypatch, datetime(2026, 9, 11, 3, 0, tzinfo=timezone.utc))
    edited = _put_stamped_preference(client_secret, notificationLocale="ja", **on)  # an unrelated edit
    assert edited["newVideoActivatedAt"] == {"aizawa_ema": "2026-09-10T03:00:00+00:00"}

    _frozen_clock(monkeypatch, datetime(2026, 9, 12, 3, 0, tzinfo=timezone.utc))
    disabled = _put_stamped_preference(client_secret, enabled=False, **on)
    assert disabled["newVideoActivatedAt"] == {}

    _frozen_clock(monkeypatch, datetime(2026, 9, 13, 3, 0, tzinfo=timezone.utc))
    again = _put_stamped_preference(client_secret, **on)
    assert again["newVideoActivatedAt"] == {"aizawa_ema": "2026-09-13T03:00:00+00:00"}
    assert stored[("c1", "notificationPreference")]["value"]["newVideoActivatedAt"] == again["newVideoActivatedAt"]


def test_put_carries_a_legacy_stored_preference_by_its_last_write_time(monkeypatch, client_secret):
    from datetime import datetime, timezone

    stored = _in_memory_remote_config(monkeypatch)
    stored[("c1", "notificationPreference")] = {
        "clientId": "c1",
        "key": "notificationPreference",
        "value": {**_preference_body(), "newVideoCreatorOverride": {"aizawa_ema": True}},  # stored before activation tracking existed
        "updatedAt": "2026-09-09T00:00:00+00:00",
    }
    _frozen_clock(monkeypatch, datetime(2026, 9, 12, 3, 0, tzinfo=timezone.utc))

    value = _put_stamped_preference(client_secret, newVideoCreatorOverride={"aizawa_ema": True, "kosuzume_toto": True})

    assert value["newVideoActivatedAt"] == {"aizawa_ema": "2026-09-09T00:00:00+00:00", "kosuzume_toto": "2026-09-12T03:00:00+00:00"}


def test_put_notification_preference_rejects_a_non_boolean_short_member(monkeypatch, client_secret):
    monkeypatch.setattr(remote_config_store, "put_remote_config", _boom)

    response = lambda_handler(
        _event(
            "PUT /clients/{clientId}/notification-preference",
            path={"clientId": "c1"},
            body=json.dumps({**_preference_body(), "newVideoShortCreatorOverride": {"aizawa_ema": "yes"}}),
            headers={"x-client-secret": client_secret},
        ),
        None,
    )

    assert response["statusCode"] == 400


def test_put_notification_preference_without_a_client_secret_returns_403(monkeypatch, client_secret):
    def _boom(record):
        raise AssertionError("should never persist a preference without a valid client secret")

    monkeypatch.setattr(remote_config_store, "put_remote_config", _boom)

    response = lambda_handler(
        _event(
            "PUT /clients/{clientId}/notification-preference",
            path={"clientId": "c1"},
            body=json.dumps(_preference_body()),
        ),
        None,
    )

    assert response["statusCode"] == 403


def test_put_notification_preference_rejects_a_malformed_preference(monkeypatch, client_secret):
    def _boom(record):
        raise AssertionError("should never persist an invalid preference")

    monkeypatch.setattr(remote_config_store, "put_remote_config", _boom)

    response = lambda_handler(
        _event(
            "PUT /clients/{clientId}/notification-preference",
            path={"clientId": "c1"},
            body=json.dumps({"enabled": "not-a-bool"}),
            headers={"x-client-secret": client_secret},
        ),
        None,
    )

    assert response["statusCode"] == 400


# --- PUT/DELETE /clients/{clientId}/creator-reminder/{creatorId}/{scope} (client-scoped) ---
# One remote-config item per setting: nothing is read, merged or rewritten.


def _boom(*_a, **_kw):
    raise AssertionError("must not be called")


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


def _delete_stream_override(video_id, secret, *, with_secret=True):
    return lambda_handler(
        _event(
            "DELETE /clients/{clientId}/stream-notification-override/{videoId}",
            path={"clientId": "c1", "videoId": video_id},
            headers={"x-client-secret": secret} if with_secret else {},
        ),
        None,
    )


def test_delete_stream_notification_override_deletes_only_that_streams_item(monkeypatch, client_secret):
    deleted = []
    monkeypatch.setattr(remote_config_store, "delete_remote_config", lambda client_id, key: deleted.append((client_id, key)))
    for other in ("put_remote_config", "get_remote_config", "list_remote_config", "list_remote_config_by_prefix"):
        monkeypatch.setattr(remote_config_store, other, _boom)

    response = _delete_stream_override("v1", client_secret)

    assert response["statusCode"] == 200
    assert json.loads(response["body"]) == {"clientId": "c1", "key": "streamOverride#v1", "deleted": True}
    assert deleted == [("c1", "streamOverride#v1")]


def test_delete_stream_notification_override_requires_the_client_secret_and_a_clean_video_id(monkeypatch, client_secret):
    monkeypatch.setattr(remote_config_store, "delete_remote_config", _boom)

    assert _delete_stream_override("v1", client_secret, with_secret=False)["statusCode"] == 403
    assert _delete_stream_override("a#b", client_secret)["statusCode"] == 400


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
        LiveSnapshotStaleError("live stream snapshot is stale"),
    ],
    ids=["client_failure", "normalization_failure", "missing_api_key", "stale_snapshot"],
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


def test_get_recent_streams_route_is_retired_with_410_and_never_reaches_holodex(monkeypatch):
    """GET /recent-streams was a public per-request Holodex proxy; it now answers the standard 410 and no request can make Holodex calls."""

    def _boom(*args, **kwargs):
        raise AssertionError("a retired route must never reach Holodex or any store")

    monkeypatch.setattr(read_api, "holodex_get", _boom)
    assert not hasattr(read_api, "get_recent_streams")

    response = lambda_handler(_event("GET /recent-streams", query={"creatorId": "aizawa_ema", "limit": "2"}), None)

    assert response["statusCode"] == 410
    assert _body(response) == {
        "error": "GET /recent-streams was retired and no longer returns data",
        "code": "ENDPOINT_RETIRED",
        "replacement": "GET /creators/{creatorId}/videos/recent",
    }


# --- 同時開播預告 opt-in: one sparse item, written / deleted on its own -------------------------------------------------------


def _put_simultaneous_notice(client_secret, *, with_secret=True, body=None):
    """PUT /clients/c1/simultaneous-live-notice."""
    return lambda_handler(
        _event(
            "PUT /clients/{clientId}/simultaneous-live-notice",
            path={"clientId": "c1"},
            body=body,
            headers={"x-client-secret": client_secret} if with_secret else {},
        ),
        None,
    )


def _delete_simultaneous_notice(client_secret, *, with_secret=True):
    """DELETE /clients/c1/simultaneous-live-notice."""
    return lambda_handler(
        _event(
            "DELETE /clients/{clientId}/simultaneous-live-notice",
            path={"clientId": "c1"},
            headers={"x-client-secret": client_secret} if with_secret else {},
        ),
        None,
    )


def test_put_simultaneous_live_notice_writes_exactly_one_opt_in_item_and_nothing_else(monkeypatch, client_secret):
    """The opt-in is its own tiny item (so the preference PUT, which replaces the whole item, can never switch it off by omission)."""
    puts = []
    monkeypatch.setattr(remote_config_store, "put_remote_config", lambda record: puts.append(record))
    for other in ("get_remote_config", "list_remote_config", "list_remote_config_by_prefix", "delete_remote_config"):
        monkeypatch.setattr(remote_config_store, other, _boom)

    response = _put_simultaneous_notice(client_secret)

    assert response["statusCode"] == 200
    assert [(r["clientId"], r["key"], r["value"]) for r in puts] == [("c1", "simultaneousLiveNotice", {"enabled": True})]


def test_put_simultaneous_live_notice_needs_the_clients_own_secret(monkeypatch, client_secret):
    """Like every client-scoped write: no secret, no write."""
    monkeypatch.setattr(remote_config_store, "put_remote_config", _boom)

    assert _put_simultaneous_notice(client_secret, with_secret=False)["statusCode"] == 403


def test_delete_simultaneous_live_notice_deletes_only_the_opt_in_item(monkeypatch, client_secret):
    """Opting out removes the item (idempotent) and touches nothing else."""
    deleted = []
    monkeypatch.setattr(remote_config_store, "delete_remote_config", lambda client_id, key: deleted.append((client_id, key)))
    monkeypatch.setattr(remote_config_store, "put_remote_config", _boom)
    monkeypatch.setattr(remote_config_store, "list_remote_config_by_prefix", _boom)

    response = _delete_simultaneous_notice(client_secret)

    assert response["statusCode"] == 200
    assert deleted == [("c1", "simultaneousLiveNotice")]


def test_delete_simultaneous_live_notice_needs_the_clients_own_secret(monkeypatch, client_secret):
    """No secret, no delete."""
    monkeypatch.setattr(remote_config_store, "delete_remote_config", _boom)

    assert _delete_simultaneous_notice(client_secret, with_secret=False)["statusCode"] == 403


def test_the_generic_remote_config_read_returns_the_opt_in_so_the_dashboard_can_show_its_state(monkeypatch, client_secret):
    """The Settings toggle reads its state back through the existing self-service GET /remote-config (the opt-in is not a secret)."""
    stored = {"clientId": "c1", "key": "simultaneousLiveNotice", "value": {"enabled": True}, "updatedAt": "2026-10-21T00:00:00+00:00"}
    monkeypatch.setattr(remote_config_store, "list_remote_config", lambda client_id: [stored])

    response = lambda_handler(_event("GET /remote-config", query={"clientId": "c1"}, headers={"x-client-secret": client_secret}), None)

    assert response["statusCode"] == 200 and stored in json.loads(response["body"])["configs"]
