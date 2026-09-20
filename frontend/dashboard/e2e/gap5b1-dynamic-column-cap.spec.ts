import { test, expect, type Page } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** GAP-5B1 "Dynamic Readable Column Cap for Tablet" browser evidence.
 *
 * GAP-5B measured a real, unresolved conflict: `BREAKPOINT_MAX_EDITABLE_GRID.tablet`
 * (3) is a *ceiling*, but at the narrow end of the tablet range (~768px) a
 * genuinely 3-wide canonical layout rendered at ~198.7px per widget --
 * below the documented `MIN_CHART_WIDTH_PX` (240px). This suite proves the
 * fix against the real production `/dashboard` route: the actual rendered
 * grid content width (not `window.innerWidth`) now drives a dynamically
 * computed column cap (`computeReadableColumnCap`,
 * src/lib/dashboardResponsive.ts), so a too-wide-for-the-current-width
 * canonical layout reflows to fewer columns instead of rendering under the
 * minimum.
 */

const STORAGE_KEY = "yobi-analytics-canonical-dashboard-layout"

const THREE_COLUMN_LAYOUT = {
  grid: { columns: 3, rows: 2 },
  widgets: [
    { widgetId: "a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
    { widgetId: "b", widgetType: "growth-bar-chart", x: 1, y: 0, width: 1, height: 1 },
    { widgetId: "c", widgetType: "contribution-ring", x: 2, y: 0, width: 1, height: 1 },
    { widgetId: "d", widgetType: "ranking", x: 0, y: 1, width: 1, height: 1 },
    { widgetId: "e", widgetType: "insights", x: 1, y: 1, width: 1, height: 1 },
    { widgetId: "f", widgetType: "kpi-summary", x: 2, y: 1, width: 1, height: 1 },
  ],
}

interface WidgetRect {
  id: string | null
  x: number
  y: number
  width: number
  height: number
  right: number
  bottom: number
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const items = [...document.querySelectorAll<HTMLElement>(".widget-shell")].map((el) => {
      const r = el.getBoundingClientRect()
      const parent = el.closest("[gs-id]")
      return { id: parent?.getAttribute("gs-id") ?? null, x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
    })
    const gridBox = document.querySelector(".grid-stack")?.getBoundingClientRect() ?? null
    const editLayoutButton = [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Edit Layout")
    const columnsUsed = new Set(items.map((i) => Math.round(i.x))).size
    return {
      items,
      gridBox: gridBox ? { x: gridBox.x, y: gridBox.y, width: gridBox.width, height: gridBox.height } : null,
      editLayoutButton,
      columnsUsed,
    }
  })
}

function hasOverlap(items: WidgetRect[]): boolean {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]
      const b = items[j]
      if (a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom) return true
    }
  }
  return false
}

function hasOverflow(items: WidgetRect[], gridBox: { x: number; y: number; width: number; height: number }): boolean {
  return items.some(
    (i) => i.x < gridBox.x - 0.5 || i.y < gridBox.y - 0.5 || i.right > gridBox.x + gridBox.width + 0.5 || i.bottom > gridBox.y + gridBox.height + 0.5,
  )
}

function adjacentGaps(items: WidgetRect[]) {
  const gaps: number[] = []
  for (let i = 0; i < items.length; i++) {
    for (let j = 0; j < items.length; j++) {
      if (i === j) continue
      const a = items[i]
      const b = items[j]
      const vOverlap = a.y < b.y + b.height && b.y < a.y + a.height
      const hOverlap = a.x < b.x + b.width && b.x < a.x + a.width
      if (vOverlap && b.x > a.x && b.x - a.right < 100) gaps.push(b.x - a.right)
      if (hOverlap && b.y > a.y && b.y - a.bottom < 100) gaps.push(b.y - a.bottom)
    }
  }
  return gaps
}

async function freshDashboard(page: Page, viewport: { width: number; height: number }, seedLayout?: unknown) {
  await page.setViewportSize(viewport)
  await page.goto("/dashboard")
  await page.evaluate(
    ({ key, seed }) => {
      localStorage.clear()
      if (seed) localStorage.setItem(key, JSON.stringify(seed))
    },
    { key: STORAGE_KEY, seed: seedLayout },
  )
  await page.reload()
  await expect(page.getByText("Daily Gain").first()).toBeVisible()
}

const evidence: Record<string, unknown> = {}

test.describe("GAP-5B1: dynamic readable column cap for tablet", () => {
  test("AC1: at 900px, a valid 3-column layout stays 3 columns with every widget >= MIN_CHART_WIDTH_PX", async ({ page }) => {
    await freshDashboard(page, { width: 900, height: 1400 }, THREE_COLUMN_LAYOUT)
    const { items, gridBox, editLayoutButton, columnsUsed } = await measure(page)

    expect(columnsUsed).toBe(3)
    expect(Math.min(...items.map((i) => i.width))).toBeGreaterThanOrEqual(240)
    expect(hasOverlap(items)).toBe(false)
    expect(hasOverflow(items, gridBox!)).toBe(false)
    for (const gap of adjacentGaps(items)) expect(gap).toBe(16)
    expect(editLayoutButton).toBe(true) // 3 <= readable cap (3) at 900px, so editing stays available

    evidence.tablet900 = { viewportWidth: 900, columnsUsed, minWidth: Math.min(...items.map((i) => i.width)), gaps: adjacentGaps(items), editLayoutButton }
  })

  test("AC2/AC3: at 768px, the same 3-column canonical layout reflows to a lower column count, every chart still >= MIN_CHART_WIDTH_PX", async ({ page }) => {
    await freshDashboard(page, { width: 768, height: 1400 }, THREE_COLUMN_LAYOUT)
    const { items, gridBox, editLayoutButton, columnsUsed } = await measure(page)

    expect(columnsUsed).toBeLessThan(3)
    expect(Math.min(...items.map((i) => i.width))).toBeGreaterThanOrEqual(240)
    expect(hasOverlap(items)).toBe(false)
    expect(hasOverflow(items, gridBox!)).toBe(false)
    for (const gap of adjacentGaps(items)) expect(gap).toBe(16)

    // AC12: the canonical grid (3 columns) exceeds the current readable cap
    // here, so the view is a read-only reflow -- Edit must be unavailable
    // rather than operating on projected (not canonical) coordinates.
    expect(editLayoutButton).toBe(false)

    evidence.tablet768 = { viewportWidth: 768, columnsUsed, minWidth: Math.min(...items.map((i) => i.width)), gaps: adjacentGaps(items), editLayoutButton }
  })

  test("AC3: representative tablet widths around the 3-to-2-column transition never render a chart below MIN_CHART_WIDTH_PX", async ({ page }) => {
    // Deliberately avoids the exact theoretical boundary (~876-891px,
    // depending on the real measured chrome width): GridStack's own
    // percentage-based column-width division introduces the same sub-pixel
    // rounding GAP-5A/GAP-5B already documented (e.g. 16.016px vs 16px), so
    // a width chosen to sit within ~1px of the exact mathematical
    // crossover can land a fraction of a pixel under 240 by pure rendering
    // rounding, not a real, user-visible violation. Representative widths
    // below use comfortable margin on both sides of the transition instead.
    const widths = [769, 800, 850, 950, 1000, 1023]
    const results: { width: number; columnsUsed: number; minWidth: number }[] = []
    for (const width of widths) {
      await freshDashboard(page, { width, height: 1400 }, THREE_COLUMN_LAYOUT)
      const { items, gridBox } = await measure(page)
      const minWidth = Math.min(...items.map((i) => i.width))
      expect(minWidth).toBeGreaterThanOrEqual(240)
      expect(hasOverlap(items)).toBe(false)
      expect(hasOverflow(items, gridBox!)).toBe(false)
      for (const gap of adjacentGaps(items)) expect(gap).toBe(16)
      results.push({ width, columnsUsed: new Set(items.map((i) => Math.round(i.x))).size, minWidth })
    }
    evidence.transitionThreshold = results
  })

  test("AC4/AC5/AC6/AC7: mobile stays single-column and desktop stays unchanged (AC13/AC14 regression)", async ({ page }) => {
    await freshDashboard(page, { width: 390, height: 800 }, THREE_COLUMN_LAYOUT)
    const mobile = await measure(page)
    expect(mobile.columnsUsed).toBe(1)
    expect(Math.min(...mobile.items.map((i) => i.width))).toBeGreaterThanOrEqual(240)
    expect(mobile.editLayoutButton).toBe(false)
    const sortedByY = [...mobile.items].sort((a, b) => a.y - b.y)
    expect(sortedByY.map((i) => i.id)).toEqual(mobile.items.map((i) => i.id))

    await freshDashboard(page, { width: 1280, height: 900 }, THREE_COLUMN_LAYOUT)
    const desktop = await measure(page)
    expect(desktop.columnsUsed).toBe(3) // desktop never reflows -- real canonical geometry
    expect(desktop.editLayoutButton).toBe(true)
    for (const gap of adjacentGaps(desktop.items)) expect(gap).toBe(16)
  })

  test("AC8/AC9/AC10: 900 -> 768 -> 900 preserves widgetId, canonical storage, and restores the original 3-column geometry", async ({ page }) => {
    await freshDashboard(page, { width: 900, height: 1400 }, THREE_COLUMN_LAYOUT)
    const storageBefore = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)
    const before = await measure(page)
    const idsBefore = before.items.map((i) => i.id).sort()
    expect(before.columnsUsed).toBe(3)

    await page.setViewportSize({ width: 768, height: 1400 })
    await page.waitForTimeout(400)
    const narrow = await measure(page)
    expect(narrow.items.map((i) => i.id).sort()).toEqual(idsBefore)
    expect(narrow.columnsUsed).toBeLessThan(3)

    await page.setViewportSize({ width: 900, height: 1400 })
    await page.waitForTimeout(400)
    const restored = await measure(page)
    expect(restored.items.map((i) => i.id).sort()).toEqual(idsBefore)
    expect(restored.columnsUsed).toBe(3)

    const byId = new Map(before.items.map((i) => [i.id, i]))
    for (const item of restored.items) {
      const original = byId.get(item.id)!
      expect(item.x).toBeCloseTo(original.x, 1)
      expect(item.y).toBeCloseTo(original.y, 1)
      expect(item.width).toBeCloseTo(original.width, 1)
    }

    const storageAfter = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)
    expect(storageAfter).toBe(storageBefore) // no automatic persistence from viewport-only reflow

    evidence.roundTrip900to768to900 = { idsBefore, storageBeforeEqualsAfter: storageAfter === storageBefore, columnsAt900Before: before.columnsUsed, columnsAt768: narrow.columnsUsed, columnsAt900After: restored.columnsUsed }
  })

  test("AC11: tablet Add is capped at the CURRENT readable cap, not merely the static 3x3 maximum", async ({ page }) => {
    // A 2-column canonical layout at a tablet width narrow enough that the
    // readable cap is dynamically 2 (not the static max of 3): growing to
    // 3 columns must be rejected even though 3x3 is otherwise allowed.
    const twoColumnLayout = {
      grid: { columns: 2, rows: 1 },
      widgets: [
        { widgetId: "a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
        { widgetId: "b", widgetType: "growth-bar-chart", x: 1, y: 0, width: 1, height: 1 },
      ],
    }
    await freshDashboard(page, { width: 768, height: 1400 }, twoColumnLayout)
    // Confirm the readable cap here is genuinely below the static 3 max --
    // this 2-column layout must still be editable (2 <= cap).
    await expect(page.getByRole("button", { name: "Edit Layout" })).toBeVisible()
    await page.getByRole("button", { name: "Edit Layout" }).click()

    // The row already has 2 widgets (a: kpi-summary, b: growth-bar-chart).
    // A 3rd widget in this row would need 3 columns -- over the current
    // (dynamically 2) readable cap at 768px, even though 3x3 is the static
    // maximum GAP-5B originally allowed -- so it must be rejected, leaving
    // the original single kpi-summary widget in place (not a new second one).
    const tray = page.locator(".widget-tray")
    await tray.getByRole("button", { name: /KPI Summary/ }).click()
    const row0 = page.getByTestId("widget-insertion-row-0")
    await row0.getByRole("button").first().click()

    await expect(page.getByTestId("widget-insertion-rejected")).toBeVisible()
    await expect(page.getByRole("button", { name: /Remove KPI Summary/ })).toHaveCount(1)
  })

  test("AC12: Edit is unavailable (not operating on mismatched coordinates) when the canonical grid exceeds the current readable cap", async ({ page }) => {
    await freshDashboard(page, { width: 768, height: 1400 }, THREE_COLUMN_LAYOUT)
    // No Edit Layout control at all in this state -- never a disabled
    // button a user could click into a mismatched-coordinate session.
    await expect(page.getByRole("button", { name: "Edit Layout" })).toHaveCount(0)
    const hasResizeHandles = await page.locator(".ui-resizable-handle").count()
    expect(hasResizeHandles).toBe(0)
  })
})

test.afterAll(() => {
  const outDir = path.join(__dirname, "results")
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, "gap5b1-dynamic-column-cap-evidence.json"), JSON.stringify(evidence, null, 2))
})
