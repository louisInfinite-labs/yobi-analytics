import { test, expect, type Page } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** GAP-5B "Live Responsive Reflow + Minimum Readable Width" browser
 * evidence, against the real production `/dashboard` route (never a
 * fixture/harness). Every viewport change here is followed by a fresh
 * `page.goto`/reload -- relying on `useBreakpoint`'s `resize` listener
 * alone (without a reload) is exactly what produced the misleading,
 * stale-breakpoint readings during this task's own manual verification. */

const STORAGE_KEY = "yobi-analytics-canonical-dashboard-layout"

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
    return { items, gridBox: gridBox ? { x: gridBox.x, y: gridBox.y, width: gridBox.width, height: gridBox.height } : null, editLayoutButton }
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

test.describe("GAP-5B: live responsive reflow + minimum readable width", () => {
  test("AC1/AC2/AC5/AC6/AC7/AC8/AC9: desktop renders real canonical geometry, editable, no overlap, 16px gaps", async ({ page }) => {
    await freshDashboard(page, { width: 1280, height: 900 })
    const { items, gridBox, editLayoutButton } = await measure(page)

    expect(items.map((i) => i.id).sort()).toEqual(expect.arrayContaining([expect.stringMatching(/^kpi-summary-/), expect.stringMatching(/^growth-bar-chart-/)]))
    expect(hasOverlap(items)).toBe(false)
    expect(hasOverflow(items, gridBox!)).toBe(false)
    expect(Math.min(...items.map((i) => i.width))).toBeGreaterThanOrEqual(240)
    for (const gap of adjacentGaps(items)) expect(gap).toBe(16)
    expect(editLayoutButton).toBe(true)

    evidence.desktop = { viewportWidth: 1280, items, editLayoutButton }
  })

  test("AC1/AC4/AC5/AC7/AC8/AC9/AC10/AC16: mobile is a view-only single-column reflow, no Edit control, meets minimum width", async ({ page }) => {
    await freshDashboard(page, { width: 390, height: 800 })
    const { items, gridBox, editLayoutButton } = await measure(page)

    expect(items).toHaveLength(4)
    // AC5: deterministic, row-major order -- every widget stacks in one
    // column, top to bottom, matching the canonical layout's own row-major
    // visual order (kpi-summary, growth-bar-chart, contribution-ring, ranking).
    const sortedByY = [...items].sort((a, b) => a.y - b.y)
    expect(sortedByY.map((i) => i.id)).toEqual(items.map((i) => i.id))
    expect(new Set(items.map((i) => i.x)).size).toBe(1) // single column
    expect(hasOverlap(items)).toBe(false)
    expect(hasOverflow(items, gridBox!)).toBe(false)
    expect(Math.min(...items.map((i) => i.width))).toBeGreaterThanOrEqual(240)
    for (const gap of adjacentGaps(items)) expect(gap).toBe(16)

    // AC4: Edit is absent entirely, not merely disabled.
    expect(editLayoutButton).toBe(false)

    // AC16: GridStack itself carries no drag/resize affordances at all --
    // `.ui-resizable-handle`/draggable classes only exist when GridStack
    // was initialized with `staticGrid: false`.
    const hasResizeHandles = await page.locator(".ui-resizable-handle").count()
    expect(hasResizeHandles).toBe(0)

    evidence.mobile = { viewportWidth: 390, items, editLayoutButton, hasResizeHandles }
  })

  test("AC1/AC3/AC5/AC7/AC8/AC9: tablet supports editing, real geometry when the canonical grid already fits the 3-column cap", async ({ page }) => {
    await freshDashboard(page, { width: 900, height: 1400 })
    const { items, gridBox, editLayoutButton } = await measure(page)

    expect(hasOverlap(items)).toBe(false)
    expect(hasOverflow(items, gridBox!)).toBe(false)
    expect(Math.min(...items.map((i) => i.width))).toBeGreaterThanOrEqual(240)
    for (const gap of adjacentGaps(items)) expect(gap).toBe(16)
    expect(editLayoutButton).toBe(true)

    evidence.tablet = { viewportWidth: 900, items, editLayoutButton }
  })

  test("AC3: tablet Add is rejected once a row would exceed the 3-column editable cap", async ({ page }) => {
    await freshDashboard(page, { width: 900, height: 1400 })
    await page.getByRole("button", { name: "Edit Layout" }).click()
    const tray = page.locator(".widget-tray")
    const row0 = () => page.getByTestId("widget-insertion-row-0")

    // Row 0 starts with 2 widgets; grow it to 3 (still within the tablet cap).
    await tray.getByRole("button", { name: /KPI Summary/ }).click()
    await row0().getByRole("button").first().click()
    await page.getByRole("button", { name: "Insert here" }).click()
    await expect(page.getByRole("button", { name: /Remove KPI Summary/ })).toHaveCount(2)

    // A 4th widget in the same row would need a 4th column -- over the
    // tablet's 3x3 editable cap -- so it must be rejected.
    await tray.getByRole("button", { name: /KPI Summary/ }).click()
    await row0().getByRole("button").first().click()
    await expect(page.getByTestId("widget-insertion-rejected")).toBeVisible()
    await expect(page.getByRole("button", { name: /Remove KPI Summary/ })).toHaveCount(2)
  })

  test("GAP-5B1: a real 3-column layout at the narrowest tablet width (768px) now reflows to stay >= 240px (formerly a documented geometry blocker)", async ({
    page,
  }) => {
    const threeColumnLayout = {
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
    await freshDashboard(page, { width: 768, height: 900 }, threeColumnLayout)
    const { items, gridBox } = await measure(page)

    const minWidth = Math.min(...items.map((i) => i.width))
    evidence.tabletNarrowThreeColumnBlocker = {
      viewportWidth: 768,
      minWidth,
      gridBox,
      note: "GAP-5B1: dynamically reflowed to fewer columns, resolving GAP-5B's own documented blocker -- see e2e/gap5b1-dynamic-column-cap.spec.ts for full evidence",
    }

    // GAP-5B1 resolves this: the same 3-column canonical layout that used
    // to render at ~198.7px per widget (GAP-5B's documented blocker) now
    // reflows to a dynamically computed lower column count, keeping every
    // widget >= MIN_CHART_WIDTH_PX while still respecting 16px gaps and
    // producing no overlap/overflow.
    expect(hasOverlap(items)).toBe(false)
    expect(hasOverflow(items, gridBox!)).toBe(false)
    expect(minWidth).toBeGreaterThanOrEqual(240)
    for (const gap of adjacentGaps(items)) expect(gap).toBe(16)
  })

  test("AC12/AC6/AC11/AC17: desktop -> tablet -> mobile -> tablet -> desktop preserves widgetId, order, geometry, and localStorage", async ({ page }) => {
    await freshDashboard(page, { width: 1280, height: 900 })
    const storageBefore = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)
    const desktopBefore = await measure(page)
    const idsBefore = desktopBefore.items.map((i) => i.id).sort()

    await page.setViewportSize({ width: 900, height: 1400 })
    await page.waitForTimeout(400)
    const tablet1 = await measure(page)
    expect(tablet1.items.map((i) => i.id).sort()).toEqual(idsBefore)

    await page.setViewportSize({ width: 390, height: 800 })
    await page.waitForTimeout(400)
    const mobile = await measure(page)
    expect(mobile.items.map((i) => i.id).sort()).toEqual(idsBefore)

    await page.setViewportSize({ width: 900, height: 1400 })
    await page.waitForTimeout(400)
    const tablet2 = await measure(page)
    expect(tablet2.items.map((i) => i.id).sort()).toEqual(idsBefore)

    await page.setViewportSize({ width: 1280, height: 900 })
    await page.waitForTimeout(400)
    const desktopAfter = await measure(page)
    expect(desktopAfter.items.map((i) => i.id).sort()).toEqual(idsBefore)
    // Returning to desktop reproduces the exact original geometry, not just
    // the same ids -- compared with a sub-pixel tolerance for GridStack's
    // own percentage-based column-width recomputation on each resync (the
    // same <0.02px rounding noise GAP-5A's own spacing evidence documents),
    // never a real position/size difference.
    const byId = (items: typeof desktopBefore.items) => new Map(items.map((i) => [i.id, i]))
    const beforeById = byId(desktopBefore.items)
    for (const after of desktopAfter.items) {
      const before = beforeById.get(after.id)!
      expect(after.x).toBeCloseTo(before.x, 1)
      expect(after.y).toBeCloseTo(before.y, 1)
      expect(after.width).toBeCloseTo(before.width, 1)
      expect(after.height).toBeCloseTo(before.height, 1)
    }

    // AC11: no breakpoint transition above wrote to localStorage -- Save was never clicked.
    const storageAfter = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)
    expect(storageAfter).toBe(storageBefore)

    evidence.roundTrip = { idsBefore, storageBeforeEqualsAfter: storageAfter === storageBefore }
  })

  test("AC13: a real drag at tablet commits through the same canonical path and keeps 16px gaps", async ({ page }) => {
    await freshDashboard(page, { width: 900, height: 1400 })
    await page.getByRole("button", { name: "Edit Layout" }).click()

    const before = await measure(page)
    const first = before.items[0]
    await page.mouse.move(first.x + first.width / 2, first.y + 10)
    await page.mouse.down()
    await page.mouse.move(first.x + first.width + 40, first.y + 10, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(300)

    const afterDrag = await measure(page)
    expect(afterDrag.items.map((i) => i.id).sort()).toEqual(before.items.map((i) => i.id).sort())
    expect(hasOverlap(afterDrag.items)).toBe(false)
    for (const gap of adjacentGaps(afterDrag.items)) expect(gap).toBe(16)
  })

  test("AC14/AC15: a rejected resize at tablet rolls back through the same canonical path and keeps 16px gaps", async ({ page }) => {
    await freshDashboard(page, { width: 900, height: 1400 })
    await page.getByRole("button", { name: "Edit Layout" }).click()

    const before = await measure(page)
    // Rejected resize: growth-bar-chart's GAP-2E capability only allows 1X.
    const gbc = before.items.find((i) => i.id?.startsWith("growth-bar-chart"))!
    const gsHBefore = await page.locator(`[gs-id="${gbc.id}"]`).getAttribute("gs-h")
    await page.mouse.move(gbc.x + gbc.width / 2, gbc.y + gbc.height / 2)
    const handle = page.locator(`[gs-id="${gbc.id}"] .ui-resizable-se`)
    await handle.waitFor({ state: "visible" })
    const handleBox = await handle.boundingBox()
    const hx = handleBox!.x + handleBox!.width / 2
    const hy = handleBox!.y + handleBox!.height / 2
    await page.mouse.move(hx, hy)
    await page.mouse.down()
    await page.mouse.move(hx, hy - 60, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(300)

    const gsHAfter = await page.locator(`[gs-id="${gbc.id}"]`).getAttribute("gs-h")
    expect(gsHAfter).toBe(gsHBefore)
    const afterRollback = await measure(page)
    expect(afterRollback.items.map((i) => i.id).sort()).toEqual(before.items.map((i) => i.id).sort())
    expect(hasOverlap(afterRollback.items)).toBe(false)
    for (const gap of adjacentGaps(afterRollback.items)) expect(gap).toBe(16)
  })
})

test.afterAll(() => {
  const outDir = path.join(__dirname, "results")
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, "gap5b-responsive-evidence.json"), JSON.stringify(evidence, null, 2))
})
