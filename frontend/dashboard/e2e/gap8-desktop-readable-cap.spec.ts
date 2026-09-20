import { test, expect, type Page } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** GAP-8 "Desktop Dynamic Readable Column Cap" browser evidence, against the
 * real production `/dashboard` route. The grid container is
 * min(viewport - 60, 1440) - 64 px wide (navbar + page padding), and
 * GridStack renders every widget at W / columns - 16 px, so n columns are
 * readable iff W >= 256 * n. GAP-8D: the product maximum is 3 columns, so
 * the cap is min(3, floor(W / 256)); n=3 needs W >= 768 (a >= 892px viewport).
 */

const STORAGE_KEY = "yobi-analytics-canonical-dashboard-layout"
const MIN = 240

const THREE_COLUMN_LAYOUT = {
  grid: { columns: 3, rows: 1 },
  widgets: [
    { widgetId: "w0", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
    { widgetId: "w1", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
    { widgetId: "w2", widgetType: "growth-bar-chart", x: 2, y: 0, width: 1, height: 1 },
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

async function freshDashboard(page: Page, viewport: { width: number; height: number }, seed: unknown) {
  await page.setViewportSize(viewport)
  await page.goto("/dashboard")
  await page.evaluate(({ key, value }) => { localStorage.clear(); localStorage.setItem(key, JSON.stringify(value)) }, { key: STORAGE_KEY, value: seed })
  await page.reload()
  await expect(page.getByText("Daily Gain").first()).toBeVisible()
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const wrapper = document.querySelector(".dashboard-grid-v2")!.parentElement!
    const rects: Rect[] = [...document.querySelectorAll<HTMLElement>(".widget-shell")].map((el) => {
      const r = el.getBoundingClientRect()
      return { id: el.closest("[gs-id]")!.getAttribute("gs-id")!, x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
    })
    const grid = document.querySelector(".grid-stack")!.getBoundingClientRect()
    return { wrapperWidth: wrapper.getBoundingClientRect().width, gridBox: { x: grid.x, right: grid.right, bottom: grid.bottom, y: grid.y }, rects }
  })
}

/** Re-measures until two consecutive reads are identical (GridStack animates). */
async function settled(page: Page) {
  let previous = JSON.stringify(await measure(page))
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(150)
    const current = JSON.stringify(await measure(page))
    if (current === previous) return JSON.parse(current) as Awaited<ReturnType<typeof measure>>
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

function overlapsAny(items: Rect[]) {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]
      const b = items[j]
      if (a.x < b.right - 0.5 && b.x < a.right - 0.5 && a.y < b.bottom - 0.5 && b.y < a.bottom - 0.5) return true
    }
  }
  return false
}

const overflows = (m: Awaited<ReturnType<typeof measure>>) =>
  m.rects.some((r) => r.x < m.gridBox.x - 0.5 || r.right > m.gridBox.right + 0.5 || r.bottom > m.gridBox.bottom + 0.5)

const cap = (wrapperWidth: number) => Math.max(1, Math.min(3, Math.floor(wrapperWidth / (MIN + 16))))
const distinctColumns = (rects: Rect[]) => new Set(rects.map((r) => Math.round(r.x))).size
const editButton = (page: Page) => page.getByRole("button", { name: "Edit Layout" })
const readStorage = (page: Page) => page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)
const gsGeometry = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[gs-id]")]
      .map((el) => ({ id: el.getAttribute("gs-id")!, x: el.getAttribute("gs-x") ?? "0", y: el.getAttribute("gs-y") ?? "0", w: el.getAttribute("gs-w") ?? "1", h: el.getAttribute("gs-h") ?? "1" }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  )

const evidence: Record<string, unknown> = {}

test.describe("GAP-8: desktop dynamic readable column cap", () => {
  test("AC3/AC10/AC17: a 3-column layout at a wide desktop renders three readable columns (never more than the product maximum) and stays editable", async ({ page }) => {
    await freshDashboard(page, { width: 1600, height: 900 }, THREE_COLUMN_LAYOUT)
    const m = await settled(page)

    expect(Math.floor(m.wrapperWidth / (MIN + 16))).toBeGreaterThan(3) // width alone would admit more than 3
    expect(cap(m.wrapperWidth)).toBe(3) // ...but the product maximum caps it
    expect(m.rects).toHaveLength(3)
    expect(distinctColumns(m.rects)).toBe(3)
    const minWidth = Math.min(...m.rects.map((r) => r.width))
    expect(minWidth).toBeGreaterThanOrEqual(MIN)
    for (const gap of gaps(m.rects)) expect(gap).toBe(16)
    await expect(editButton(page)).toBeVisible()
    evidence.wide3 = { viewport: 1600, wrapperWidth: m.wrapperWidth, cap: cap(m.wrapperWidth), widths: m.rects.map((r) => r.width), minWidth, editAvailable: true, gaps: gaps(m.rects) }
  })

  test("AC4/AC5/AC11/AC12/AC13/AC16/AC17: the same layout at a 2-column-readable width reflows, hides Edit, and touches no stored data", async ({ page }) => {
    await freshDashboard(page, { width: 891, height: 900 }, THREE_COLUMN_LAYOUT) // wrapper 767 < 768
    const storageBefore = await readStorage(page)
    const m = await settled(page)

    expect(cap(m.wrapperWidth)).toBe(2)
    expect(m.rects.map((r) => r.id).sort()).toEqual(["w0", "w1", "w2"])
    expect(distinctColumns(m.rects)).toBeLessThanOrEqual(2)
    expect(Math.min(...m.rects.map((r) => r.width))).toBeGreaterThanOrEqual(MIN)
    expect(overlapsAny(m.rects)).toBe(false)
    expect(overflows(m)).toBe(false)
    for (const gap of gaps(m.rects)) expect(gap).toBe(16)
    await expect(editButton(page)).toHaveCount(0)
    expect(await readStorage(page)).toBe(storageBefore)
    // Deterministic row-major reflow: two in the first row, the third wraps.
    const sorted = [...m.rects].sort((a, b) => a.y - b.y || a.x - b.x)
    expect(sorted.map((r) => r.id)).toEqual(["w0", "w1", "w2"])
    expect(sorted[2].x).toBeCloseTo(sorted[0].x, 0)
    expect(sorted[2].y).toBeGreaterThan(sorted[0].y)
    evidence.narrow2 = { viewport: 891, wrapperWidth: m.wrapperWidth, cap: cap(m.wrapperWidth), displayColumns: distinctColumns(m.rects), widths: m.rects.map((r) => r.width), editAvailable: false, storageUnchanged: true }
  })

  test("AC1/AC2: representative widths just above/below the 3-column threshold (exact thresholds are unit-tested)", async ({ page }) => {
    // wrapper = viewport - 124 (below the 1440 page cap): 892 -> 768 (>= 768), 891 -> 767 (< 768)
    await freshDashboard(page, { width: 892, height: 900 }, THREE_COLUMN_LAYOUT)
    const above = await settled(page)
    expect(cap(above.wrapperWidth)).toBe(3)
    expect(Math.min(...above.rects.map((r) => r.width))).toBeGreaterThanOrEqual(MIN)
    await expect(editButton(page)).toBeVisible()

    await page.setViewportSize({ width: 891, height: 900 })
    await expect(editButton(page)).toHaveCount(0)
    const below = await settled(page)
    expect(cap(below.wrapperWidth)).toBe(2)
    expect(Math.min(...below.rects.map((r) => r.width))).toBeGreaterThanOrEqual(MIN)
    evidence.boundary = { above: { wrapperWidth: above.wrapperWidth, min: Math.min(...above.rects.map((r) => r.width)) }, below: { wrapperWidth: below.wrapperWidth, min: Math.min(...below.rects.map((r) => r.width)) } }
  })

  test("AC13/AC14/AC15: shrink then widen keeps ids and storage byte-identical and restores the exact canonical geometry and Edit", async ({ page }) => {
    await freshDashboard(page, { width: 1600, height: 900 }, THREE_COLUMN_LAYOUT)
    const storageBefore = await readStorage(page)
    const wideBefore = await settled(page)
    const gsBefore = await gsGeometry(page)
    await expect(editButton(page)).toBeVisible()

    await page.setViewportSize({ width: 891, height: 900 })
    await expect(editButton(page)).toHaveCount(0)
    const shrunk = await settled(page)
    expect(shrunk.rects.map((r) => r.id).sort()).toEqual(wideBefore.rects.map((r) => r.id).sort())
    expect(await readStorage(page)).toBe(storageBefore)

    await page.setViewportSize({ width: 1600, height: 900 })
    await expect(editButton(page)).toBeVisible()
    const wideAfter = await settled(page)
    expect(await gsGeometry(page)).toEqual(gsBefore)
    expect(wideAfter.rects.map((r) => [r.id, r.x, r.y, r.width, r.height])).toEqual(wideBefore.rects.map((r) => [r.id, r.x, r.y, r.width, r.height]))
    expect(await readStorage(page)).toBe(storageBefore)
    expect(gsBefore.map((g) => `${g.x},${g.y},${g.w},${g.h}`)).toEqual(["0,0,1,2", "1,0,1,2", "2,0,1,2"])
    evidence.shrinkWiden = { idsBefore: wideBefore.rects.map((r) => r.id), idsShrunk: shrunk.rects.map((r) => r.id), idsAfter: wideAfter.rects.map((r) => r.id), storageUnchanged: true, canonicalGsRestored: gsBefore }
  })

  test("AC20: narrowing during Edit past the draft's readable width exits Edit without persisting anything", async ({ page }) => {
    await freshDashboard(page, { width: 1600, height: 900 }, THREE_COLUMN_LAYOUT)
    const storageBefore = await readStorage(page)
    await editButton(page).click()
    await expect(page.locator(".widget-shell--editing")).toHaveCount(3)

    await page.setViewportSize({ width: 891, height: 900 })
    await expect(page.locator(".widget-shell--editing")).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0)
    await expect(editButton(page)).toHaveCount(0) // canonical is still 3 columns wide
    expect(await readStorage(page)).toBe(storageBefore)
  })

  test("AC18/AC19: Add cannot exceed the current readable cap; a readable 3-column preview is >= 240px", async ({ page }) => {
    const twoColumn = {
      grid: { columns: 2, rows: 1 },
      widgets: [
        { widgetId: "a", widgetType: "kpi-summary", x: 0, y: 0, width: 1, height: 1 },
        { widgetId: "b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 },
      ],
    }
    // wrapper 776 (cap 3): growing 2 -> 3 columns is readable and previews.
    await freshDashboard(page, { width: 900, height: 1500 }, twoColumn)
    await editButton(page).click()
    await page.locator(".widget-tray").getByRole("button", { name: /KPI Summary/ }).click()
    await page.getByTestId("widget-insertion-row-0").getByRole("button").first().click()
    const preview = await settled(page)
    await expect(page.getByTestId("insertion-placeholder")).toHaveCount(1)
    expect(cap(preview.wrapperWidth)).toBe(3)
    expect(Math.min(...preview.rects.map((r) => r.width))).toBeGreaterThanOrEqual(MIN)

    // wrapper 767 (cap 2): the same 2 -> 3 growth is over the cap and is rejected.
    await freshDashboard(page, { width: 891, height: 1500 }, twoColumn)
    await editButton(page).click()
    await page.locator(".widget-tray").getByRole("button", { name: /KPI Summary/ }).click()
    const before = await settled(page)
    await page.getByTestId("widget-insertion-row-0").getByRole("button").first().click()
    await expect(page.getByTestId("widget-insertion-rejected")).toBeVisible()
    await expect(page.getByTestId("insertion-placeholder")).toHaveCount(0)
    await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(2)
    expect((await settled(page)).rects.map((r) => [r.id, r.width])).toEqual(before.rects.map((r) => [r.id, r.width]))
    evidence.add = { previewMinWidth: Math.min(...preview.rects.map((r) => r.width)), thirdColumnRejectedAtCap2: true }
  })

  test("GAP-8B: raw right.left - left.right is exactly 16 (no tolerance) at wide 3-col, 2-col-readable and tablet 3-col widths", async ({ page }) => {
    const cases = [
      { label: "wide3", viewport: 1600, seed: THREE_COLUMN_LAYOUT },
      { label: "readable2", viewport: 891, seed: THREE_COLUMN_LAYOUT },
      { label: "tablet3", viewport: 900, seed: THREE_COLUMN_LAYOUT },
    ]
    const out: Record<string, unknown> = {}
    for (const c of cases) {
      await freshDashboard(page, { width: c.viewport, height: 1200 }, c.seed)
      await settled(page)
      const raw = await page.evaluate(() => {
        const grid = document.querySelector<HTMLElement>(".grid-stack")!
        const items = [...grid.querySelectorAll<HTMLElement>(":scope > .grid-stack-item")]
          .map((el) => ({ id: el.getAttribute("gs-id")!, shell: el.querySelector<HTMLElement>(".widget-shell")!.getBoundingClientRect(), content: getComputedStyle(el.querySelector(".grid-stack-item-content")!) }))
          .sort((a, b) => a.shell.top - b.shell.top || a.shell.left - b.shell.left)
        const pairs: { left: string; right: string; leftRight: number; rightLeft: number; gap: number; marginRight: string; marginLeft: string }[] = []
        for (let i = 0; i + 1 < items.length; i++) {
          const a = items[i]
          const b = items[i + 1]
          if (Math.abs(a.shell.top - b.shell.top) > 1 || b.shell.left - a.shell.right > 40) continue
          pairs.push({ left: a.id, right: b.id, leftRight: a.shell.right, rightLeft: b.shell.left, gap: b.shell.left - a.shell.right, marginRight: a.content.right, marginLeft: b.content.left })
        }
        return {
          wrapperWidth: grid.parentElement!.parentElement!.getBoundingClientRect().width,
          columns: getComputedStyle(grid).getPropertyValue("--gs-columns").trim(),
          columnWidthCss: grid.style.getPropertyValue("--gs-column-width"),
          pairs,
        }
      })
      expect(raw.pairs.length).toBeGreaterThan(0)
      for (const pair of raw.pairs) {
        expect(pair.gap).toBe(16)
        expect(pair.marginRight).toBe("8px")
        expect(pair.marginLeft).toBe("8px")
      }
      out[c.label] = raw
    }
    evidence.rawGaps = out
  })

  test("AC8/AC9: rows are checked against the static breakpoint maximum, not the horizontal cap", async ({ page }) => {
    const tallNarrow = (rows: number) => ({
      grid: { columns: 2, rows },
      widgets: Array.from({ length: 2 * rows }, (_, i) => ({ widgetId: `t${i}`, widgetType: "kpi-summary", x: i % 2, y: Math.floor(i / 2), width: 1, height: 1 })),
    })
    // Tablet at 768px: horizontal cap is 2, yet a 2-column x 3-row layout is valid (rows <= 3).
    await freshDashboard(page, { width: 768, height: 1600 }, tallNarrow(3))
    await expect(editButton(page)).toBeVisible()
    // Desktop at 1300px: a 2-column x 3-row layout is valid and editable (rows <= 3).
    await freshDashboard(page, { width: 1300, height: 1600 }, tallNarrow(3))
    await expect(editButton(page)).toBeVisible()
  })

  test("AC22/AC23: tablet dynamic cap still works with the corrected formula; mobile stays view-only", async ({ page }) => {
    await freshDashboard(page, { width: 900, height: 1400 }, THREE_COLUMN_LAYOUT) // wrapper 776 >= 768
    expect(cap((await settled(page)).wrapperWidth)).toBe(3)
    await expect(editButton(page)).toBeVisible()
    // 891px -> wrapper 767 (< 768): the corrected formula no longer admits 3 columns
    // (they would render at 239.67px), so the 3-column layout reflows and Edit is off.
    await page.setViewportSize({ width: 891, height: 1400 })
    await expect(editButton(page)).toHaveCount(0)
    const narrow = await settled(page)
    expect(Math.min(...narrow.rects.map((r) => r.width))).toBeGreaterThanOrEqual(MIN)

    await freshDashboard(page, { width: 500, height: 1400 }, THREE_COLUMN_LAYOUT)
    await expect(editButton(page)).toHaveCount(0)
  })
})

test.afterAll(() => {
  const outDir = path.join(__dirname, "results")
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, "gap8-desktop-readable-cap-evidence.json"), JSON.stringify(evidence, null, 2))
})
