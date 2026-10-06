import { test as base, expect, type Page, type Route } from "@playwright/test"
import { DEFAULT_SMOKE_API_BASE_URL } from "../../playwright.smoke.config"

/** The backend base URL this smoke run targets -- the real deployed API when
 * SMOKE_API_BASE_URL is set (see the MD's Preconditions table for why that
 * isn't done automatically from this repo), else this config's own local
 * fixture (scripts/local_api_server.py --enable-smoke-routes). */
export function smokeApiBaseURL(): string {
  return process.env.SMOKE_API_BASE_URL || DEFAULT_SMOKE_API_BASE_URL
}

/** Response header only the guard below can produce, so a test can tell a
 * locally stubbed response apart from one that really came from the API. */
export const SMOKE_GUARD_HEADER = "x-smoke-guard"

export interface BlockedWrite {
  method: string
  path: string
}

/** What the read-only guard has intercepted on one page so far. */
export interface ApiWriteGuard {
  blocked: BlockedWrite[]
}

/** Installs the read-only guard on `page`: every non-GET/HEAD request to the
 * smoke API target is answered locally with a stub and never forwarded, so
 * the suite cannot write to the target API -- most importantly the real
 * production API when SMOKE_API_BASE_URL is set. The Dashboard page, for
 * one, fires `POST /heartbeat` on mount (app behavior, deliberately left
 * unchanged); this is what keeps that and any future accidental write from
 * navigation read-only. GET/HEAD requests pass through untouched. Browser
 * CORS preflights are answered by Playwright itself for routed requests, so
 * they never reach the target either. */
export async function installReadOnlyApiGuard(page: Page): Promise<ApiWriteGuard> {
  const guard: ApiWriteGuard = { blocked: [] }
  const apiOrigin = new URL(smokeApiBaseURL()).origin

  await page.route(
    (url) => url.origin === apiOrigin,
    async (route: Route) => {
      const request = route.request()
      const method = request.method()
      if (method === "GET" || method === "HEAD") {
        await route.continue()
        return
      }
      guard.blocked.push({ method, path: new URL(request.url()).pathname })
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {
          "access-control-allow-origin": "*",
          "access-control-expose-headers": SMOKE_GUARD_HEADER,
          [SMOKE_GUARD_HEADER]: "blocked",
        },
        body: JSON.stringify({ blockedBySmokeGuard: true }),
      })
    },
  )
  return guard
}

/** Drop-in replacement for Playwright's `test` for every spec that drives a
 * browser page: the read-only guard is installed automatically on each test's
 * page, so a new spec cannot forget it. */
export const test = base.extend<{ apiWriteGuard: ApiWriteGuard }>({
  apiWriteGuard: [
    async ({ page }, use) => {
      await use(await installReadOnlyApiGuard(page))
    },
    { auto: true },
  ],
})

export { expect }
