import { test, expect, type Page } from "@playwright/test"

/** First-round browser smoke tests for the Live Schedule page and the
 * Settings sections 我推設定 / 收藏名單 / 顯示設定, against the real app (never a
 * fixture page). Each test gets a fresh browser context, so localStorage
 * starts empty; the locale is pinned to English so labels are stable. Real
 * page reloads are used to prove persistence, which jsdom can only simulate. */

// Vite's dev server optimizes dependencies on the first page load and may
// reload the page once while doing so; visit both routes once up front so no
// individual test races that one-time cold start.
test.beforeAll(async ({ browser }, testInfo) => {
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL })
  const page = await context.newPage()
  for (const route of ["/schedule", "/setting"]) {
    await page.goto(route)
    await page.waitForLoadState("networkidle")
  }
  await context.close()
})

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.localStorage.getItem("yobi.locale")) window.localStorage.setItem("yobi.locale", "en")
  })
})

/** Collects uncaught page exceptions so a test can assert none happened. */
function trackPageErrors(page: Page): string[] {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  return errors
}

/** Picks an option from an antd Select identified by its accessible name. */
async function chooseOption(page: Page, selectName: string, optionText: string) {
  await page.getByRole("combobox", { name: selectName }).click()
  await page.locator(".ant-select-item-option-content", { hasText: optionText }).click()
}

test.describe("Live Schedule page", () => {
  test("renders a full-day Sunday-to-Saturday timetable without errors or page overflow", async ({ page }) => {
    const errors = trackPageErrors(page)
    await page.goto("/schedule")

    await expect(page.getByRole("heading", { name: "Live Schedule" })).toBeVisible()
    await expect(page.locator(".schedule-day-header")).toHaveCount(7)
    await expect(page.locator(".day-name")).toHaveText(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"])
    await expect(page.locator(".schedule-day-header.is-today")).toHaveCount(1)

    const hourLabels = page.locator(".time-label", { hasText: ":00" })
    await expect(hourLabels).toHaveCount(24)
    await expect(hourLabels.first()).toHaveText("00:00")
    await expect(hourLabels.last()).toHaveText("23:00")
    for (const rows of await page.locator(".day-timeline").evaluateAll((nodes) => nodes.map((node) => node.children.length))) {
      expect(rows).toBe(48)
    }

    const overflowsHorizontally = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    expect(overflowsHorizontally).toBe(false)
    expect(errors).toEqual([])
  })

  test("keeps the day headers visible while the timetable scrolls to the last row", async ({ page }) => {
    await page.goto("/schedule")
    const grid = page.locator(".schedule-grid")
    await expect(grid).toBeVisible()

    await grid.evaluate((node) => {
      node.scrollTop = node.scrollHeight
    })

    await expect(page.locator(".schedule-day-header").first()).toBeInViewport()
    await expect(page.locator(".time-header")).toBeInViewport()
    expect(await grid.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
  })

  test("pages between weeks with the Previous and Next buttons", async ({ page }) => {
    await page.goto("/schedule")
    const label = page.locator(".week-selector__label")
    const thisWeek = await label.textContent()

    await page.getByRole("button", { name: "Next week" }).click()
    await expect(label).not.toHaveText(thisWeek!)

    await page.getByRole("button", { name: "Previous week" }).click()
    await expect(label).toHaveText(thisWeek!)
  })

  test("opens a stream from its avatar, shows the detail dialog, and closes it with Escape", async ({ page }) => {
    await page.goto("/schedule")

    await page.locator(".stream-avatar-button").first().click()

    // Scoped to the stream modal: the Live Status drawer is also a (hidden) role="dialog".
    const dialog = page.locator(".stream-detail-dialog").getByRole("dialog")
    await expect(dialog).toBeVisible()
    await expect(dialog.locator(".creator-detail-name")).not.toBeEmpty()
    await expect(dialog.locator(".stream-detail-title")).not.toBeEmpty()
    await expect(dialog.getByRole("button", { name: "Set Reminder" })).toBeDisabled()
    await expect(dialog.getByRole("button", { name: "Open Stream" })).toBeEnabled()

    await page.keyboard.press("Escape")
    await expect(dialog).toBeHidden()
  })

  test("Open Stream shows only the YouTube player, which closes on Escape or a backdrop click", async ({ page }) => {
    await page.goto("/schedule")
    const backdrop = page.locator(".video-player-modal__backdrop")

    await page.locator(".stream-avatar-button").first().click()
    await page.getByRole("button", { name: "Open Stream" }).click()
    await expect(backdrop).toBeVisible()
    await expect(backdrop.locator("iframe")).toHaveCount(1)
    await expect(backdrop.getByRole("button")).toHaveCount(0)
    await page.keyboard.press("Escape")
    await expect(backdrop).toBeHidden()

    await page.locator(".stream-avatar-button").first().click()
    await page.getByRole("button", { name: "Open Stream" }).click()
    await expect(backdrop).toBeVisible()
    await backdrop.click({ position: { x: 5, y: 5 } })
    await expect(backdrop).toBeHidden()
  })
})

test.describe("Settings sections", () => {
  test("lists the four sections, opens Favorites List first, and switches content on selection", async ({ page }) => {
    const errors = trackPageErrors(page)
    await page.goto("/setting")

    const nav = page.getByRole("navigation", { name: "Settings navigation" })
    await expect(nav.locator(".settings-secondary-navbar__link")).toHaveText([
      "Oshi Settings",
      "Favorites List",
      "Live/Video Notifications",
      "Display",
    ])
    await expect(nav.getByRole("button", { name: "Favorites List" })).toHaveAttribute("aria-current", "page")
    await expect(page.getByRole("heading", { name: "My Favorites" })).toBeVisible()

    await nav.getByRole("button", { name: "Oshi Settings" }).click()
    await expect(page.getByRole("heading", { name: "MAIN OSHI SELECT" })).toBeVisible()

    await nav.getByRole("button", { name: "Display" }).click()
    await expect(page.getByRole("heading", { level: 1, name: "Display" })).toBeVisible()
    expect(errors).toEqual([])
  })

  test("Favorites List: favorites persist across a page reload", async ({ page }) => {
    await page.goto("/setting")

    // Click the tile's label (checkbox + avatar + name), as a user would.
    await page.locator("label.ant-checkbox-wrapper", { has: page.getByRole("checkbox", { name: "Add 藍沢エマ to favorites" }) }).click()
    await expect(page.getByRole("checkbox", { name: "Remove 藍沢エマ from favorites" })).toBeChecked()

    await page.reload()

    await expect(page.getByRole("checkbox", { name: "Remove 藍沢エマ from favorites" })).toBeChecked()
  })

  test("Oshi Settings: the chosen Main Oshi persists across a page reload", async ({ page }) => {
    await page.goto("/setting")
    await page.getByRole("button", { name: "Oshi Settings" }).click()
    await expect(page.getByLabel("Current Main Oshi: 藍沢エマ")).toBeVisible()

    await page.locator(".my-oshi-select__slot-name", { hasText: "兎田ぺこら" }).click()
    await expect(page.getByLabel("Current Main Oshi: 兎田ぺこら")).toBeVisible()

    await page.reload()
    await page.getByRole("button", { name: "Oshi Settings" }).click()

    await expect(page.getByLabel("Current Main Oshi: 兎田ぺこら")).toBeVisible()
  })

  test("Oshi Settings: search narrows the roster and shows an empty state for no match", async ({ page }) => {
    await page.goto("/setting")
    await page.getByRole("button", { name: "Oshi Settings" }).click()

    const search = page.locator(".my-oshi-select").getByPlaceholder("Search creators")
    await search.fill("兎田")
    await expect(page.locator(".my-oshi-select__slot-name", { hasText: "兎田ぺこら" })).toBeVisible()
    await expect(page.locator(".my-oshi-select__slot-name", { hasText: "藍沢エマ" })).toHaveCount(0)

    await search.fill("zzzz-no-such-creator")
    await expect(page.getByText("No creators found")).toBeVisible()
  })

  test("Display: the theme changes immediately, and the upcoming-time mode persists across a reload", async ({ page }) => {
    await page.goto("/setting")
    await page.getByRole("button", { name: "Display" }).click()
    const themeRoot = page.locator(".theme-root")
    await expect(themeRoot).toHaveAttribute("data-theme-id", "hololive-jp")

    await chooseOption(page, "Dashboard theme", "VSPO JP — Tactical")
    await expect(themeRoot).toHaveAttribute("data-theme-id", "vspo-jp-tactical")

    await expect(page.getByRole("combobox", { name: "Countdown label language" })).toHaveCount(0)
    await chooseOption(page, "Upcoming stream time display", "Countdown")
    await expect(page.getByRole("combobox", { name: "Countdown label language" })).toBeVisible()

    await page.reload()
    await page.getByRole("button", { name: "Display" }).click()

    await expect(page.getByRole("combobox", { name: "Countdown label language" })).toBeVisible()
  })
})
