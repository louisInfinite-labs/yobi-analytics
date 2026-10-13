import { test, expect, type Page } from "@playwright/test"
import { pinEnglishLocale, trackPageErrors } from "./helpers/common"

/** Schedule organization filter (All / VSPO / Hololive) in the existing Filter drawer, against the real app. /live-streams is answered by
 * the test itself so the data is deterministic and every request to it can be counted. */

const TITLES = {
  all: ["Hololive EN stream", "Hololive ID stream", "Hololive JP stream", "VSPO JP stream", "VSPO second stream"],
  vspo: ["VSPO JP stream", "VSPO second stream"],
  hololive: ["Hololive EN stream", "Hololive ID stream", "Hololive JP stream"],
}

function streamAt(hour: number, videoId: string, creatorId: string, title: string) {
  const start = new Date()
  start.setHours(hour, 0, 0, 0)
  return {
    videoId,
    creatorId,
    channelName: creatorId,
    title,
    status: "upcoming",
    scheduledStart: start.toISOString(),
    actualStart: null,
    thumbnailUrl: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
  }
}

async function mockLiveStreams(page: Page) {
  const counter = { requests: 0 }
  await page.route("**/live-streams*", async (route) => {
    counter.requests += 1
    await route.fulfill({
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        streams: [
          streamAt(10, "v-ema", "aizawa_ema", "VSPO JP stream"),
          streamAt(11, "v-sumire", "kaga_sumire", "VSPO second stream"),
          streamAt(12, "v-pekora", "usada_pekora", "Hololive JP stream"),
          streamAt(13, "v-gura", "gawr_gura", "Hololive EN stream"),
          streamAt(14, "v-iofi", "airani_iofifteen", "Hololive ID stream"),
        ],
      }),
    })
  })
  return counter
}

async function visibleTitles(page: Page): Promise<string[]> {
  const labels = await page.locator(".stream-avatar-button").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label") ?? ""))
  return labels.sort()
}

async function openFilterDrawer(page: Page) {
  await page.getByRole("button", { name: "Filter by creator" }).click()
  const drawer = page.locator(".schedule-creator-drawer")
  await expect(drawer.getByRole("radiogroup", { name: "Organization" })).toBeVisible()
  return drawer
}

/** Waits for the drawer's slide-in to finish, so geometry is measured at rest rather than mid-animation. */
async function waitForDrawerToSettle(page: Page) {
  const wrapper = page.locator(".schedule-creator-drawer .ant-drawer-content-wrapper")
  let previous = -1
  await expect
    .poll(async () => {
      const x = (await wrapper.boundingBox())?.x ?? -2
      const settled = x === previous
      previous = x
      return settled
    })
    .toBe(true)
}

function segment(page: Page, name: "All" | "VSPO" | "Hololive") {
  return page.locator(".schedule-creator-drawer__organization .ant-segmented-item", { hasText: name })
}

test.beforeEach(async ({ page }) => {
  await pinEnglishLocale(page)
})

test("the organization control is the first thing in the Filter panel, defaults to All, and switches the Schedule instantly without refetching", async ({
  page,
}) => {
  const errors = trackPageErrors(page)
  const live = await mockLiveStreams(page)
  await page.goto("/schedule")
  await expect.poll(() => visibleTitles(page)).toEqual(TITLES.all)

  const drawer = await openFilterDrawer(page)
  await expect(drawer.locator(".ant-drawer-body > :first-child")).toHaveClass(/schedule-creator-drawer__organization/)
  await expect(segment(page, "All")).toHaveClass(/ant-segmented-item-selected/)
  await expect(drawer.locator(".schedule-creator-drawer__organization .ant-segmented-item")).toHaveText(["All", "VSPO", "Hololive"])

  const requestsBefore = live.requests
  await segment(page, "VSPO").click()
  await expect.poll(() => visibleTitles(page)).toEqual(TITLES.vspo)
  await segment(page, "Hololive").click()
  await expect.poll(() => visibleTitles(page)).toEqual(TITLES.hololive)
  await segment(page, "All").click()
  await expect.poll(() => visibleTitles(page)).toEqual(TITLES.all)

  expect(live.requests).toBe(requestsBefore)
  await expect(drawer).toBeVisible()
  expect(errors).toEqual([])
})

test("keeps the creator filter when the organization changes, and the organization when the creator filter changes", async ({ page }) => {
  await mockLiveStreams(page)
  await page.goto("/schedule")
  await expect.poll(() => visibleTitles(page)).toEqual(TITLES.all)
  const drawer = await openFilterDrawer(page)

  await drawer.locator(".schedule-creator-item[data-channel-id='ch_usada_pekora']").first().click()
  await expect.poll(() => visibleTitles(page)).toEqual(["Hololive JP stream"])

  await segment(page, "VSPO").click()
  await expect.poll(() => visibleTitles(page)).toEqual([])
  await expect(drawer.locator(".schedule-creator-item[data-channel-id='ch_usada_pekora']").first()).toHaveAttribute("aria-pressed", "true")

  await segment(page, "All").click()
  await expect.poll(() => visibleTitles(page)).toEqual(["Hololive JP stream"])

  await segment(page, "Hololive").click()
  await drawer.getByRole("button", { name: "Clear filter" }).click()
  await expect(segment(page, "Hololive")).toHaveClass(/ant-segmented-item-selected/)
  await expect.poll(() => visibleTitles(page)).toEqual(TITLES.hololive)
})

test("is operable from the keyboard with a visible selected state that is not color alone", async ({ page }) => {
  await mockLiveStreams(page)
  await page.goto("/schedule")
  await expect.poll(() => visibleTitles(page)).toEqual(TITLES.all)
  const drawer = await openFilterDrawer(page)

  const group = drawer.getByRole("radiogroup", { name: "Organization" })
  await expect(group.getByRole("radio", { name: "All" })).toBeChecked()
  await group.getByRole("radio", { name: "All" }).focus()
  await page.keyboard.press("ArrowRight")
  await expect(group.getByRole("radio", { name: "VSPO" })).toBeChecked()
  await expect.poll(() => visibleTitles(page)).toEqual(TITLES.vspo)
  await page.keyboard.press("ArrowRight")
  await expect(group.getByRole("radio", { name: "Hololive" })).toBeChecked()
  await expect.poll(() => visibleTitles(page)).toEqual(TITLES.hololive)

  // Selected state is exposed to assistive tech (the checked radio above) and is not hue alone: the selected segment also gets a filled
  // chip and full-strength text, while the others stay unfilled. Read after antd's slide animation has settled.
  const style = (name: "All" | "VSPO" | "Hololive") =>
    segment(page, name).evaluate((node) => {
      const computed = getComputedStyle(node)
      return { background: computed.backgroundColor, color: computed.color }
    })
  await expect.poll(async () => (await style("Hololive")).background).not.toBe("rgba(0, 0, 0, 0)")
  const selected = await style("Hololive")
  const unselected = await style("VSPO")
  expect(unselected.background).toBe("rgba(0, 0, 0, 0)")
  expect(selected.color).not.toBe(unselected.color)
})

test("has the same look as the Live Status ALL / Favorites selector", async ({ page }) => {
  await mockLiveStreams(page)
  await page.goto("/schedule")
  await expect.poll(() => visibleTitles(page)).toEqual(TITLES.all)

  const read = (selector: string) =>
    page.evaluate((root) => {
      const track = document.querySelector<HTMLElement>(`${root} .ant-segmented`)!
      const item = track.querySelector<HTMLElement>(".ant-segmented-item-selected")!
      const unselected = track.querySelector<HTMLElement>(".ant-segmented-item:not(.ant-segmented-item-selected)")!
      const label = item.querySelector<HTMLElement>(".ant-segmented-item-label")!
      const pick = (el: HTMLElement, props: string[]) => Object.fromEntries(props.map((p) => [p, getComputedStyle(el).getPropertyValue(p)]))
      return {
        track: pick(track, ["background-color", "border-top-width", "border-top-left-radius", "padding-top", "padding-left", "font-size"]),
        selectedItem: pick(item, ["background-color", "color", "border-top-left-radius", "font-size"]),
        unselectedItem: pick(unselected, ["background-color", "color", "border-top-left-radius"]),
        label: pick(label, ["font-size", "font-weight", "line-height", "padding-left", "padding-top", "min-height", "justify-content", "text-align"]),
        itemHeight: item.getBoundingClientRect().height,
      }
    }, selector)

  const drawer = await openFilterDrawer(page)
  await expect(drawer).toBeVisible()
  const schedule = await read(".schedule-creator-drawer__organization")
  await page.keyboard.press("Escape")
  await expect(page.locator(".schedule-creator-drawer")).toBeHidden()

  await page.locator(".live-status-trigger").click()
  await expect(page.locator(".live-status-filter-row .ant-segmented")).toBeVisible()
  const liveStatus = await read(".live-status-filter-row")

  expect(schedule).toEqual(liveStatus)
})

for (const viewport of [
  { name: "phone 390x844", width: 390, height: 844 },
  { name: "tablet 768x1024", width: 768, height: 1024 },
  { name: "tablet 820x1180", width: 820, height: 1180 },
  { name: "notebook 1366x768", width: 1366, height: 768 },
  { name: "desktop 1440x900", width: 1440, height: 900 },
  { name: "desktop 1920x1080", width: 1920, height: 1080 },
]) {
  test(`all three options stay visible, unclipped and usable at ${viewport.name}, adding no horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await mockLiveStreams(page)
    await page.goto("/schedule")
    await expect.poll(() => visibleTitles(page)).toEqual(TITLES.all)
    const overflowOf = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    // Measured before opening: the page's own toolbar can already be wider than a phone, which is not this control's doing.
    const overflowBefore = await overflowOf()
    const drawer = await openFilterDrawer(page)
    await waitForDrawerToSettle(page)

    const track = drawer.locator(".schedule-creator-drawer__organization .ant-segmented")
    const items = drawer.locator(".schedule-creator-drawer__organization .ant-segmented-item")
    await expect(items).toHaveCount(3)

    const trackBox = (await track.boundingBox())!
    const drawerBox = (await drawer.locator(".ant-drawer-content-wrapper").boundingBox())!
    expect(trackBox.x).toBeGreaterThanOrEqual(drawerBox.x - 1)
    expect(trackBox.x + trackBox.width).toBeLessThanOrEqual(drawerBox.x + drawerBox.width + 1)

    for (let index = 0; index < 3; index += 1) {
      const item = items.nth(index)
      await expect(item).toBeVisible()
      const box = (await item.boundingBox())!
      // Same 28px segments as Live Status' own selector (antd's default inside its 32px track); above WCAG 2.2's 24px minimum target.
      expect(box.height).toBeGreaterThanOrEqual(24)
      expect(box.width).toBeGreaterThanOrEqual(48)
      expect(box.x).toBeGreaterThanOrEqual(trackBox.x - 1)
      expect(box.x + box.width).toBeLessThanOrEqual(trackBox.x + trackBox.width + 1)
      // The label text itself fits inside its segment: no ellipsis/clipping and no wrap onto a second line.
      const fits = await item.locator(".ant-segmented-item-label").evaluate((label) => label.scrollWidth <= label.clientWidth + 1 && label.getBoundingClientRect().height < 40)
      expect(fits).toBe(true)
    }

    expect(trackBox.x).toBeGreaterThanOrEqual(0)
    expect(trackBox.x + trackBox.width).toBeLessThanOrEqual(viewport.width)
    expect(await overflowOf()).toBeLessThanOrEqual(overflowBefore)

    await segment(page, "VSPO").click()
    await expect.poll(() => visibleTitles(page)).toEqual(TITLES.vspo)
  })
}
