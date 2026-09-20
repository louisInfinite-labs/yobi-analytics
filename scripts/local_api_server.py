"""Local HTTP server for browser (Playwright) integration tests.

Runs the REAL `api_handler.lambda_handler` -- the same route dispatch,
validation and computation the deployed Lambda runs -- behind a tiny stdlib
HTTP server, against the local JSON storage backend (no AWS). It only serves
the read routes that need no cloud service (`GET /dashboard/*`); every other
route answers 404, so nothing here can reach DynamoDB or Secrets Manager.

`--seed-fixture` writes a small deterministic fixture (Video Master +
daily snapshots for a handful of real Creator Master creators) into a fresh
temporary data directory before serving, so comparison series come from real
stored snapshots. FIXTURE_CREATORS is the single source of those numbers:
each entry is (starting view count on FIRST_DATE, views gained per day) per
video, so a creator's total-views on day N is sum(start + N * gain) and its
daily-view-growth is sum(gain).

    .venv/bin/python scripts/local_api_server.py --port 8787 --seed-fixture
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

ROOT = Path(__file__).resolve().parent.parent

FIRST_DATE = date(2026, 8, 27)
LAST_DATE = date(2026, 9, 7)

# creatorId (Creator Master) -> [(starting view count on FIRST_DATE, views gained per day), ...]
FIXTURE_CREATORS: dict[str, list[tuple[int, int]]] = {
    "gawr_gura": [(1_000_000, 10_000), (500_000, 5_000)],
    "airani_iofifteen": [(800_000, 8_000)],
    "shirakami_fubuki": [(600_000, 6_000), (300_000, 3_000)],
    "usada_pekora": [(2_000_000, 20_000)],
    "aizawa_ema": [(100_000, 1_000)],
}


def seed_fixture() -> None:
    from snapshot_store import Snapshot, save_daily_snapshot
    from video_master import Video, upsert_videos

    videos = []
    for creator_id, streams in FIXTURE_CREATORS.items():
        for index in range(len(streams)):
            videos.append(
                Video(
                    video_id=f"{creator_id}-v{index + 1}",
                    creator_id=creator_id,
                    title=f"{creator_id} video {index + 1}",
                    published_at="2026-08-01T00:00:00Z",
                    activity_state="Hot",
                )
            )
    upsert_videos(videos)

    day = FIRST_DATE
    while day <= LAST_DATE:
        offset = (day - FIRST_DATE).days
        snapshots = [
            Snapshot(
                snapshot_date=day.isoformat(),
                observed_at=f"{day.isoformat()}T18:00:05+09:00",
                creator_id=creator_id,
                video_id=f"{creator_id}-v{index + 1}",
                title=f"{creator_id} video {index + 1}",
                published_at="2026-08-01T00:00:00Z",
                view_count=start + offset * gain,
                organization="hololive",
            )
            for creator_id, streams in FIXTURE_CREATORS.items()
            for index, (start, gain) in enumerate(streams)
        ]
        save_daily_snapshot(snapshots, day)
        day += timedelta(days=1)


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
    parser.add_argument("--seed-fixture", action="store_true", help="serve a fresh, seeded temporary data directory")
    args = parser.parse_args()

    if args.seed_fixture:
        # Must be set before any storage module is imported (json_store reads it at import).
        os.environ["YOBI_DATA_DIR"] = tempfile.mkdtemp(prefix="yobi-local-api-")
    os.environ.pop("YOBI_STORAGE_BACKEND", None)  # always the local JSON backend
    sys.path.insert(0, str(ROOT / "src"))

    import api_handler

    if args.seed_fixture:
        seed_fixture()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(api_handler))
    print(f"local API server on http://127.0.0.1:{args.port} (data dir: {os.environ.get('YOBI_DATA_DIR', 'default')})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
