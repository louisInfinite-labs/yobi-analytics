"""Shared test doubles that prove a request never reached a data plane or upstream (roadmap MT-03/MT-04/MT-26/MT-27)."""

from __future__ import annotations

import json
from typing import Any

from api import api_handler, read_api


class DataPlaneCalls:
    """Records every attribute touched on a forbidden data-plane/upstream module; an empty list is the proof."""

    def __init__(self) -> None:
        self.calls: list[str] = []


class _Forbidden:
    """A stand-in for a store/upstream module: any attribute access is recorded and then fails the request."""

    def __init__(self, name: str, recorder: DataPlaneCalls) -> None:
        self._name = name
        self._recorder = recorder

    def __getattr__(self, attr: str) -> Any:
        self._recorder.calls.append(f"{self._name}.{attr}")
        raise AssertionError(f"data-plane/upstream access: {self._name}.{attr}")


def forbid_data_plane(monkeypatch) -> DataPlaneCalls:
    """Replace every store/upstream the handler can reach with a recorder that fails on any use."""
    recorder = DataPlaneCalls()
    for name in ("heartbeat_store", "client_credential_store", "remote_config_store"):
        monkeypatch.setattr(api_handler, name, _Forbidden(name, recorder))
    monkeypatch.setattr(read_api, "S3VideoRankingStore", _Forbidden("S3VideoRankingStore", recorder))
    monkeypatch.setattr(read_api, "S3SubscriberRankingStore", _Forbidden("S3SubscriberRankingStore", recorder))
    monkeypatch.setattr(read_api, "holodex_get", _Forbidden("holodex_get", recorder))
    import stores.dynamodb_store as dynamodb_store

    def _raiser(name: str):
        def fail(*args: Any, **kwargs: Any) -> Any:
            recorder.calls.append(name)
            raise AssertionError(f"data-plane access: {name}")

        return fail

    for attr in ("get_video", "get_snapshot"):
        monkeypatch.setattr(dynamodb_store, attr, _raiser(f"dynamodb_store.{attr}"))
    return recorder


def event(route_key: str, *, query: dict | None = None, path: dict | None = None, body: Any = None, headers: dict | None = None) -> dict:
    """A minimal API Gateway HTTP API v2 proxy event."""
    return {
        "routeKey": route_key,
        "queryStringParameters": query,
        "pathParameters": path,
        "body": None if body is None else json.dumps(body),
        "isBase64Encoded": False,
        "headers": headers or {},
    }
