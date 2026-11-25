import { test, expect, type Page } from "@playwright/test"
import { CREATOR_ID, MEMORY_CATALOG, OSHI_STATUS, PINNED_NOW, SPECIAL_DAYS, THUMBNAIL_SVG, TOPICS, UNAVAILABLE_CREATOR_ID, onThisDayResponse, shelfResponse } from "./fixtures"

/** F37 "On this day" in a real Chromium-based browser, on desktop and phone viewports (the two projects of playwright.on-this-day.config.ts), against
 * SYNTHETIC fixtures only. Isolation is fail-closed: every request is intercepted at the browser context; only the throwaway dev server's own
 * origin passes through, the fixture API origin is answered from ./fixtures, YouTube image hosts get a synthetic image, and everything else
 * (AWS, S3, Firebase, Google, fonts) is aborted. Each test then asserts that nothing was left unanswered and that no deployed API was even attempted. */

const DEV_ORIGIN = "http://localhost:5199"
const FIXTURE_API_ORIGIN = "http://127.0.0.1:8794"
const OPEN_LABEL = "Show videos from this date in earlier years"
const EMPTY_TEXT = "No matching videos on this date in earlier years"

interface Recorder {
  /** Query strings of every on-this-day request the browser made, in order. */
  onThisDay: URLSearchParams[]
  /** Requests answered 404 because no fixture exists for them (must stay empty). */
  unhandled: string[]
  /** Requests to anything but the dev server / fixture API / image hosts, aborted before they could leave the machine. */
  blocked: string[]
  /** Every origin an API-looking request went to. */
  apiOrigins: Set<string>
}

/** Installs the fail-closed network layer and pins the clock, locale and creator. Must run before the first navigation. */
async function openHome(page: Page, creatorId = CREATOR_ID): Promise<Recorder> {
  const rec: Recorder = { onThisDay: [], unhandled: [], blocked: [], apiOrigins: new Set() }
  await page.context().route("**/*", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin === DEV_ORIGIN) return route.continue()
    if (url.origin === FIXTURE_API_ORIGIN) {
      rec.apiOrigins.add(url.origin)
      const cors = { "access-control-allow-origin": "*" }
      const json = (status: number, body: unknown) => route.fulfill({ status, headers: cors, contentType: "application/json", body: JSON.stringify(body) })
      const path = url.pathname
      if (request.method() !== "GET") {
        rec.unhandled.push(`${request.method()} ${path}`)
        return json(404, {})
      }
      if (path === "/topics") return json(200, { topics: TOPICS })
      if (path === "/live-streams") return json(200, { streams: [] })
      if (path === "/milestones") return json(200, { milestones: [] })
      if (path.endsWith("/oshi-status")) return json(200, OSHI_STATUS)
      if (path.endsWith("/videos/recent")) return json(200, shelfResponse())
      if (path.endsWith("/videos/on-this-day")) {
        rec.onThisDay.push(url.searchParams)
        if (path !== `/creators/${CREATOR_ID}/videos/on-this-day`) {
          return json(404, { error: "Historical data is not available for this creator", code: "HISTORICAL_DATA_UNAVAILABLE" })
        }
        const month = Number(url.searchParams.get("month"))
        const day = Number(url.searchParams.get("day"))
        if (month === SPECIAL_DAYS.error.month && day === SPECIAL_DAYS.error.day) return json(500, { error: "synthetic server failure" })
        if (month === SPECIAL_DAYS.slow.month && day === SPECIAL_DAYS.slow.day) await new Promise((resolve) => setTimeout(resolve, 2500))
        return json(200, onThisDayResponse(url.searchParams))
      }
      rec.unhandled.push(`GET ${path}`)
      return json(404, {})
    }
    if (/(^|\.)(ytimg\.com|ggpht\.com|youtube\.com)$/.test(url.hostname)) {
      return route.fulfill({ status: 200, contentType: "image/svg+xml", body: THUMBNAIL_SVG })
    }
    rec.blocked.push(`${request.method()} ${url.origin}${url.pathname}`)
    return route.abort()
  })
  await page.clock.setFixedTime(PINNED_NOW) // 2026-11-25 12:00 in Tokyo
  await page.addInitScript(() => window.localStorage.setItem("yobi.locale", "en"))
  await page.goto(`/?creator=${creatorId}`, { waitUntil: "domcontentloaded", timeout: 150_000 })
  await expect(page.locator(".oshi-video-card").first()).toBeVisible({ timeout: 60_000 })
  return rec
}

/** Nothing left the machine: every API call hit the fixture origin, none was unanswered, and no deployed API was even attempted. */
function expectIsolated(rec: Recorder) {
  expect(rec.unhandled, "requests with no fixture").toEqual([])
  expect([...rec.apiOrigins]).toEqual([FIXTURE_API_ORIGIN])
  expect(rec.blocked.filter((entry) => /amazonaws\.com|execute-api|firebase|googleapis\.com\/(v1|identitytoolkit)/i.test(entry)), "attempts at a real backend").toEqual([])
}

/** A Topic Tag of the shelf header (the Live Status drawer has its own, identically named segmented control). */
const tag = (page: Page, name: string) => page.locator(".oshi-videos__tags").getByTitle(name, { exact: true })
const toggle = (page: Page) => page.getByRole("button", { name: OPEN_LABEL })
const yearLabels = (page: Page) => page.locator(".oshi-memories__year-label").allTextContents()
const cardTitles = (page: Page) => page.locator(".oshi-memories__card .oshi-video-card__title").allTextContents()
const lastQuery = (rec: Recorder) => Object.fromEntries(rec.onThisDay.at(-1)!.entries())

async function shot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}-${test.info().project.name}.png`), fullPage: false })
}

test.describe("On this day (synthetic fixtures, desktop and phone)", () => {
  test("the Home shelf and layout are intact until On this day is opened", async ({ page }) => {
    const rec = await openHome(page)
    const shelfCards = await page.locator(".oshi-video-card__title").allTextContents()
    expect(shelfCards).toEqual(expect.arrayContaining(["Shelf video one", "Shelf video six"]))
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "false")
    await expect(page.getByLabel("Sort videos")).toBeVisible()
    await expect(page.locator(".oshi-memories__year")).toHaveCount(0)
    expect(rec.onThisDay, "nothing is fetched until the toggle is used").toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no horizontal page overflow").toBe(true)
    await shot(page, "01-home-shelf")
    expectIsolated(rec)
  })

  test("the new controls reuse the existing control skin (no new design)", async ({ page }) => {
    const rec = await openHome(page)
    await toggle(page).click()
    await expect(page.locator(".oshi-memories__year").first()).toBeVisible()
    const skin = (selector: string) =>
      page.locator(selector).first().evaluate((node) => {
        const s = getComputedStyle(node)
        return { fontFamily: s.fontFamily, fontSize: s.fontSize, height: s.height, borderRadius: s.borderRadius, borderStyle: s.borderTopStyle, borderWidth: s.borderTopWidth, borderColor: s.borderTopColor }
      })
    const reference = await skin('select[aria-label="Content type"]') // an existing shelf control, never touched by F37
    const pageFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily)
    const sameSkin = (control: Awaited<ReturnType<typeof skin>>, fontFamily: string) =>
      // Same size, radius and border as the shelf's own dropdown; only the width varies (a day number needs less room than a label).
      expect({ ...control, height: undefined }).toEqual({ ...reference, fontFamily, height: undefined })
    // New selects are native <select>s like the existing ones: identical in every respect, font included.
    for (const selector of ['select[aria-label="Month"]', 'select[aria-label="Day"]']) sameSkin(await skin(selector), reference.fontFamily)
    // New buttons are native <button>s: they inherit the page typography (the app font) rather than the browser default the native selects keep.
    for (const selector of ['button[aria-label="Previous day"]', 'button[aria-label="Next day"]']) sameSkin(await skin(selector), pageFont)
    const toggleSkin = await skin("button.oshi-videos__memories-toggle")
    expect(toggleSkin.fontFamily).toBe(pageFont)
    expect(toggleSkin.fontSize).toBe(reference.fontSize)
    expect(toggleSkin.borderRadius).toBe(reference.borderRadius)
    for (const selector of ["button.oshi-videos__memories-toggle", 'select[aria-label="Month"]']) {
      const classes = await page.locator(selector).first().getAttribute("class")
      expect(classes).toContain("oshi-videos__sort") // the existing control class is what gives them their look
    }
    expectIsolated(rec)
  })

  test("the toggle opens the default date (today in Tokyo, earlier years) and closes back to the shelf", async ({ page }) => {
    const rec = await openHome(page)
    await toggle(page).click()
    await expect(page.locator(".oshi-memories__year").first()).toBeVisible()

    expect(lastQuery(rec)).toMatchObject({ month: "11", day: "25", timeZone: "Asia/Tokyo", topic: "all", contentType: "all", excludeShorts: "true" })
    expect(await yearLabels(page)).toEqual(["2025", "2024", "2022"]) // newest first; this year's 11/25 never appears
    const titles = await cardTitles(page)
    expect(titles).toEqual(expect.arrayContaining(["2025 Minecraft night stream", "2025 Original song MV", "2024 Minecraft build stream", "2022 Free talk stream", "2022 Cover MV"]))
    expect(titles).not.toContain("TODAY must not appear")
    expect(titles).not.toContain("2025 clip short") // Shorts stay out of ALL, like the shelf
    // The date line says what the date means: a stream's real start vs an upload's published day, then the topic.
    await expect(page.locator(".oshi-memories__card", { hasText: "2025 Minecraft night stream" }).locator(".oshi-video-card__meta")).toHaveText("2025-11-25 · Streamed · Minecraft")
    await expect(page.locator(".oshi-memories__card", { hasText: "2025 Original song MV" }).locator(".oshi-video-card__meta")).toHaveText("2025-11-25 · Published · MV")
    await expect(page.locator(".oshi-memories__note")).toContainText("Catalog covers from 2019-07-18")
    await expect(page.locator(".oshi-memories__note")).toContainText("12 livestreams have no recorded start date yet")
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "true")
    await expect(page.getByLabel("Sort videos")).toHaveCount(0) // the shelf's sort is replaced by the date controls while open
    await shot(page, "02-on-this-day-open")

    await toggle(page).click()
    await expect(page.locator(".oshi-memories__year")).toHaveCount(0)
    await expect(page.getByLabel("Sort videos")).toBeVisible()
    await expect(page.locator(".oshi-video-card__title", { hasText: "Shelf video one" })).toBeVisible()
    await shot(page, "03-back-to-shelf")
    expectIsolated(rec)
  })

  test("previous / next day, month and day selectors, 29 February, month clamp and the year wrap", async ({ page }) => {
    const rec = await openHome(page)
    await toggle(page).click()
    await expect(page.locator(".oshi-memories__year").first()).toBeVisible()

    await page.getByRole("button", { name: "Previous day" }).click()
    await expect.poll(() => lastQuery(rec)).toMatchObject({ month: "11", day: "24" })
    await expect(page.locator(".oshi-video-card__title", { hasText: "Previous-day upload" })).toBeVisible()
    await page.getByRole("button", { name: "Next day" }).click()
    await page.getByRole("button", { name: "Next day" }).click()
    await expect.poll(() => lastQuery(rec)).toMatchObject({ month: "11", day: "26" })
    await expect(page.locator(".oshi-video-card__title", { hasText: "Next-day stream" })).toBeVisible()

    await page.getByLabel("Month", { exact: true }).selectOption("2")
    await page.getByLabel("Day", { exact: true }).selectOption("29") // February offers the 29th
    await expect.poll(() => lastQuery(rec)).toMatchObject({ month: "2", day: "29" })
    await expect.poll(() => yearLabels(page)).toEqual(["2024", "2020"]) // only leap years have results
    await shot(page, "04-leap-day")

    await page.getByLabel("Month", { exact: true }).selectOption("1")
    await page.getByLabel("Day", { exact: true }).selectOption("31")
    await page.getByLabel("Month", { exact: true }).selectOption("2") // 31 does not exist in February: the day is clamped, never invalid
    await expect(page.getByLabel("Day", { exact: true })).toHaveValue("29")
    await expect.poll(() => lastQuery(rec)).toMatchObject({ month: "2", day: "29" })

    await page.getByLabel("Month", { exact: true }).selectOption("12")
    await page.getByLabel("Day", { exact: true }).selectOption("31")
    await expect.poll(() => yearLabels(page)).toEqual(["2025"])
    await page.getByRole("button", { name: "Next day" }).click() // Dec 31 -> Jan 1 wraps the year boundary
    await expect.poll(() => lastQuery(rec)).toMatchObject({ month: "1", day: "1" })
    await expect(page.locator(".oshi-video-card__title", { hasText: "New Year upload" })).toBeVisible()
    expectIsolated(rec)
  })

  test("the Topic Tags and the content-type dropdown filter the memories like the shelf", async ({ page }) => {
    const rec = await openHome(page)
    await toggle(page).click()
    await expect(page.locator(".oshi-memories__year").first()).toBeVisible()

    await tag(page, "Minecraft").click()
    await expect.poll(() => lastQuery(rec)).toMatchObject({ topic: "minecraft", contentType: "all", excludeShorts: "true" })
    await expect.poll(() => cardTitles(page)).toEqual(["2025 Minecraft night stream", "2024 Minecraft build stream"])

    await page.getByLabel("Content type", { exact: true }).selectOption("upload")
    await expect.poll(() => lastQuery(rec)).toMatchObject({ topic: "minecraft", contentType: "upload" })
    await expect(page.locator(".oshi-memories__empty")).toContainText(EMPTY_TEXT) // no Minecraft uploads that day: a valid empty answer

    await tag(page, "ALL").click()
    await page.getByLabel("Content type", { exact: true }).selectOption("live")
    await expect.poll(() => lastQuery(rec)).toMatchObject({ topic: "all", contentType: "live", excludeShorts: "true" })
    await expect.poll(() => cardTitles(page)).toEqual(["2025 Minecraft night stream", "2024 Minecraft build stream", "2022 Free talk stream"])

    await tag(page, "Short").click()
    await expect.poll(() => lastQuery(rec)).toMatchObject({ topic: "all", contentType: "short", excludeShorts: "false" })
    await expect.poll(() => cardTitles(page)).toEqual(["2025 clip short"])

    await tag(page, "Latest Live").click()
    await expect.poll(() => lastQuery(rec)).toMatchObject({ topic: "all", contentType: "live", excludeShorts: "true" })
    await tag(page, "Latest Videos").click()
    await expect.poll(() => lastQuery(rec)).toMatchObject({ topic: "all", contentType: "upload", excludeShorts: "true" })
    await shot(page, "05-filtered-latest-videos")
    expectIsolated(rec)
  })

  test("distinct loading, empty, error, truncated and no-historical-data states", async ({ page }) => {
    const rec = await openHome(page)
    await toggle(page).click()
    await expect(page.locator(".oshi-memories__year").first()).toBeVisible()

    // loading: a slow answer shows the busy placeholder, then the real cards
    await page.getByLabel("Month", { exact: true }).selectOption(String(SPECIAL_DAYS.slow.month))
    await page.getByLabel("Day", { exact: true }).selectOption(String(SPECIAL_DAYS.slow.day))
    await expect(page.locator('.oshi-empty-state[aria-busy="true"]')).toBeVisible()
    await shot(page, "06-loading")
    await expect(page.locator('.oshi-empty-state[aria-busy="true"]')).toHaveCount(0, { timeout: 10_000 })

    // empty: a valid date with nothing on it says so and still says what the catalog covers (never presented as an error)
    await page.getByLabel("Month", { exact: true }).selectOption(String(SPECIAL_DAYS.empty.month))
    await page.getByLabel("Day", { exact: true }).selectOption(String(SPECIAL_DAYS.empty.day))
    await expect(page.locator(".oshi-memories__empty")).toContainText(EMPTY_TEXT)
    await expect(page.locator(".oshi-memories__empty")).toContainText("Catalog covers from 2019-07-18")
    await expect(page.locator('[role="alert"]')).toHaveCount(0)
    await shot(page, "07-empty")

    // truncated: the backend cut the list at its cap and the view says so
    await page.getByLabel("Month", { exact: true }).selectOption(String(SPECIAL_DAYS.truncated.month))
    await page.getByLabel("Day", { exact: true }).selectOption(String(SPECIAL_DAYS.truncated.day))
    await expect(page.locator(".oshi-memories__note")).toContainText("Showing the first 500 results")

    // error: a failed request is the shelf's own error state, never the empty text
    await page.getByLabel("Month", { exact: true }).selectOption(String(SPECIAL_DAYS.error.month))
    await page.getByLabel("Day", { exact: true }).selectOption(String(SPECIAL_DAYS.error.day))
    await expect(page.locator('[role="alert"]')).toBeVisible()
    await expect(page.locator(".oshi-memories__empty")).toHaveCount(0)
    await expect(page.getByText(EMPTY_TEXT)).toHaveCount(0)
    await shot(page, "08-error")
    expectIsolated(rec)
  })

  test("a creator without a historical catalog says so (not 'no videos', not an error)", async ({ page }) => {
    const rec = await openHome(page, UNAVAILABLE_CREATOR_ID)
    await toggle(page).click()
    await expect(page.getByText("Historical data is not available for this creator yet")).toBeVisible()
    await expect(page.locator('[role="alert"]')).toHaveCount(0)
    await expect(page.getByText(EMPTY_TEXT)).toHaveCount(0)
    await shot(page, "09-unavailable")
    expectIsolated(rec)
  })

  test("the controls and the year groups fit the viewport (no overflow, no overlap, the track scrolls sideways)", async ({ page }) => {
    const rec = await openHome(page)
    await toggle(page).click()
    await expect(page.locator(".oshi-memories__year").first()).toBeVisible()

    const viewport = page.viewportSize()!
    const labels = [OPEN_LABEL, "Previous day", "Month", "Day", "Next day"]
    const boxes = []
    for (const label of labels) {
      const box = await page.getByLabel(label, { exact: true }).first().boundingBox()
      expect(box, `${label} is laid out`).not.toBeNull()
      expect(box!.x, `${label} starts inside the viewport`).toBeGreaterThanOrEqual(-1)
      expect(box!.x + box!.width, `${label} ends inside the viewport`).toBeLessThanOrEqual(viewport.width + 1)
      boxes.push({ label, ...box! })
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
        const overlapX = a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1
        const overlapY = a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1
        expect(overlapX && overlapY, `${a.label} overlaps ${b.label}`).toBe(false)
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no horizontal page overflow").toBe(true)
    const trackScrolls = await page.locator(".oshi-videos__list").evaluate((node) => node.scrollWidth > (node.parentElement?.clientWidth ?? node.clientWidth))
    expect(trackScrolls, "three year groups share the shelf's own sideways-scrolling track").toBe(true)
    await shot(page, "10-fit")
    expectIsolated(rec)
  })

  test("opening a memory uses the normal video selection path", async ({ page }) => {
    const rec = await openHome(page)
    await toggle(page).click()
    await expect(page.locator(".oshi-memories__year").first()).toBeVisible()
    await page.locator(".oshi-memories__card", { hasText: "2025 Minecraft night stream" }).locator("button").click()
    // The same selection the shelf's cards run: the main player now embeds the chosen video.
    await expect(page.locator('iframe[src*="mem-2025-live"]')).toHaveCount(1)
    expect(MEMORY_CATALOG.some((row) => row.videoId === "mem-2025-live")).toBe(true)
    expectIsolated(rec)
  })
})
