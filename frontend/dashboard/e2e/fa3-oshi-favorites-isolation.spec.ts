import { test, expect } from "@playwright/test"
import { pinEnglishLocale } from "./helpers/common"

/** FA3 -- Main Oshi + Favorites state isolation, against the real app
 * (never a fixture page). Main Oshi (Settings > Oshi Settings,
 * useDefaultOshiCreator, "yobi.defaultOshiCreatorId") and Favorites
 * (Settings > Favorites List, useFavoriteCreators, "yobi.favoriteCreatorIds")
 * are two entirely separate localStorage-backed stores in production code
 * -- these tests exercise that separation through real navigation/clicks,
 * never by reading localStorage directly. */

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

test("Main Oshi is single-select: picking a new one replaces the previous selection instead of adding to it", async ({ page }) => {
  await page.goto("/setting")
  await page.getByRole("button", { name: "Oshi Settings" }).click()

  await expect(page.getByLabel("Current Main Oshi: 藍沢エマ")).toBeVisible()

  await page.locator(".my-oshi-select__slot-name", { hasText: "兎田ぺこら" }).click()

  await expect(page.getByLabel("Current Main Oshi: 兎田ぺこら")).toBeVisible()
  await expect(page.getByLabel("Current Main Oshi: 藍沢エマ")).toHaveCount(0)
})

test("Favorites (multi-select) and Main Oshi (single-select) never cross-contaminate, a removed Favorite still shows in Live Status, and both persist independently across a reload", async ({
  page,
}) => {
  await page.goto("/setting") // defaults to Favorites List

  await page.locator("label.ant-checkbox-wrapper", { has: page.getByRole("checkbox", { name: "Add 藍沢エマ to favorites" }) }).click()
  await page.locator("label.ant-checkbox-wrapper", { has: page.getByRole("checkbox", { name: "Add 兎田ぺこら to favorites" }) }).click()
  await expect(page.getByRole("checkbox", { name: "Remove 藍沢エマ from favorites" })).toBeChecked()
  await expect(page.getByRole("checkbox", { name: "Remove 兎田ぺこら from favorites" })).toBeChecked()

  // Changing Main Oshi must not silently change (or clear) Favorites.
  await page.getByRole("button", { name: "Oshi Settings" }).click()
  await page.locator(".my-oshi-select__slot-name", { hasText: "兎田ぺこら" }).click()
  await expect(page.getByLabel("Current Main Oshi: 兎田ぺこら")).toBeVisible()

  await page.getByRole("button", { name: "Favorites List" }).click()
  await expect(page.getByRole("checkbox", { name: "Remove 藍沢エマ from favorites" })).toBeChecked()
  await expect(page.getByRole("checkbox", { name: "Remove 兎田ぺこら from favorites" })).toBeChecked()

  // Removing a Favorite (even the current Main Oshi) must not change Main
  // Oshi, and must not remove that creator from Live Status.
  await page.locator("label.ant-checkbox-wrapper", { has: page.getByRole("checkbox", { name: "Remove 兎田ぺこら from favorites" }) }).click()
  await expect(page.getByRole("checkbox", { name: "Add 兎田ぺこら to favorites" })).not.toBeChecked()

  await page.getByRole("button", { name: "Oshi Settings" }).click()
  await expect(page.getByLabel("Current Main Oshi: 兎田ぺこら")).toBeVisible()

  const dock = page.locator(".live-status-dock")
  await dock.locator(".live-status-trigger").click()
  const drawer = page.getByRole("dialog", { name: "Live schedule search" })
  // Default view mode is "all", not "favorites" -- a creator's Live Status
  // membership is never gated on their favorite status.
  await expect(drawer.locator(".live-status-member__name", { hasText: "兎田ぺこら" })).toBeVisible()
  await drawer.getByRole("button", { name: "Close" }).click()

  // Both stores persist independently across a real reload: Favorites
  // keeps 藍沢エマ only, Main Oshi stays 兎田ぺこら.
  await page.reload()

  await expect(page.getByLabel("Current Main Oshi: 兎田ぺこら")).toBeVisible()
  await page.getByRole("button", { name: "Favorites List" }).click()
  await expect(page.getByRole("checkbox", { name: "Remove 藍沢エマ from favorites" })).toBeChecked()
  await expect(page.getByRole("checkbox", { name: "Add 兎田ぺこら to favorites" })).not.toBeChecked()
})
