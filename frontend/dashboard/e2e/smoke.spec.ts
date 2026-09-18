import { test, expect } from "@playwright/test"

/** Minimal proof that this repository's browser-verification tooling
 * actually works end to end: Chromium launches, the real Dashboard
 * frontend (not a fixture page) is reachable under the test runner, and
 * the React app has actually mounted -- not just that the static HTML
 * shell was served. Real MT-16 AC3/AC7 browser evidence is a separate,
 * later step; this file only proves the prerequisite tooling itself. */
test("dashboard app loads in a real browser", async ({ page }) => {
  await page.goto("/")
  await expect(page).toHaveTitle("OshiYobi")
  await expect(page.locator("#root")).not.toBeEmpty()
})
