"""The single source of truth that classifies every API route for the security tests (SEC-TEST-001, roadmap MT-01).

App Check enforcement, route throttling and the negative-test suites all derive from this table, so a new or removed
route cannot slip past them: tests/security/test_route_inventory.py fails until this table is updated deliberately.
"""

from __future__ import annotations

# Route classes (baseline section 10):
RETIRED = "retired"  # answers a fixed 410 and does no data-plane work; exempt from attestation
PUBLIC_READ = "public_read"  # public analytics/live data, read-only
PUBLIC_LIVENESS = "public_liveness"  # client liveness write/read, no credential
CLIENT_BOOTSTRAP = "client_bootstrap"  # first-claimant-wins credential issuance, no credential
CLIENT_SCOPED = "client_scoped"  # requires the per-client secret (X-Client-Secret)
ADMIN = "admin"  # requires the admin key (X-Admin-Key)

ROUTE_CLASSES: dict[str, str] = {
    "GET /videos/{videoId}/growth": PUBLIC_READ,
    "GET /dashboard/chart-catalog": PUBLIC_READ,
    "GET /topics": PUBLIC_READ,
    "GET /subscribers/leaderboard": PUBLIC_READ,
    "GET /creators/{creatorId}/videos/ranking": PUBLIC_READ,
    "GET /creators/{creatorId}/videos/recent": PUBLIC_READ,
    "GET /creators/{creatorId}/oshi-status": PUBLIC_READ,
    "GET /live-streams": PUBLIC_READ,
    "GET /recent-streams": PUBLIC_READ,
    "POST /heartbeat": PUBLIC_LIVENESS,
    "GET /heartbeat/{clientId}/status": PUBLIC_LIVENESS,
    "POST /clients/{clientId}/credential": CLIENT_BOOTSTRAP,
    "GET /remote-config": CLIENT_SCOPED,
    "PUT /clients/{clientId}/push-subscription": CLIENT_SCOPED,
    "DELETE /clients/{clientId}/push-subscription": CLIENT_SCOPED,
    "PUT /clients/{clientId}/notification-preference": CLIENT_SCOPED,
    "POST /remote-config": ADMIN,
    "GET /admin/heartbeat-stats": ADMIN,
    "GET /creators/{creatorId}/trending": RETIRED,
    "GET /organizations/{organization}/trending": RETIRED,
    "GET /leaderboard": RETIRED,
    "GET /organizations/{organization}/leaderboard": RETIRED,
    "GET /topics/{topic}/leaderboard": RETIRED,
}


def routes_in_class(*classes: str) -> set[str]:
    """Every route whose class is one of `classes`."""
    return {route for route, cls in ROUTE_CLASSES.items() if cls in classes}


# At V1 launch every route except the retired-410 answers requires a valid App Check token (baseline section 7.7).
ATTESTED_ROUTES: set[str] = set(ROUTE_CLASSES) - routes_in_class(RETIRED)
CLIENT_SCOPED_ROUTES: set[str] = routes_in_class(CLIENT_SCOPED)
ADMIN_ROUTES: set[str] = routes_in_class(ADMIN)

# SEC-API-003 launch route set: the public write routes, the admin routes, the Holodex-backed routes and the creator-read
# routes that can starve shared availability. Each needs an explicit `rate` AND `burst` (terraform var.launch_route_throttles).
LAUNCH_THROTTLED_ROUTES: set[str] = {
    "POST /heartbeat",
    "POST /clients/{clientId}/credential",
    "GET /live-streams",
    "GET /recent-streams",
    "GET /creators/{creatorId}/videos/ranking",
    "GET /creators/{creatorId}/videos/recent",
    "GET /creators/{creatorId}/oshi-status",
    "POST /remote-config",
    "GET /admin/heartbeat-stats",
}
