"""Local HTTP server for browser (Playwright) integration tests.

Runs the REAL `api_handler.lambda_handler` -- the same route dispatch,
validation and computation the deployed Lambda runs -- behind a tiny stdlib
HTTP server, against the local JSON storage backend (no AWS). By default it
only serves the read routes that need no cloud service (`GET /dashboard/*`);
every other route answers 404.

`--enable-smoke-routes` additionally serves a small, hand-picked allowlist of
routes used by the V1 production-smoke API-contract spec
(`e2e/smoke/api-contract.spec.ts`, via its own `playwright.smoke.config.ts`):
`GET /live-streams`, `GET /recent-streams`, `GET /topics`,
`GET /videos/{videoId}/growth`, `GET /about-content` -- each independently
confirmed to only ever touch the local JSON storage backend, read a
module-level static constant (no I/O at all), fail closed with a clean 503
`HOLODEX_UNAVAILABLE` when no Holodex key is configured rather than making
a real outbound call (the two Holodex-sourced routes), or (GET
/about-content) read from the committed local content directory instead of
real S3 -- see the YOBI_ABOUT_CONTENT_DIR note in `main()` below.

AWS Secrets Manager guarantee for the two Holodex-sourced routes:
`get_holodex_api_key()` (`src/ops/config.py`, production code, left entirely
unmodified) checks `HOLODEX_SECRET_NAME` first and calls Secrets Manager (a
real AWS call) if it's set -- that env var is a deployed-Lambda convention,
not a local-dev one (`.env`/`HOLODEX_API_KEY` is), so it would be unusual for
it to be ambient here, but "unusual" isn't a guarantee. `main()` below
unconditionally pops `HOLODEX_SECRET_NAME` from this process's own
environment before importing `api_handler`, regardless of what the calling
shell had set -- so this script can never trigger that Secrets Manager call,
full stop, without touching Holodex's own key-resolution code at all. A
locally-configured plaintext `HOLODEX_API_KEY` (the intended local-dev path)
is unaffected and still makes a real (third-party, non-AWS) Holodex call if
present -- that's expected, not a gap this script needs to prevent.

Deliberately NOT included in that allowlist, even though they are real GET
routes: `GET /creators/{creatorId}/videos/ranking`, `GET /creators/{creatorId}/videos/recent`,
`GET /creators/{creatorId}/oshi-status`, and `GET /subscribers/leaderboard`.
All four go through `S3VideoRankingStore.from_environment_or_default()`
(`src/stores/video_ranking_store.py`), which -- when `YOBI_HISTORY_BUCKET`
isn't set, which it never is here -- falls back to the real **production**
history bucket via a real `boto3.client("s3")`. Serving them locally would
risk a live read against production S3 using whatever AWS credentials happen
to be ambient on the machine running this script. If a future task wants to
exercise those routes locally, it needs its own local/stub S3 wiring first,
not a widening of this allowlist.

This flag is opt-in and changes nothing for the existing
`playwright.config.ts` webServer invocation, which never passes it. Only GET
is ever dispatched (no `do_POST`/`do_PUT`/`do_DELETE` exists on the handler
below), so nothing here can mutate anything regardless.

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

# See the module docstring for why this list stops here (S3-backed routes
# are deliberately excluded -- they default to the real production bucket).
# GET /about-content IS S3-backed in production, but main() below always
# points it at the local content directory instead (YOBI_ABOUT_CONTENT_DIR),
# so serving it here never risks a real S3 call.
SMOKE_SAFE_ROUTE_KEYS = frozenset({
    "GET /live-streams",
    "GET /recent-streams",
    "GET /topics",
    "GET /videos/{videoId}/growth",
    "GET /about-content",
})


def _route_patterns(routes: dict) -> list[tuple[str, re.Pattern[str], str]]:
    patterns = []
    for route_key in routes:
        method, template = route_key.split(" ", 1)
        regex = re.sub(r"\{(\w+)\}", r"(?P<\1>[^/]+)", template)
        patterns.append((method, re.compile(f"^{regex}$"), route_key))
    return patterns


def make_handler(api_handler_module, *, enable_smoke_routes: bool = False):
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
            excluded_by_fixture = False
            for method, pattern, route_key in patterns:
                if method != "GET" or not pattern.match(parts.path):
                    continue
                if not (route_key.startswith("GET /dashboard/") or (enable_smoke_routes and route_key in SMOKE_SAFE_ROUTE_KEYS)):
                    excluded_by_fixture = True
                    continue
                match = pattern.match(parts.path)
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
            if excluded_by_fixture:
                self._send(404, {"error": f"Not served by this test fixture (see local_api_server.py's module docstring): {parts.path}"})
            else:
                self._send(404, {"error": f"No such route: GET {parts.path}"})

        def log_message(self, format: str, *args) -> None:  # noqa: A002 - http.server API
            pass

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--seed-fixture", action="store_true", help="serve seeded creator summaries in place of YobiTrendingCache")
    parser.add_argument("--enable-smoke-routes", action="store_true", help="also serve SMOKE_SAFE_ROUTE_KEYS (see module docstring)")
    args = parser.parse_args()

    os.environ.pop("YOBI_STORAGE_BACKEND", None)  # always the local backend
    # get_holodex_api_key() (src/ops/config.py) checks this first and, if
    # set, calls Secrets Manager -- a real AWS call. It's a deployed-Lambda
    # convention this script's own process should never inherit, but
    # clearing it here (rather than just documenting the assumption) makes
    # that structurally true regardless of what's ambient in the calling
    # shell. See this module's own docstring for the full reasoning.
    os.environ.pop("HOLODEX_SECRET_NAME", None)
    # about_content_api.get_about_content() is S3-backed in production
    # (yobi-analytics-history bucket, "about/" prefix). Pointing it at the
    # committed local copy instead -- unconditionally, not just under
    # --enable-smoke-routes -- means this script can never make a real S3
    # call for this route even if the allowlist above were ever widened by
    # mistake. Same defensive posture as the HOLODEX_SECRET_NAME pop above.
    os.environ["YOBI_ABOUT_CONTENT_DIR"] = str(ROOT / "src" / "content" / "about")
    sys.path.insert(0, str(ROOT / "src"))

    from api import api_handler

    if args.seed_fixture:
        print("--seed-fixture is a no-op: the comparison feature it fed was retired (PR #60)", flush=True)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(api_handler, enable_smoke_routes=args.enable_smoke_routes))
    print(f"local API server on http://127.0.0.1:{args.port} (seeded: {args.seed_fixture}, smoke_routes: {args.enable_smoke_routes})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
