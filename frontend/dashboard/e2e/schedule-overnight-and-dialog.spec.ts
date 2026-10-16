import { test, expect, devices, type Page } from "@playwright/test"
import { pinEnglishLocale, trackPageErrors } from "./helpers/common"

/** Schedule, in a real browser: (A) the overnight window follows the VIEWER's timezone, stays on a stream's ORIGINAL local start date across several
 * midnights while it is live or merely dropped out of the live list, and advances only when the BACKEND confirms the end -- never waiting for an
 * archive; (B) the "+N" dialog opens on ONE tap and stays open on phones and tablets, and with a mouse. /live-streams is answered by the test itself
 * (including the backend's `recentlyEnded` list), so nothing here touches a real backend. System Chrome is used (no browser download). */

test.use({ channel: "chrome" })

interface MockState {
  streams: Record<string, unknown>[]
  /** The backend's confirmed-ended list. Undefined = the response carries no such field (an older backend: no end signal). */
  recentlyEnded?: Record<string, unknown>[]
  /** Every request the page made for archive data -- the Schedule must make none. */
  archiveRequests?: string[]
}

const liveStream = (videoId: string, creatorId: string, startIso: string, status: "live" | "upcoming" = "live") => ({
  videoId,
  creatorId,
  channelName: creatorId,
  title: `title ${videoId}`,
  status,
  scheduledStart: startIso,
  actualStart: status === "live" ? startIso : null,
  thumbnailUrl: "",
})

/** What the backend lists once its 5-minute lifecycle has verified the end against YouTube; `archive` is the separate lookup, in whatever state. */
const confirmedEnded = (videoId: string, archive: Record<string, unknown> = { status: "pending", attempts: 0 }) => ({
  videoId,
  creatorId: "aizawa_ema",
  title: `title ${videoId}`,
  confirmedEndedAt: "2026-10-18T02:00:00Z",
  archive,
})

async function mockApi(page: Page, state: MockState) {
  const cors = { "access-control-allow-origin": "*" }
  await page.route("**/live-streams*", (route) =>
    route.fulfill({
      contentType: "application/json",
      headers: cors,
      body: JSON.stringify({ streams: state.streams, ...(state.recentlyEnded ? { recentlyEnded: state.recentlyEnded } : {}) }),
    }),
  )
  await page.route(/\/creators\/[^/]+\/videos\/(recent|search|ranking)/, (route) => {
    ;(state.archiveRequests ??= []).push(new URL(route.request().url()).pathname)
    return route.fulfill({ contentType: "application/json", headers: cors, body: JSON.stringify({ videos: [], rows: [], hasMore: false }) })
  })
}

const headers = (page: Page) => page.locator(".schedule-day-header")
const headerDates = (page: Page) => page.locator(".schedule-day-header .day-date").allTextContents()
const todayIndex = (page: Page) => headers(page).evaluateAll((nodes) => nodes.findIndex((node) => node.classList.contains("is-today")))
const md = (tz: string, at: Date) => new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "numeric", day: "numeric" }).format(at)

// ---------------------------------------------------------------------------------------------------------------------------------------------
// A. overnight date retention, decided in the viewer's own timezone
// ---------------------------------------------------------------------------------------------------------------------------------------------

const SAME_INSTANTS = { now: "2026-09-23T16:30:00Z", wentLive: "2026-09-23T13:00:00Z" }
const ZONES = [
  { tz: "Asia/Tokyo", held: true }, // UTC+9: now Thu 01:30, live since Wed 22:00
  { tz: "Australia/Brisbane", held: true }, // UTC+10: now Thu 02:30, live since Wed 23:00
  { tz: "Pacific/Auckland", held: false }, // UTC+12: now Thu 05:30, live since Thu 01:00 (today's)
  { tz: "America/Los_Angeles", held: false }, // UTC-7: now Wed 09:30, live since Wed 06:00 (today's)
  { tz: "Europe/London", held: false }, // UTC+1: now Wed 17:30, live since Wed 14:00 (today's)
]

for (const zone of ZONES) {
  test.describe(`overnight window, viewer in ${zone.tz}`, () => {
    test.use({ timezoneId: zone.tz })

    test(`the same instants ${zone.held ? "keep the previous local day" : "start on the local today"}`, async ({ page }) => {
      const errors = trackPageErrors(page)
      const state: MockState = { streams: [liveStream("v-live", "aizawa_ema", SAME_INSTANTS.wentLive)], recentlyEnded: [] }
      await pinEnglishLocale(page)
      await page.clock.install({ time: new Date(SAME_INSTANTS.now) })
      await mockApi(page, state)
      await page.goto("/schedule")
      await page.clock.resume()

      await expect(headers(page)).toHaveCount(7)
      const now = new Date(SAME_INSTANTS.now)
      const todayText = md(zone.tz, now)
      const previousText = md(zone.tz, new Date(now.getTime() - 24 * 3_600_000))
      await expect.poll(() => todayIndex(page)).toBe(zone.held ? 1 : 0)
      expect((await headerDates(page))[0]).toBe(zone.held ? previousText : todayText)
      if (zone.held) await expect(page.locator(".day-column").nth(0).locator(".stream-avatar-button")).toHaveCount(1) // placed on the previous day
      expect(state.archiveRequests ?? []).toEqual([]) // the Schedule never asks for archive data
      expect(errors).toEqual([])
    })
  })
}

test.describe("overnight window held across several local midnights, released only when the backend confirms the end (viewer UTC+10)", () => {
  test.use({ timezoneId: "Australia/Brisbane" })
  const DAY_MS = 24 * 3_600_000
  const STARTED = "2026-10-15T12:00:00Z" // Thu Oct 15 22:00 AEST
  const OCT = ["10/15", "10/16", "10/17", "10/18", "10/19", "10/20", "10/21"]

  async function open(page: Page, state: MockState) {
    await pinEnglishLocale(page)
    await page.clock.install({ time: new Date("2026-10-15T14:30:00Z") }) // Fri Oct 16 00:30 AEST
    await mockApi(page, state)
    await page.goto("/schedule")
    await page.clock.resume()
  }

  test("Oct 16 00:30 live -> still live across the Oct 17 and Oct 18 midnights (also after a reload) -> Oct 18 02:00 backend confirms", async ({ page }) => {
    const state: MockState = { streams: [liveStream("v-marathon", "aizawa_ema", STARTED)], recentlyEnded: [] }
    await open(page, state)
    await expect.poll(() => todayIndex(page)).toBe(1)
    expect((await headerDates(page))[0]).toBe("10/15") // LIVE: the schedule starts Oct 15

    await page.clock.fastForward(DAY_MS) // Sat Oct 17 00:30 AEST -- the second midnight, still live
    await page.clock.runFor(125_000)
    await expect.poll(() => todayIndex(page)).toBe(2)
    expect(await headerDates(page)).toEqual(OCT)

    await page.reload() // the tab is reloaded: the stream is still live and still remembered
    await page.clock.resume()
    await expect.poll(() => todayIndex(page)).toBe(2)
    expect((await headerDates(page))[0]).toBe("10/15")

    state.streams = [] // it drops out of the live list on Oct 18 shortly before the backend confirms it
    await page.clock.fastForward(DAY_MS) // Sun Oct 18 00:30 AEST -- the third midnight
    await page.clock.runFor(125_000)
    await expect.poll(() => todayIndex(page)).toBe(3)
    expect(await headerDates(page)).toEqual(OCT)
    await expect(headers(page)).toHaveCount(7)

    state.recentlyEnded = [confirmedEnded("v-marathon")] // the backend polling confirms the end -- its archive lookup has only just begun
    await page.clock.fastForward(90 * 60_000) // Oct 18 02:00 AEST
    await page.clock.runFor(125_000)
    await expect.poll(() => todayIndex(page)).toBe(0)
    expect(await headerDates(page)).toEqual(["10/18", "10/19", "10/20", "10/21", "10/22", "10/23", "10/24"])
    expect(state.archiveRequests ?? []).toEqual([]) // at no point did the Schedule ask for archive data
  })

  test("the archive lookup's state is irrelevant: pending, handed off to the daily task or available all release the date the same", async ({ page }) => {
    for (const archive of [{ status: "pending", attempts: 0 }, { status: "handed_off_to_daily_task", attempts: 3 }, { status: "available", attempts: 1 }]) {
      const state: MockState = { streams: [liveStream("v-marathon", "aizawa_ema", STARTED)], recentlyEnded: [] }
      await open(page, state)
      await expect.poll(() => todayIndex(page)).toBe(1)

      state.streams = []
      state.recentlyEnded = [confirmedEnded("v-marathon", archive)]
      await page.clock.runFor(125_000)

      await expect.poll(() => todayIndex(page)).toBe(0)
      expect((await headerDates(page))[0]).toBe("10/16")
      await page.evaluate(() => window.localStorage.clear())
    }
  })

  test("a one-poll /live-streams gap is not an end: the stream comes back live and the date never moves", async ({ page }) => {
    const live = liveStream("v-marathon", "aizawa_ema", STARTED)
    const state: MockState = { streams: [live], recentlyEnded: [] }
    await open(page, state)
    await expect.poll(() => todayIndex(page)).toBe(1)

    state.streams = [] // one fresh response without it
    await page.clock.runFor(65_000)
    state.streams = [live] // ...and it is live again
    await page.clock.runFor(125_000)

    await expect.poll(() => todayIndex(page)).toBe(1)
    expect((await headerDates(page))[0]).toBe("10/15")
    await expect(page.locator(".day-column").nth(0).locator(".stream-avatar-button")).toHaveCount(1)
  })

  test("a dropped, unconfirmed stream is still held 13 hours on, and forgotten once 24 h have passed since it was last seen live (no confirmation can still be listed)", async ({ page }) => {
    const state: MockState = { streams: [liveStream("v-marathon", "aizawa_ema", STARTED)], recentlyEnded: [] }
    await open(page, state)
    await expect.poll(() => todayIndex(page)).toBe(1)

    state.streams = []
    await page.clock.runFor(65_000)
    await page.clock.fastForward(13 * 3_600_000) // Oct 16 13:30
    await page.clock.runFor(125_000)
    await expect.poll(() => todayIndex(page)).toBe(1)
    expect((await headerDates(page))[0]).toBe("10/15")

    await page.clock.fastForward(26 * 3_600_000) // Oct 17 15:30 -- more than 24 h after the page last saw it live: no confirmation can still be listed
    await page.clock.runFor(125_000)
    await expect.poll(() => todayIndex(page)).toBe(0)
    expect((await headerDates(page))[0]).toBe("10/17") // forgotten: the window starts on today again
  })

  test("two overnight streams: one confirmed ended and one still live keeps the date on the live one's day", async ({ page }) => {
    const state: MockState = {
      streams: [liveStream("v-a", "aizawa_ema", STARTED), liveStream("v-b", "usada_pekora", "2026-10-15T13:00:00Z")],
      recentlyEnded: [],
    }
    await open(page, state)
    await expect.poll(() => todayIndex(page)).toBe(1)

    state.streams = [liveStream("v-b", "usada_pekora", "2026-10-15T13:00:00Z")] // v-a ends; v-b is still live
    state.recentlyEnded = [confirmedEnded("v-a")]
    await page.clock.runFor(125_000)
    await expect.poll(() => todayIndex(page)).toBe(1)
    expect((await headerDates(page))[0]).toBe("10/15")

    state.streams = []
    state.recentlyEnded = [confirmedEnded("v-a"), confirmedEnded("v-b")]
    await page.clock.runFor(125_000)
    await expect.poll(() => todayIndex(page)).toBe(0)
  })

  test("a backend that sends no end signal (older deployment) holds nothing: the Schedule starts today", async ({ page }) => {
    const state: MockState = { streams: [liveStream("v-marathon", "aizawa_ema", STARTED)] } // no recentlyEnded field at all
    await open(page, state)

    await expect.poll(() => todayIndex(page)).toBe(0)
    expect((await headerDates(page))[0]).toBe("10/16")
  })
})

test.describe("overnight window across DST changes", () => {
  test.describe("Los Angeles, fall-back night (Sun 2026-11-01, 25 hours)", () => {
    test.use({ timezoneId: "America/Los_Angeles" })
    test("a stream live since Sun 21:00 PDT is still held at Mon 00:30 PST", async ({ page }) => {
      await pinEnglishLocale(page)
      await page.clock.install({ time: new Date("2026-11-02T08:30:00Z") }) // Mon 00:30 PST
      await mockApi(page, { streams: [liveStream("v-dst", "aizawa_ema", "2026-11-02T04:00:00Z")], recentlyEnded: [] }) // Sun 21:00 PDT
      await page.goto("/schedule")
      await page.clock.resume()
      await expect(headers(page)).toHaveCount(7)
      await expect.poll(() => todayIndex(page)).toBe(1)
      expect(await headerDates(page)).toEqual(["11/1", "11/2", "11/3", "11/4", "11/5", "11/6", "11/7"])
    })
  })

  test.describe("Sydney, spring-forward night (Sun 2026-10-04, 23 hours)", () => {
    test.use({ timezoneId: "Australia/Sydney" })
    test("a stream live since Sat 22:00 AEST is held at Sun 00:30 and the seven local days stay aligned", async ({ page }) => {
      await pinEnglishLocale(page)
      await page.clock.install({ time: new Date("2026-10-03T14:30:00Z") }) // Sun 00:30 AEST
      await mockApi(page, { streams: [liveStream("v-spring", "aizawa_ema", "2026-10-03T12:00:00Z")], recentlyEnded: [] }) // Sat 22:00 AEST
      await page.goto("/schedule")
      await page.clock.resume()
      await expect(headers(page)).toHaveCount(7)
      await expect.poll(() => todayIndex(page)).toBe(1)
      expect(await headerDates(page)).toEqual(["10/3", "10/4", "10/5", "10/6", "10/7", "10/8", "10/9"])
    })
  })
})
// ---------------------------------------------------------------------------------------------------------------------------------------------
// B. the "+N" dialog: one tap opens it and it stays open
// ---------------------------------------------------------------------------------------------------------------------------------------------

const CREATORS = ["aizawa_ema", "remia_aotsuki", "usada_pekora", "gawr_gura", "airani_iofifteen", "kaga_sumire", "kaga_nazuna", "shirakami_fubuki"]

/** Sixteen upcoming streams (creators repeat) in the SAME 30-minute slot today, so even a wide single-day column has more than fit and shows "+N". */
function crowdedSlot(): MockState {
  const start = new Date()
  start.setHours(10, 0, 0, 0)
  return { streams: Array.from({ length: 16 }, (_, index) => liveStream(`v-${index}`, CREATORS[index % CREATORS.length], start.toISOString(), "upcoming")), recentlyEnded: [] }
}

/** A real finger tap on the page at a point outside the dialog (the dialog can cover the heading on a small screen). */
async function tapOutside(page: Page, dialog: ReturnType<Page["locator"]>) {
  const box = (await dialog.boundingBox())!
  const size = page.viewportSize()!
  const candidates = [
    { x: size.width - 4, y: size.height - 4 },
    { x: 4, y: size.height - 4 },
    { x: size.width - 4, y: 4 },
  ]
  const point = candidates.find((c) => c.x < box.x || c.x > box.x + box.width || c.y < box.y || c.y > box.y + box.height)!
  await page.touchscreen.tap(point.x, point.y)
}

type DeviceName = keyof typeof devices
const TOUCH_DEVICES: DeviceName[] = ["iPhone 13", "Pixel 7", "iPad (gen 7)", "iPad (gen 7) landscape", "Galaxy Tab S4"]

for (const name of TOUCH_DEVICES) {
  test.describe(`+N dialog on ${name}`, () => {
    const { defaultBrowserType: _ignored, ...device } = devices[name]
    test.use({ ...device })

    test("ONE tap opens it and it stays open after the finger is released", async ({ page }) => {
      const errors = trackPageErrors(page)
      await pinEnglishLocale(page)
      await mockApi(page, crowdedSlot())
      await page.goto("/schedule")

      const chip = page.locator(".more-streams").first()
      await chip.scrollIntoViewIfNeeded()
      await expect(chip).toBeVisible()
      await chip.tap()

      const dialog = page.locator(".hidden-streams-popover")
      await expect(dialog).toBeVisible()
      await page.waitForTimeout(1500) // well past any hover/leave close delay
      await expect(dialog).toBeVisible()
      await expect(chip).toHaveAttribute("aria-expanded", "true")

      await tapOutside(page, dialog) // a tap outside closes it
      await expect(dialog).toBeHidden()
      await chip.tap()
      await expect(dialog).toBeVisible()
      expect(errors).toEqual([])
    })
  })
}

test.describe("+N dialog with a desktop mouse", () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test("hover opens it, a click keeps it open, leaving closes it", async ({ page }) => {
    await pinEnglishLocale(page)
    await mockApi(page, crowdedSlot())
    await page.goto("/schedule")

    const chip = page.locator(".more-streams").first()
    await chip.scrollIntoViewIfNeeded()
    const dialog = page.locator(".hidden-streams-popover")
    await chip.hover()
    await expect(dialog).toBeVisible()
    await chip.click()
    await page.waitForTimeout(600)
    await expect(dialog).toBeVisible()

    await page.mouse.move(5, 5)
    await expect(dialog).toBeHidden()
  })
})
