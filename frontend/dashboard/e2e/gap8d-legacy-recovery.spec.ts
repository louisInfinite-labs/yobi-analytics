import { test, expect, type Page } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** GAP-8D browser evidence, against the real production `/dashboard` route:
 * legacy 4/5-column payload recovery (banner, no edit, explicit Convert with
 * backup-first persistence) and the current 1x1-3x3 contract (Add cannot grow
 * a fourth column, exact 16px gaps, >= 240px widths, tablet readable cap).
 */

const KEY = "yobi-analytics-canonical-dashboard-layout"
const BACKUP_KEY = `${KEY}-legacy-backup`
const MIN = 240

const unit = (widgetId: string, widgetType: string, x: number, y: number, extra: object = {}) => ({ widgetId, widgetType, x, y, width: 1, height: 1, ...extra })

const MIGRATABLE_LEGACY = {
  grid: { columns: 4, rows: 2 },
  widgets: [
    unit("l0", "kpi-summary", 0, 0),
    unit("l1", "ranking", 1, 0),
    unit("l2", "growth-bar-chart", 2, 0),
    unit("l3", "contribution-ring", 3, 0, { comparison: { creatorIds: ["creator-a", "creator-b"], comparisonItemIds: ["revenue", "growth"] } }),
    unit("l4", "insights", 0, 1),
    unit("l5", "video-stats-table", 1, 1, { settings: { note: "kept" } }),
  ],
}
const MIGRATABLE_RAW = JSON.stringify(MIGRATABLE_LEGACY)

const UNMIGRATABLE_LEGACY = {
  grid: { columns: 5, rows: 2 },
  widgets: Array.from({ length: 10 }, (_, i) => unit(`u${i}`, i % 2 ? "growth-bar-chart" : "contribution-ring", i % 5, Math.floor(i / 5))),
}
const UNMIGRATABLE_RAW = JSON.stringify(UNMIGRATABLE_LEGACY)

const THREE_BY_TWO = {
  grid: { columns: 3, rows: 2 },
  widgets: [
    unit("c0", "kpi-summary", 0, 0),
    unit("c1", "ranking", 1, 0),
    unit("c2", "growth-bar-chart", 2, 0),
    unit("c3", "contribution-ring", 0, 1),
    unit("c4", "insights", 1, 1),
    unit("c5", "kpi-summary", 2, 1),
  ],
}

interface Rect {
  id: string
  x: number
  y: number
  width: number
  height: number
  right: number
  bottom: number
}

async function seed(page: Page, viewport: { width: number; height: number }, raw: string | null) {
  await page.setViewportSize(viewport)
  await page.goto("/dashboard")
  await page.evaluate(({ key, value }) => { localStorage.clear(); if (value !== null) localStorage.setItem(key, value) }, { key: KEY, value: raw })
  await page.reload()
  await expect(page.getByText("Daily Gain").first()).toBeVisible()
}

const read = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key)
const editButton = (page: Page) => page.getByRole("button", { name: "Edit Layout" })
const banner = (page: Page) => page.getByTestId("legacy-layout-banner")

async function measure(page: Page): Promise<Rect[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".widget-shell")].map((el) => {
      const r = el.getBoundingClientRect()
      return { id: el.closest("[gs-id]")!.getAttribute("gs-id")!, x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
    }),
  )
}

async function settled(page: Page): Promise<Rect[]> {
  let previous = JSON.stringify(await measure(page))
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(150)
    const current = JSON.stringify(await measure(page))
    if (current === previous) return JSON.parse(current)
    previous = current
  }
  throw new Error("layout never settled")
}

function gaps(items: Rect[]) {
  const out: number[] = []
  for (const a of items) {
    for (const b of items) {
      if (a === b) continue
      const vOverlap = a.y < b.bottom && b.y < a.bottom
      const hOverlap = a.x < b.right && b.x < a.right
      if (vOverlap && b.x > a.x && b.x - a.right < 100) out.push(b.x - a.right)
      if (hOverlap && b.y > a.y && b.y - a.bottom < 100) out.push(b.y - a.bottom)
    }
  }
  return out
}

const distinctColumns = (rects: Rect[]) => new Set(rects.map((r) => Math.round(r.x))).size
const evidence: Record<string, unknown> = {}

test.describe("GAP-8D: legacy 4/5-column recovery", () => {
  test("Scenario 1: a migratable legacy payload shows recovery UI, stays untouched until Convert, then converts with a backup-first write", async ({ page }) => {
    await seed(page, { width: 1280, height: 1200 }, MIGRATABLE_RAW)

    await expect(banner(page)).toBeVisible()
    await expect(banner(page)).toContainText("older grid size")
    await expect(banner(page)).toContainText("preserved")
    await expect(page.getByTestId("legacy-layout-convert-note")).toContainText("positions")
    await expect(page.getByTestId("legacy-layout-convert-note")).toContainText("IDs and settings will be preserved")
    await expect(editButton(page)).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0)
    await expect(page.locator(".widget-tray")).toHaveCount(0)
    await expect(page.getByRole("button", { name: /reset|start with default/i })).toHaveCount(0)
    const convert = page.getByRole("button", { name: "Convert to 3x3" })
    await expect(convert).toBeVisible()
    // Loading (and a reload) wrote nothing.
    expect(await read(page, KEY)).toBe(MIGRATABLE_RAW)
    expect(await read(page, BACKUP_KEY)).toBeNull()
    await page.reload()
    await expect(banner(page)).toBeVisible()
    expect(await read(page, KEY)).toBe(MIGRATABLE_RAW)
    expect(await read(page, BACKUP_KEY)).toBeNull()

    await page.getByRole("button", { name: "Convert to 3x3" }).click()
    await expect(banner(page)).toHaveCount(0)

    // Backup holds the exact original payload; the primary is now a valid <= 3x3 layout.
    expect(await read(page, BACKUP_KEY)).toBe(MIGRATABLE_RAW)
    const converted = JSON.parse((await read(page, KEY))!)
    expect(converted.grid.columns).toBeLessThanOrEqual(3)
    expect(converted.grid.rows).toBeLessThanOrEqual(3)
    expect(converted.widgets.map((w: { widgetId: string }) => w.widgetId)).toEqual(MIGRATABLE_LEGACY.widgets.map((w) => w.widgetId))
    for (const [i, w] of converted.widgets.entries()) {
      const original = MIGRATABLE_LEGACY.widgets[i] as Record<string, unknown>
      expect(w.widgetType).toBe(original.widgetType)
      expect(w.height).toBe(original.height)
      expect(w.comparison).toEqual(original.comparison)
      expect(w.settings).toEqual(original.settings)
    }
    const primaryAfterConvert = await read(page, KEY)

    // A reload shows the normal Dashboard, editable, with exact 16px gaps and readable widths.
    await page.reload()
    await expect(page.getByText("Daily Gain").first()).toBeVisible()
    await expect(banner(page)).toHaveCount(0)
    await expect(editButton(page)).toBeVisible()
    expect(await read(page, KEY)).toBe(primaryAfterConvert)
    expect(await read(page, BACKUP_KEY)).toBe(MIGRATABLE_RAW)
    const rects = await settled(page)
    expect(rects).toHaveLength(6)
    expect(distinctColumns(rects)).toBeLessThanOrEqual(3)
    expect(Math.min(...rects.map((r) => r.width))).toBeGreaterThanOrEqual(MIN)
    const measuredGaps = gaps(rects)
    expect(measuredGaps.length).toBeGreaterThan(0)
    for (const gap of measuredGaps) expect(gap).toBe(16)
    evidence.migratable = {
      backupIsExactRaw: true,
      primaryBeforeConvertUnchanged: true,
      converted: { grid: converted.grid, ids: converted.widgets.map((w: { widgetId: string }) => w.widgetId) },
      afterReload: { widths: rects.map((r) => r.width), gaps: measuredGaps, editAvailable: true },
    }
  })

  test("Scenario 2: an unmigratable 5x2 legacy payload (ten 1X-only widgets) is preserved byte-identical with no Convert, Edit, Add or Save", async ({ page }) => {
    await seed(page, { width: 1280, height: 1200 }, UNMIGRATABLE_RAW)

    await expect(banner(page)).toBeVisible()
    await expect(page.getByTestId("legacy-layout-no-convert")).toContainText("cannot be converted")
    await expect(page.getByRole("button", { name: /convert/i })).toHaveCount(0)
    await expect(page.getByRole("button", { name: /reset|start with default/i })).toHaveCount(0)
    await expect(editButton(page)).toHaveCount(0)
    await expect(page.locator(".widget-tray")).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0)
    expect(await read(page, KEY)).toBe(UNMIGRATABLE_RAW)
    expect(await read(page, BACKUP_KEY)).toBeNull()

    await page.reload()
    await expect(banner(page)).toBeVisible()
    await expect(editButton(page)).toHaveCount(0)
    expect(await read(page, KEY)).toBe(UNMIGRATABLE_RAW)
    expect(await read(page, BACKUP_KEY)).toBeNull()
    evidence.unmigratable = { bannerShown: true, convertShown: false, editShown: false, storageByteIdenticalAfterReload: true }
  })
})

test.describe("GAP-8D: current 1x1-3x3 contract", () => {
  test("Scenario 3: 3x3-contract layout stays editable and readable, Add cannot create a fourth column, gaps are exactly 16px", async ({ page }) => {
    await seed(page, { width: 1280, height: 1500 }, JSON.stringify(THREE_BY_TWO))

    await expect(banner(page)).toHaveCount(0)
    await expect(editButton(page)).toBeVisible()
    const rects = await settled(page)
    expect(distinctColumns(rects)).toBe(3)
    expect(Math.min(...rects.map((r) => r.width))).toBeGreaterThanOrEqual(MIN)
    const measuredGaps = gaps(rects)
    for (const gap of measuredGaps) expect(gap).toBe(16)

    await editButton(page).click()
    const totalBefore = await page.getByRole("button", { name: /^Remove / }).count()
    await page.locator(".widget-tray").getByRole("button", { name: /KPI Summary/ }).click()
    await page.getByTestId("widget-insertion-row-0").getByRole("button").first().click() // would need a 4th column
    await expect(page.getByTestId("widget-insertion-rejected")).toBeVisible()
    await expect(page.getByTestId("insertion-placeholder")).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Insert here" })).toBeDisabled()
    await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(totalBefore)
    expect(distinctColumns(await settled(page))).toBe(3)
    evidence.current3x3 = { columns: distinctColumns(rects), minWidth: Math.min(...rects.map((r) => r.width)), gaps: measuredGaps, fourthColumnAddRejected: true }
  })

  test("Scenario 3b: Restore Default is still the 2x2 default and a default layout can grow to 3 columns but no further", async ({ page }) => {
    await seed(page, { width: 1280, height: 1500 }, null)
    await editButton(page).click()
    const tray = page.locator(".widget-tray")
    await tray.getByRole("button", { name: /KPI Summary/ }).click()
    await page.getByTestId("widget-insertion-row-0").getByRole("button").first().click()
    await page.getByRole("button", { name: "Insert here" }).click()
    expect(distinctColumns(await settled(page))).toBe(3)
    await tray.getByRole("button", { name: /KPI Summary/ }).click()
    await page.getByTestId("widget-insertion-row-0").getByRole("button").first().click()
    await expect(page.getByTestId("widget-insertion-rejected")).toBeVisible()

    await page.getByRole("button", { name: "Restore Default" }).click()
    await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(4)
    expect(distinctColumns(await settled(page))).toBe(2)
  })

  test("Scenario 4: tablet keeps the 3-column maximum, reduces to 2 when only 2 are readable, and never shows 4 columns", async ({ page }) => {
    await seed(page, { width: 900, height: 1400 }, JSON.stringify({ grid: { columns: 3, rows: 1 }, widgets: THREE_BY_TWO.widgets.slice(0, 3) })) // wrapper 776
    const wide = await settled(page)
    expect(distinctColumns(wide)).toBe(3)
    expect(Math.min(...wide.map((r) => r.width))).toBeGreaterThanOrEqual(MIN)
    await expect(editButton(page)).toBeVisible()
    for (const gap of gaps(wide)) expect(gap).toBe(16)

    await page.setViewportSize({ width: 891, height: 1400 }) // wrapper 767: only 2 readable columns
    await expect(editButton(page)).toHaveCount(0)
    const narrow = await settled(page)
    expect(distinctColumns(narrow)).toBe(2)
    expect(Math.min(...narrow.map((r) => r.width))).toBeGreaterThanOrEqual(MIN)
    for (const gap of gaps(narrow)) expect(gap).toBe(16)

    await page.setViewportSize({ width: 1800, height: 1400 })
    await expect(editButton(page)).toBeVisible()
    expect(distinctColumns(await settled(page))).toBe(3) // width alone would admit more; the product max does not
    evidence.tablet = { wideColumns: distinctColumns(wide), narrowColumns: distinctColumns(narrow), neverFour: true }
  })
})

test.afterAll(() => {
  const outDir = path.join(__dirname, "results")
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, "gap8d-legacy-recovery-evidence.json"), JSON.stringify(evidence, null, 2))
})
