import type { Page } from "@playwright/test"
import { test, expect } from "./helpers"
import { pinEnglishLocale, trackPageErrors, trackConsoleErrors } from "../helpers/common"

/** docs/testing/V1_PRODUCTION_E2E_SMOKE_TEST.md, case A (Application
 * shell) -- the only genuinely new automated coverage that section needs:
 * the existing e2e/smoke.spec.ts proves the tooling mounts the app at all,
 * but not console-cleanliness, routing, or refresh. */

/** MainNavbar specifically -- Settings also renders its own secondary
 * "Settings navigation" landmark, so a bare getByRole("navigation") is
 * ambiguous there. */
function mainNavbar(page: Page) {
  return page.getByRole("navigation", { name: "Main navigation" })
}

/** Resource-load failures the browser itself logs as console.error (never
 * something the app's own code called console.error for) are expected
 * noise in this local run: scripts/local_api_server.py's --enable-smoke-routes
 * allowlist deliberately excludes the S3-backed per-creator routes Home's
 * real data hooks call (see api-contract.spec.ts's module docstring for
 * why), so those calls 404 here regardless of app correctness. A run
 * against SMOKE_API_BASE_URL/SMOKE_FRONTEND_URL pointed at the real
 * deployed backend has real data behind every one of those routes and
 * should see zero such messages too -- this filter exists for the local
 * fixture's own known data gap, not to hide a genuine app-level warning.
 */
function isKnownLocalFixtureNoise(message: string): boolean {
  return message.startsWith("Failed to load resource:")
}

/** A1-A6's shared assertion: zero uncaught exceptions, zero real
 * console.error (filtered for the local-fixture-only noise above), on
 * whatever page state the caller has already driven the page to. */
function expectNoShellErrors(pageErrors: string[], consoleErrors: string[]) {
  expect(pageErrors).toEqual([])
  expect(consoleErrors.filter((message) => !isKnownLocalFixtureNoise(message))).toEqual([])
}

test.describe("V1 smoke: application shell", () => {
  test("loads with a fixed left navbar and no console/page errors", async ({ page }) => {
    await pinEnglishLocale(page)
    const pageErrors = trackPageErrors(page)
    const consoleErrors = trackConsoleErrors(page)

    await page.goto("/")

    await expect(page).toHaveTitle("OshiYobi")
    await expect(page.locator("#root")).not.toBeEmpty()
    await expect(mainNavbar(page)).toBeVisible()
    expectNoShellErrors(pageErrors, consoleErrors)
  })

  test("Home has no unintended whole-page vertical scroll", async ({ page }) => {
    await pinEnglishLocale(page)
    await page.goto("/")
    await expect(mainNavbar(page)).toBeVisible()

    const { scrollHeight, viewportHeight } = await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
    }))
    expect(scrollHeight).toBeLessThanOrEqual(viewportHeight + 4)
  })

  for (const route of ["/dashboard", "/setting", "/schedule"] as const) {
    test(`direct navigation to ${route} renders its own content with no errors`, async ({ page }) => {
      await pinEnglishLocale(page)
      const pageErrors = trackPageErrors(page)
      const consoleErrors = trackConsoleErrors(page)

      await page.goto(route)

      await expect(mainNavbar(page)).toBeVisible()
      await expect(page.locator("#root")).not.toBeEmpty()
      expectNoShellErrors(pageErrors, consoleErrors)
    })

    test(`hard refresh on ${route} reloads the same route correctly, with no errors`, async ({ page }) => {
      await pinEnglishLocale(page)
      await page.goto(route)
      await expect(mainNavbar(page)).toBeVisible()

      const pageErrors = trackPageErrors(page)
      const consoleErrors = trackConsoleErrors(page)
      await page.reload()

      await expect(page).toHaveURL(new RegExp(`${route}$`))
      await expect(mainNavbar(page)).toBeVisible()
      await expect(page.locator("#root")).not.toBeEmpty()
      expectNoShellErrors(pageErrors, consoleErrors)
    })
  }
})
