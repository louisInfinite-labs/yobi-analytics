import { test, expect, type Page } from "@playwright/test"
import { pinEnglishLocale } from "./helpers/common"

/** Home scroll reset on a creator change -- measured on the REAL scroll container in a real Chromium (never by asserting a route change).
 * Below 1024px Home is one column that scrolls with the DOCUMENT (home.css), so `window.scrollY` is the container's scroll position. Each
 * test makes sure the document is tall enough to scroll by appending an inert spacer to <body> (outside React's #root), so the result does
 * not depend on how much data the local fixture happens to return. */

const PHONE = { width: 390, height: 844 }
const TABLET = { width: 820, height: 1180 }
const DESKTOP = { width: 1280, height: 800 }

const scrollY = (page: Page) => page.evaluate(() => window.scrollY)

/** Scrolls the page well down (the spacer guarantees room) and waits until the position has really been applied. */
async function scrollDown(page: Page, to = 900) {
  await page.evaluate((target) => {
    if (!document.getElementById("e2e-scroll-spacer")) {
      const spacer = document.createElement("div")
      spacer.id = "e2e-scroll-spacer"
      spacer.style.cssText = "height:4000px;width:1px;pointer-events:none"
      document.body.appendChild(spacer)
    }
    window.scrollTo({ top: target, left: 0, behavior: "instant" })
  }, to)
  await expect.poll(() => scrollY(page)).toBe(to)
}

/** Switches the Home creator the way a user does: the Live Status drawer's "Switch Oshi to ..." row and its confirmation dialog. */
async function switchCreatorFromLiveStatus(page: Page, creatorName: string) {
  const dock = page.locator(".live-status-dock")
  const drawer = page.getByRole("dialog", { name: "Live schedule search" })
  if ((await dock.getAttribute("data-live-status-open")) !== "true") await dock.locator(".live-status-trigger").click()
  await expect(drawer).toBeVisible()
  await drawer.getByRole("button", { name: `Switch Oshi to ${creatorName}` }).click()
  const confirmDialog = page.getByRole("dialog", { name: `Switch the screen to "${creatorName}"?` })
  if (await confirmDialog.isVisible().catch(() => false)) await confirmDialog.getByRole("button", { name: "Switch" }).click()
  await expect(page.locator(".oshi-status__creator-name")).toHaveText(creatorName)
}

async function closeLiveStatus(page: Page) {
  const dock = page.locator(".live-status-dock")
  if ((await dock.getAttribute("data-live-status-open")) === "true") {
    await page.getByRole("dialog", { name: "Live schedule search" }).getByRole("button", { name: "Close" }).click()
    await expect(dock).toHaveAttribute("data-live-status-open", "false")
  }
}

// Warm the throwaway dev server first (Vite may re-optimise dependencies and reload the page on the very first visit, which would drop a scroll
// position set by a test), the same way fa2-live-status-interaction.spec.ts does.
test.beforeAll(async ({ browser }, testInfo) => {
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL })
  const page = await context.newPage()
  await page.goto("/creator/aizawa-ema")
  await page.waitForLoadState("networkidle")
  await context.close()
})

test.beforeEach(async ({ page }) => {
  await pinEnglishLocale(page)
})

for (const [label, viewport] of [
  ["phone", PHONE],
  ["tablet", TABLET],
] as const) {
  test.describe(`${label}: Home scrolls with the page and a creator change starts at the top`, () => {
    test.use({ viewport })

    test("A scrolled down -> B (Live Status) is at the top; B scrolled down -> back to A is at the top", async ({ page }) => {
      await page.goto("/creator/aizawa-ema")
      await expect(page.locator(".oshi-status__creator-name")).toHaveText("藍沢エマ")

      await scrollDown(page)
      await switchCreatorFromLiveStatus(page, "兎田ぺこら")
      await expect.poll(() => scrollY(page)).toBe(0) // immediately, even while the drawer is still open
      await closeLiveStatus(page)
      expect(await scrollY(page)).toBe(0)
      expect(new URL(page.url()).pathname).toBe("/creator/usada-pekora")

      await scrollDown(page, 700)
      await switchCreatorFromLiveStatus(page, "藍沢エマ")
      await expect.poll(() => scrollY(page)).toBe(0)
      await closeLiveStatus(page)
      expect(await scrollY(page)).toBe(0)
      expect(new URL(page.url()).pathname).toBe("/creator/aizawa-ema")
    })

    test("browser Back and Forward between two creator routes both land at the top, never at the history entry's old position", async ({ page }) => {
      await page.goto("/creator/aizawa-ema")
      await expect(page.locator(".oshi-status__creator-name")).toHaveText("藍沢エマ")
      await scrollDown(page, 900) // A's history entry is left scrolled down

      await switchCreatorFromLiveStatus(page, "兎田ぺこら")
      await closeLiveStatus(page)
      await expect.poll(() => scrollY(page)).toBe(0)
      await scrollDown(page, 700) // B's history entry is left scrolled down too

      await page.goBack()
      await expect(page.locator(".oshi-status__creator-name")).toHaveText("藍沢エマ")
      expect(new URL(page.url()).pathname).toBe("/creator/aizawa-ema")
      await page.waitForTimeout(400) // past the browser's own post-popstate scroll restoration
      expect(await scrollY(page)).toBe(0)

      await scrollDown(page, 500)
      await page.goForward()
      await expect(page.locator(".oshi-status__creator-name")).toHaveText("兎田ぺこら")
      await page.waitForTimeout(400)
      expect(await scrollY(page)).toBe(0)
    })

    test("a deep link to another creator (a notification tap navigating the open window) opens at the top", async ({ page }) => {
      await page.goto("/creator/aizawa-ema")
      await scrollDown(page)

      await page.goto("/creator/usada-pekora") // what sw.js's client.navigate / openWindow do: a new document for the creator route
      await expect(page.locator(".oshi-status__creator-name")).toHaveText("兎田ぺこら")
      await page.waitForTimeout(300)
      expect(await scrollY(page)).toBe(0)
    })

    test("the same creator's own updates (focus / visibility refresh) never move the scroll position", async ({ page }) => {
      await page.goto("/creator/aizawa-ema")
      await expect(page.locator(".oshi-status__creator-name")).toHaveText("藍沢エマ")
      await scrollDown(page, 900)

      await page.evaluate(() => {
        window.dispatchEvent(new Event("focus"))
        document.dispatchEvent(new Event("visibilitychange"))
      })
      await page.waitForTimeout(1500) // let any refresh/re-render settle
      expect(await scrollY(page)).toBe(900)
    })
  })
}

test.describe("desktop: Home scrolling behavior is unchanged", () => {
  test.use({ viewport: DESKTOP })

  test("a creator change does not touch the page scroll position (no reset on desktop)", async ({ page }) => {
    await page.goto("/creator/aizawa-ema")
    await expect(page.locator(".oshi-status__creator-name")).toHaveText("藍沢エマ")
    await scrollDown(page, 500) // the spacer makes the document scrollable here only to observe that nothing resets it

    await switchCreatorFromLiveStatus(page, "兎田ぺこら")
    await page.waitForTimeout(500)

    expect(await scrollY(page)).toBe(500)
  })
})
