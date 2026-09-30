import { test, expect } from "@playwright/test"
import { pinEnglishLocale, trackPageErrors } from "./helpers/common"

/** FA2 -- Live Status interaction, against the real app (never a fixture
 * page). The dock is mounted once above every page (App.tsx), so these
 * navigate to "/" (Home) throughout: Home also renders the Oshi Status
 * panel's own `.oshi-status__creator-name`, the one genuinely
 * user-observable place elsewhere in the app that reflects whichever
 * creator is currently selected (useSelectedCreator/"currentOshi").
 *
 * The drawer itself (`.live-status-drawer`) stays permanently mounted and
 * on-screen-sized even while closed (LiveScheduleDock.tsx: only `inert` and
 * an off-screen `transform` change, no display/visibility toggle), so
 * Playwright's own visible/hidden computation never reports it as hidden --
 * open/closed state is asserted instead through
 * `.live-status-dock[data-live-status-open]`, the same real, production
 * attribute Home's own CSS (home.css) reads to know whether the drawer is
 * open. */

test.beforeAll(async ({ browser }, testInfo) => {
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL })
  const page = await context.newPage()
  await page.goto("/")
  await page.waitForLoadState("networkidle")
  await context.close()
})

test.beforeEach(async ({ page }) => {
  await pinEnglishLocale(page)
})

test("opens on the trigger, focuses search, and the close button dismisses it while returning focus to the trigger", async ({ page }) => {
  const errors = trackPageErrors(page)
  await page.goto("/")

  const dock = page.locator(".live-status-dock")
  const trigger = dock.locator(".live-status-trigger")
  const drawer = page.getByRole("dialog", { name: "Live schedule search" })
  await expect(dock).toHaveAttribute("data-live-status-open", "false")

  await trigger.click()
  await expect(dock).toHaveAttribute("data-live-status-open", "true")
  await expect(drawer).toBeVisible()
  await expect(drawer.locator(".live-status-search input")).toBeFocused()

  await drawer.getByRole("button", { name: "Close" }).click()
  await expect(dock).toHaveAttribute("data-live-status-open", "false")
  await expect(trigger).toBeFocused()
  expect(errors).toEqual([])
})

test("Escape closes the drawer and restores focus to the trigger", async ({ page }) => {
  await page.goto("/")
  const dock = page.locator(".live-status-dock")
  const trigger = dock.locator(".live-status-trigger")

  await trigger.click()
  await expect(dock).toHaveAttribute("data-live-status-open", "true")

  await page.keyboard.press("Escape")
  await expect(dock).toHaveAttribute("data-live-status-open", "false")
  await expect(trigger).toBeFocused()
})

test("clicking outside the drawer closes it without forcing focus back to the trigger", async ({ page }) => {
  await page.goto("/")
  const dock = page.locator(".live-status-dock")
  const trigger = dock.locator(".live-status-trigger")

  await trigger.click()
  await expect(dock).toHaveAttribute("data-live-status-open", "true")

  // A neutral point definitely outside the drawer (which docks to the
  // right edge) -- the same "click away" gesture LiveScheduleDock's own
  // pointerdown-outside listener handles.
  await page.mouse.click(10, 10)
  await expect(dock).toHaveAttribute("data-live-status-open", "false")
  await expect(trigger).not.toBeFocused()
})

test("search narrows the roster to matching creators and shows an empty state for no match", async ({ page }) => {
  await page.goto("/")
  await page.locator(".live-status-trigger").click()
  const drawer = page.getByRole("dialog", { name: "Live schedule search" })
  const search = drawer.locator(".live-status-search input")

  await search.fill("兎田")
  await expect(drawer.locator(".live-status-member__name", { hasText: "兎田ぺこら" })).toBeVisible()
  await expect(drawer.locator(".live-status-member__name", { hasText: "藍沢エマ" })).toHaveCount(0)

  await search.fill("zzzz-no-such-creator")
  await expect(drawer.getByText("No matching creator.")).toBeVisible()
})

test("switching the selected creator updates Home's Oshi Status panel, and survives closing and reopening the drawer without resetting to the default Oshi", async ({
  page,
}) => {
  await page.goto("/")
  const dock = page.locator(".live-status-dock")

  // Fresh context -> defaultOshi falls back to the first eligible creator
  // by displayOrder (藍沢エマ, same fallback schedule-and-settings.spec.ts's
  // own Oshi Settings tests rely on), and currentOshi seeds from it.
  await expect(page.locator(".oshi-status__creator-name")).toHaveText("藍沢エマ")

  await dock.locator(".live-status-trigger").click()
  const drawer = page.getByRole("dialog", { name: "Live schedule search" })
  await drawer.getByRole("button", { name: "Switch Oshi to 兎田ぺこら" }).click()

  // confirmOshiSwitch defaults to true (no prior "Don't ask again") --
  // switching from the Live Status list goes through the real
  // OshiSwitchConfirmDialog exactly as a user would.
  const confirmDialog = page.getByRole("dialog", { name: 'Switch your Oshi to "兎田ぺこら"?' })
  await expect(confirmDialog).toBeVisible()
  await confirmDialog.getByRole("button", { name: "Switch" }).click()
  await expect(confirmDialog).toBeHidden()

  await expect(page.locator(".oshi-status__creator-name")).toHaveText("兎田ぺこら")
  // The MAIN badge (defaultOshi) must stay on 藍沢エマ -- switching
  // currentOshi from the Dock never touches Settings > Oshi Settings' own
  // pick.
  await expect(drawer.locator(".live-status-member", { hasText: "藍沢エマ" }).locator(".live-status-member__main-badge")).toBeVisible()

  await drawer.getByRole("button", { name: "Close" }).click()
  await expect(dock).toHaveAttribute("data-live-status-open", "false")
  await dock.locator(".live-status-trigger").click()
  await expect(dock).toHaveAttribute("data-live-status-open", "true")

  await expect(page.locator(".oshi-status__creator-name")).toHaveText("兎田ぺこら")
})
