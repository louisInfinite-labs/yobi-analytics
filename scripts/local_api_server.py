"""Local HTTP server for browser (Playwright) integration tests.

Runs the REAL `api_handler.lambda_handler` -- the same route dispatch,
validation and computation the deployed Lambda runs -- behind a tiny stdlib
HTTP server, against the local JSON storage backend (no AWS). It only serves
the read routes that need no cloud service (`GET /dashboard/*`); every other
route answers 404, so nothing here can reach DynamoDB or Secrets Manager.

`--seed-fixture` is accepted for backward CLI compatibility (frontend/
dashboard/playwright.config.ts's webServer still passes it) but is now a
no-op: it used to seed YobiTrendingCache stand-in data for the comparison
feature's `/dashboard/comparison-*` endpoints (history_ranking.
creator_period_partials + ranking_reducer.persist_creator_summaries), and
both the comparison feature and that reducer API were retired (PR #60,
AWS Cost Recovery). No route this server still serves (_ROUTES only has
`/dashboard/chart-catalog` under `/dashboard/*`) reads seeded fixture data,
so there is nothing left to seed.

    .venv/bin/python scripts/local_api_server.py --port 8787 --seed-fixture
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

ROOT = Path(__file__).resolve().parent.parent


def _route_patterns(routes: dict) -> list[tuple[str, re.Pattern[str], str]]:
    patterns = []
    for route_key in routes:
        method, template = route_key.split(" ", 1)
        regex = re.sub(r"\{(\w+)\}", r"(?P<\1>[^/]+)", template)
        patterns.append((method, re.compile(f"^{regex}$"), route_key))
    return patterns


def make_handler(api_handler_module):
    patterns = _route_patterns(api_handler_module._ROUTES)

    class Handler(BaseHTTPRequestHandler):
        def _cors(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "content-type")

        def _send(self, status: int, payload: dict | None, headers: dict | None = None) -> None:
            body = json.dumps(payload).encode("utf-8") if payload is not None else b""
            self.send_response(status)
            self._cors()
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass  # the browser aborted the request (e.g. a page navigation); nothing to report

        def do_OPTIONS(self) -> None:  # noqa: N802 - http.server API
            self._send(204, None)

        def do_GET(self) -> None:  # noqa: N802 - http.server API
            parts = urlsplit(self.path)
            if not parts.path.startswith("/dashboard/"):
                self._send(404, {"error": f"Not served by the local API server: {parts.path}"})
                return
            for method, pattern, route_key in patterns:
                match = pattern.match(parts.path)
                if method == "GET" and match:
                    event = {
                        "routeKey": route_key,
                        "queryStringParameters": dict(parse_qsl(parts.query, keep_blank_values=True)) or None,
                        "pathParameters": match.groupdict() or None,
                        "headers": {key.lower(): value for key, value in self.headers.items()},
                        "body": None,
                        "isBase64Encoded": False,
                    }
                    response = api_handler_module.lambda_handler(event, None)
                    self._send(response["statusCode"], json.loads(response["body"]), response.get("headers"))
                    return
            self._send(404, {"error": f"No such route: GET {parts.path}"})

        def log_message(self, format: str, *args) -> None:  # noqa: A002 - http.server API
            pass

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--seed-fixture", action="store_true", help="serve seeded creator summaries in place of YobiTrendingCache")
    args = parser.parse_args()

    os.environ.pop("YOBI_STORAGE_BACKEND", None)  # always the local backend
    # The local server has no Firebase project: attestation is explicitly OFF here and nowhere else (production
    # configuration must be `enforce`; see terraform/variables.tf and tests/security).
    os.environ["YOBI_ATTESTATION_MODE"] = "off"
    sys.path.insert(0, str(ROOT / "src"))

    from api import api_handler

    if args.seed_fixture:
        print("--seed-fixture is a no-op: the comparison feature it fed was retired (PR #60)", flush=True)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(api_handler))
    print(f"local API server on http://127.0.0.1:{args.port} (seeded: {args.seed_fixture})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
