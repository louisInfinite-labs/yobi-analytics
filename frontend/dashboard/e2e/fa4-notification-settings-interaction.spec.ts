import { test, expect } from "@playwright/test"
import { pinEnglishLocale, trackConsoleErrors, trackPageErrors } from "./helpers/common"

/** FA4 -- Notification Settings interaction + persistence, against the
 * real app (never a fixture page). Exercises the EXISTING topic
 * master-detail UI only (NotificationSettings.tsx /
 * TopicCreatorManagementDrawer.tsx) -- no per-stream one-time reminder
 * architecture. Topic selection/draft/keyboard behavior is already heavily
 * covered by NotificationSettings.test.tsx (jsdom); these tests instead
 * cover what only a real browser + real localStorage reload can prove:
 * topic-level and per-creator reminder persistence, and that favoriting a
 * creator changes only their grouping/priority in Manage Members, never
 * their notification switches. */

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

async function openNotificationSettings(page: import("@playwright/test").Page) {
  await page.goto("/setting")
  await page.getByRole("button", { name: "Live/Video Notifications" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Push Notifications" })).toBeVisible()
}

test("the Live reminder time choice for a topic persists across a reload, with no console errors or unhandled rejections", async ({ page }) => {
  const errors = trackPageErrors(page)
  const consoleErrors = trackConsoleErrors(page)
  await openNotificationSettings(page)

  // "All" is the first of the 5 permanent default topics, selected by
  // default on first load.
  await expect(page.getByRole("button", { name: /^All/ })).toHaveAttribute("aria-current", "true")

  const reminderControl = page.locator('[aria-label="Live reminder time All"]')
  await expect(reminderControl.getByText("10 minutes before", { exact: true })).toBeVisible() // INITIAL_TOPIC_REMINDER_MODE
  await reminderControl.getByText("1 hour before", { exact: true }).click()

  await page.reload()
  await page.getByRole("button", { name: "Live/Video Notifications" }).click()

  await expect(page.locator('[aria-label="Live reminder time All"] .ant-segmented-item-selected')).toHaveText("1 hour before")
  expect(errors).toEqual([])
  expect(consoleErrors).toEqual([])
})

test("enabling Live for a creator in Manage Members, and their own reminder-time dropdown choice, both persist across a reload", async ({ page }) => {
  await openNotificationSettings(page)

  await page.getByRole("button", { name: "Manage Members All" }).click()
  const drawer = page.locator(".topic-creator-drawer")
  await expect(drawer).toBeVisible()

  const liveSwitch = drawer.getByRole("switch", { name: "藍沢エマ live notifications" })
  await expect(liveSwitch).not.toBeChecked()
  await liveSwitch.click()
  await expect(liveSwitch).toBeChecked()

  const reminderTrigger = drawer.getByRole("button", { name: "藍沢エマ's reminder time" })
  await expect(reminderTrigger).toHaveText("10 minutes before") // INITIAL_MEMBER_REMINDER
  await reminderTrigger.click()
  await page.getByRole("menuitem", { name: "1 hour before" }).click()
  await expect(reminderTrigger).toHaveText("1 hour before")

  await page.keyboard.press("Escape") // closes the Drawer

  await page.reload()
  await page.getByRole("button", { name: "Live/Video Notifications" }).click()
  await page.getByRole("button", { name: "Manage Members All" }).click()

  await expect(drawer.getByRole("switch", { name: "藍沢エマ live notifications" })).toBeChecked()
  await expect(drawer.getByRole("button", { name: "藍沢エマ's reminder time" })).toHaveText("1 hour before")
})

test("a Favorite surfaces first under its own Favorites group in Manage Members, but is never auto-enabled for Live/New Video notifications", async ({
  page,
}) => {
  // Real Favorites List interaction (not a localStorage shortcut) --
  // favoriting is owned by Settings > Favorites List, a different feature
  // than Notification Settings.
  await page.goto("/setting")
  await page.locator("label.ant-checkbox-wrapper", { has: page.getByRole("checkbox", { name: "Add 兎田ぺこら to favorites" }) }).click()
  await expect(page.getByRole("checkbox", { name: "Remove 兎田ぺこら from favorites" })).toBeChecked()

  await page.getByRole("button", { name: "Live/Video Notifications" }).click()
  await page.getByRole("button", { name: "Manage Members All" }).click()
  const drawer = page.locator(".topic-creator-drawer")
  await expect(drawer).toBeVisible()

  const favoritesGroup = drawer.locator(".topic-creator-drawer__group", { has: page.getByRole("heading", { level: 3, name: "Favorites" }) })
  await expect(favoritesGroup).toBeVisible()
  const favoriteRow = favoritesGroup.locator(".topic-creator-drawer__row", { hasText: "兎田ぺこら" })
  await expect(favoriteRow).toBeVisible()

  // UI priority only -- favoriting must never flip either notification
  // switch on by itself.
  await expect(favoriteRow.getByRole("switch", { name: "兎田ぺこら live notifications" })).not.toBeChecked()
  await expect(favoriteRow.getByRole("switch", { name: "兎田ぺこら new video notifications" })).not.toBeChecked()
})
