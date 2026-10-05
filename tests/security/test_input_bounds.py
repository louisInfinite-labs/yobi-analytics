"""SEC-API-001 (launch scope): malformed identifiers/fields are rejected with a 4xx and never reach a data plane.

Every public route that takes an identifier or a free-text field is attacked with over-length, wrong-charset, unicode,
encoded and control-character inputs. A spy replaces every store/upstream, so a reject that still touches one fails.
"""

from __future__ import annotations

import pytest

from api import api_handler

from .spies import event, forbid_data_plane

pytestmark = pytest.mark.security

GOOD_CLIENT = "00000000-0000-4000-8000-000000000001"

BAD_CLIENT_IDS = [
    "",
    " ",
    "x" * 129,
    "client-1",
    "00000000-0000-4000-8000-00000000000G",
    "00000000-0000-4000-8000-000000000001\n",
    "00000000-0000-4000-8000-000000000001\x00",
    "00000000-0000-4000-8000-0000000000AB",  # uppercase
    "00000000-0000-1000-8000-000000000001",  # not v4
    "../../etc/passwd",
    "%2e%2e%2f",
    "００００００００-0000-4000-8000-000000000001",  # full-width digits
]
BAD_APP_VERSIONS = ["", "x" * 33, "<script>alert(1)</script>", "1.0\n", "１.０", "a b", None, 123]
BAD_KEYS = ["", "k" * 65, "a b", "key\n", "../k", "鍵"]
BAD_CREATOR_IDS = ["", "A", "x" * 65, "../x", "ema ", "ema\n", "藍沢エマ", "ema%00", "ema/../x"]
BAD_VIDEO_IDS = ["", "short", "x" * 12, "dQw4w9WgXc!", "dQw4w9WgXcQ\n", "..%2f..%2f..%2f", "ｖｉｄ０００００００１"]


def _call(monkeypatch, ev):
    recorder = forbid_data_plane(monkeypatch)
    response = api_handler.lambda_handler(ev, None)
    return response, recorder


def _assert_rejected_cleanly(response, recorder):
    assert response["statusCode"] == 400, response["body"]
    assert recorder.calls == [], f"a rejected request reached a data plane: {recorder.calls}"
    assert len(response["body"]) < 400, "error body must stay bounded"
    assert "\n" not in response["body"].replace("\\n", "")


@pytest.mark.parametrize("bad", BAD_CLIENT_IDS)
def test_heartbeat_rejects_a_malformed_client_id(monkeypatch, bad):
    response, recorder = _call(monkeypatch, event("POST /heartbeat", body={"clientId": bad, "appVersion": "1.0"}))

    _assert_rejected_cleanly(response, recorder)


@pytest.mark.parametrize("bad", BAD_APP_VERSIONS)
def test_heartbeat_rejects_a_malformed_app_version(monkeypatch, bad):
    response, recorder = _call(monkeypatch, event("POST /heartbeat", body={"clientId": GOOD_CLIENT, "appVersion": bad}))

    _assert_rejected_cleanly(response, recorder)


@pytest.mark.parametrize("route", [
    "GET /heartbeat/{clientId}/status",
    "POST /clients/{clientId}/credential",
    "PUT /clients/{clientId}/push-subscription",
    "DELETE /clients/{clientId}/push-subscription",
    "PUT /clients/{clientId}/notification-preference",
])
@pytest.mark.parametrize("bad", BAD_CLIENT_IDS[:8])
def test_client_path_routes_reject_a_malformed_client_id(monkeypatch, route, bad):
    response, recorder = _call(monkeypatch, event(route, path={"clientId": bad}, body={}))

    _assert_rejected_cleanly(response, recorder)


@pytest.mark.parametrize("bad", BAD_CLIENT_IDS)
def test_remote_config_read_rejects_a_malformed_client_id(monkeypatch, bad):
    response, recorder = _call(monkeypatch, event("GET /remote-config", query={"clientId": bad}))

    _assert_rejected_cleanly(response, recorder)


@pytest.mark.parametrize("bad", BAD_KEYS)
def test_remote_config_read_rejects_a_malformed_key(monkeypatch, bad):
    response, recorder = _call(monkeypatch, event("GET /remote-config", query={"clientId": GOOD_CLIENT, "key": bad}))

    _assert_rejected_cleanly(response, recorder)


@pytest.mark.parametrize("field,bad", [("clientId", b) for b in BAD_CLIENT_IDS[:6]] + [("key", b) for b in BAD_KEYS])
def test_admin_remote_config_write_rejects_malformed_fields(monkeypatch, field, bad):
    monkeypatch.setattr(api_handler, "_check_admin_key", lambda ev: None)
    body = {"clientId": GOOD_CLIENT, "key": "enabled", "value": True, field: bad}

    response, recorder = _call(monkeypatch, event("POST /remote-config", body=body))

    _assert_rejected_cleanly(response, recorder)


@pytest.mark.parametrize("bad", BAD_VIDEO_IDS)
def test_video_growth_rejects_a_malformed_video_id(monkeypatch, bad):
    response, recorder = _call(monkeypatch, event("GET /videos/{videoId}/growth", path={"videoId": bad}))

    _assert_rejected_cleanly(response, recorder)


@pytest.mark.parametrize("route", [
    "GET /creators/{creatorId}/videos/ranking",
    "GET /creators/{creatorId}/videos/recent",
    "GET /creators/{creatorId}/oshi-status",
])
@pytest.mark.parametrize("bad", BAD_CREATOR_IDS)
def test_creator_routes_reject_a_malformed_creator_id(monkeypatch, route, bad):
    query = {"metric": "total"} if route.endswith("ranking") else None
    response, recorder = _call(monkeypatch, event(route, path={"creatorId": bad}, query=query))

    _assert_rejected_cleanly(response, recorder)


def test_the_spy_is_not_vacuous_a_valid_request_does_reach_the_data_plane(monkeypatch):
    response, recorder = _call(monkeypatch, event("POST /heartbeat", body={"clientId": GOOD_CLIENT, "appVersion": "1.0"}))

    assert recorder.calls, "a valid heartbeat must touch the heartbeat store, proving the spy can detect access"
    assert response["statusCode"] == 500


@pytest.mark.parametrize("route,extra", [
    ("GET /creators/{creatorId}/videos/recent", {"creatorId": "aizawa_ema"}),
    ("GET /recent-streams", {"creatorId": "aizawa_ema"}),
])
@pytest.mark.parametrize("offset", ["5001", "99999999999999999999", "-1", "abc", "1e3", "5000\n", " 5", "1_0", "+5", "１２"])
def test_offset_beyond_the_ceiling_or_malformed_is_rejected_before_any_data_plane_work(monkeypatch, route, extra, offset):
    response, recorder = _call(monkeypatch, event(route, path=extra, query={"offset": offset}))

    _assert_rejected_cleanly(response, recorder)


def test_offset_at_the_ceiling_is_accepted_by_the_parser():
    from api import read_api

    assert read_api.parse_offset("5000") == read_api.MAX_OFFSET
    assert read_api.parse_offset(None) == 0
