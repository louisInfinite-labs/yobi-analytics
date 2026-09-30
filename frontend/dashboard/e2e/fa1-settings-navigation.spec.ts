import { test, expect, type Page } from "@playwright/test"
import { pinEnglishLocale, trackConsoleErrors, trackPageErrors } from "./helpers/common"

/** FA1 -- Settings navigation + persistence, against the real app (never a
 * fixture page). schedule-and-settings.spec.ts already covers each
 * section's OWN persisted value surviving a reload (Favorites checkbox,
 * Main Oshi pick, Display's time format/upcoming mode) individually -- this
 * file's own job is the two things that aren't covered anywhere yet:
 * switching through every one of the four sections (including Live/Video
 * Notifications, which the existing suite's own nav-switching test never
 * visits) without a console error/thrown exception/unhandled rejection, and
 * confirming each section's own nav-active-state + content survive a reload
 * -- using this app's CURRENT heading/selector for every section (the
 * existing combined reload test asserts a heading ("MAIN OSHI SELECT") and
 * a class (".notification-settings") that a since-landed redesign renamed;
 * see this task's own final report for that pre-existing baseline failure,
 * left untouched here per this task's scope). */

test.beforeAll(async ({ browser }, testInfo) => {
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL })
  const page = await context.newPage()
  await page.goto("/setting")
  await page.waitForLoadState("networkidle")
  await context.close()
})

test.beforeEach(async ({ page }) => {
  await pinEnglishLocale(page)
})

/** Each section's own current, stable content marker -- a page-level <h1>
 * for every section (every one of MyOshiSettings/OshiSettings/
 * NotificationSettings/DisplaySettings renders its own settings-page-title
 * as a real <h1>), so this never depends on a CSS class name a future
 * redesign might rename again. */
const SETTINGS_SECTIONS = [
  { navLabel: "Oshi Settings", heading: "Oshi Settings" },
  { navLabel: "Favorites List", heading: "My Favorites" },
  { navLabel: "Live/Video Notifications", heading: "Push Notifications" },
  { navLabel: "Display", heading: "Display" },
] as const

async function expectSectionActive(page: Page, section: (typeof SETTINGS_SECTIONS)[number]) {
  const nav = page.getByRole("navigation", { name: "Settings navigation" })
  await expect(nav.getByRole("button", { name: section.navLabel })).toHaveAttribute("aria-current", "page")
  await expect(page.getByRole("heading", { level: 1, name: section.heading })).toBeVisible()
}

test("switching through every Settings section, including Live/Video Notifications, produces no console errors, thrown exceptions, or unhandled rejections", async ({
  page,
}) => {
  const pageErrors = trackPageErrors(page)
  const consoleErrors = trackConsoleErrors(page)
  await page.goto("/setting")
  const nav = page.getByRole("navigation", { name: "Settings navigation" })

  // Round-trips through all four, ending back where it started, so a
  // regression that only shows up on the SECOND visit to a section (e.g. a
  // stale draft/effect not cleaned up on unmount) isn't missed.
  const order = [...SETTINGS_SECTIONS, SETTINGS_SECTIONS[1]]
  for (const section of order) {
    await nav.getByRole("button", { name: section.navLabel }).click()
    await expectSectionActive(page, section)
  }

  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
})

test("every Settings section keeps its own nav item active and its own content visible across a real page reload", async ({ page }) => {
  await page.goto("/setting")
  const nav = page.getByRole("navigation", { name: "Settings navigation" })

  for (const section of SETTINGS_SECTIONS) {
    await nav.getByRole("button", { name: section.navLabel }).click()
    await expectSectionActive(page, section)

    await page.reload()

    await expectSectionActive(page, section)
  }
})
