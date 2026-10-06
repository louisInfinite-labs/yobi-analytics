import { test, expect, smokeApiBaseURL, SMOKE_GUARD_HEADER } from "./helpers"
import { pinEnglishLocale } from "../helpers/common"

/** docs/testing/V1_PRODUCTION_E2E_SMOKE_TEST.md, "Write policy": the smoke
 * suite is read-only against its API target. Every non-GET request a page
 * makes to that target is answered by the harness (helpers.ts's
 * installReadOnlyApiGuard) and never forwarded -- the response carries a
 * header only the guard can produce, which is how these tests tell a stub
 * from a real API answer. */
test.describe("V1 smoke: read-only API write guard", () => {
  test("the Dashboard's own heartbeat POST is attempted, intercepted by the guard, and never reaches the API", async ({ page, apiWriteGuard }) => {
    await pinEnglishLocale(page)
    const heartbeatResponse = page.waitForResponse((response) => response.url().endsWith("/heartbeat") && response.request().method() === "POST")

    await page.goto("/dashboard")
    const response = await heartbeatResponse

    // The app attempted the write ...
    expect(response.request().postDataJSON()).toMatchObject({ clientId: expect.any(String) })
    // ... the guard (not the API) answered it ...
    expect(response.headers()[SMOKE_GUARD_HEADER]).toBe("blocked")
    expect(apiWriteGuard.blocked).toContainEqual({ method: "POST", path: "/heartbeat" })
    // ... and nothing but non-GET stubs was ever recorded as blocked.
    expect(apiWriteGuard.blocked.every((entry) => entry.method !== "GET")).toBe(true)
  })

  test("any other non-GET method to the API target is stubbed locally, while GET still reaches the API", async ({ page, apiWriteGuard }) => {
    await page.goto("/")
    const apiBase = smokeApiBaseURL()

    const results = await page.evaluate(async (base) => {
      const outcome: Record<string, string | null> = {}
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const response = await fetch(`${base}/clients/00000000-0000-4000-8000-000000000000/credential`, { method, body: method === "DELETE" ? undefined : "{}" })
        outcome[method] = response.headers.get("x-smoke-guard")
      }
      const get = await fetch(`${base}/dashboard/chart-catalog`)
      outcome.GET = get.headers.get("x-smoke-guard")
      return outcome
    }, apiBase)

    expect(results).toEqual({ POST: "blocked", PUT: "blocked", PATCH: "blocked", DELETE: "blocked", GET: null })
    expect(apiWriteGuard.blocked.map((entry) => entry.method)).toEqual(expect.arrayContaining(["POST", "PUT", "PATCH", "DELETE"]))
  })
})
