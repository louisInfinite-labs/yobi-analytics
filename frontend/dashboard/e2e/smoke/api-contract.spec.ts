import { test, expect } from "@playwright/test"
import { smokeApiBaseURL } from "./helpers"

/** docs/testing/V1_PRODUCTION_E2E_SMOKE_TEST.md, case M (API failure
 * states) and the Holodex-degradation rows of case N -- hits the real
 * `api_handler.lambda_handler` dispatch directly over HTTP (no page/browser
 * involved) to prove the deployed contract, not re-derive it: the exact
 * status/`code` mapping for each of these is already exhaustively unit-
 * tested in tests/api/test_api_handler.py with mocked dependencies; this
 * spec only proves the real, running target actually answers that way.
 *
 * Against the local fixture (default), this exercises
 * scripts/local_api_server.py's `--enable-smoke-routes` allowlist:
 * /live-streams, /recent-streams, /topics, /videos/{id}/growth -- the ones
 * independently confirmed to never touch real AWS. The three
 * HISTORICAL_DATA_UNAVAILABLE routes (oshi-status, videos/ranking,
 * videos/recent) are S3-backed in production and are deliberately NOT
 * exposed by that local allowlist (see its module docstring) -- those
 * assertions below only run when pointed at a real target via
 * SMOKE_API_BASE_URL. */
test.describe("V1 smoke: API contract", () => {
  test("an unknown route returns a clean 404, not a fabricated 200", async ({ request }) => {
    const response = await request.get(`${smokeApiBaseURL()}/this-route-does-not-exist`)
    expect(response.status()).toBe(404)
    const body = await response.json()
    expect(typeof body.error).toBe("string")
  })

  test("GET /live-streams answers either real data or a clean Holodex-unavailable 503, never a silent empty 200 mislabeled as success", async ({ request }) => {
    const response = await request.get(`${smokeApiBaseURL()}/live-streams`)
    const body = await response.json()
    if (response.status() === 200) {
      expect(Array.isArray(body.streams ?? body)).toBe(true)
    } else {
      expect(response.status()).toBe(503)
      expect(body.code).toBe("HOLODEX_UNAVAILABLE")
    }
  })

  test("GET /recent-streams without a creatorId is a clean 4xx, never a 500 or a fabricated 200", async ({ request }) => {
    // creatorId is required (resolved against Creator Master before any
    // Holodex call) -- omitting it must fail validation cleanly, not crash.
    const response = await request.get(`${smokeApiBaseURL()}/recent-streams`)
    expect(response.status()).toBeGreaterThanOrEqual(400)
    expect(response.status()).toBeLessThan(500)
  })

  test("GET /topics returns 200 with a list", async ({ request }) => {
    const response = await request.get(`${smokeApiBaseURL()}/topics`)
    expect(response.status()).toBe(200)
    const body = await response.json()
    expect(Array.isArray(body.topics ?? body)).toBe(true)
  })

  test("GET /videos/{videoId}/growth for an unknown video returns a clean 404, not a 500", async ({ request }) => {
    const response = await request.get(`${smokeApiBaseURL()}/videos/this-video-id-does-not-exist/growth?reportDate=2026-01-01&timeZone=Asia/Tokyo&period=1d`)
    expect(response.status()).toBe(404)
  })

  test("a historical-data-unavailable creator's oshi-status is a clean empty 404, not an error banner trigger", async ({ request }) => {
    test.skip(!process.env.SMOKE_API_BASE_URL, "S3-backed route -- only exercised against a real target (SMOKE_API_BASE_URL), never the local fixture (see this file's module docstring)")
    // Re-verify this id against src/tracking/creator_master.py's
    // HISTORICAL_DATA_UNAVAILABLE_CREATOR_IDS before relying on it -- it is
    // a living list, not a fixed constant.
    const response = await request.get(`${smokeApiBaseURL()}/creators/mano_aloe/oshi-status`)
    expect(response.status()).toBe(404)
    const body = await response.json()
    expect(body.code).toBe("HISTORICAL_DATA_UNAVAILABLE")
  })
})
