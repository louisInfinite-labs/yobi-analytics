import { test, expect, type Page } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** GAP-5A "Live GridStack Exact 16px Spacing Correction" browser evidence.
 *
 * MT-17 measured a real 0px gap between adjacent widgets on the actual
 * production `/dashboard` route: `dashboard.css`'s
 * `.grid-stack-item-content { inset: 0 !important }` overrode GridStack's
 * own `top/right/bottom/left: var(--gs-item-margin-*)` rule
 * (node_modules/gridstack/dist/gridstack.css), which is what GridStack's own
 * `margin: 8` (DashboardGrid.tsx's `GridStack.init` call) uses to inset each
 * widget's visible content box away from its (touching) outer grid cell.
 * Removing that override lets GridStack's own single margin mechanism
 * produce the required 8px+8px = 16px gap, with no second/compensating
 * margin rule added anywhere.
 *
 * This file measures the real, rendered `.widget-shell` boxes (the actual
 * visible widget content, portaled into `.grid-stack-item-content`) via
 * `getBoundingClientRect()` against the real production `/dashboard` route
 * -- never a fixture/harness -- at every stage GAP-5A's acceptance criteria
 * require: initial render at desktop/tablet/mobile widths, edit mode, after
 * a real completed drag, and after a real rejected resize's rollback.
 */

interface WidgetRect {
  id: string | null
  x: number
  y: number
  width: number
  height: number
  right: number
  bottom: number
}

interface Gap {
  type: "h" | "v"
  gap: number
  a: string | null
  b: string | null
}

async function measure(page: Page): Promise<{ items: WidgetRect[]; gaps: Gap[] }> {
  return page.evaluate(() => {
    const items = [...document.querySelectorAll<HTMLElement>(".widget-shell")].map((el) => {
      const r = el.getBoundingClientRect()
      const parent = el.closest("[gs-id]")
      return { id: parent?.getAttribute("gs-id") ?? null, x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
    })
    const gaps: { type: "h" | "v"; gap: number; a: string | null; b: string | null }[] = []
    for (let i = 0; i < items.length; i++) {
      for (let j = 0; j < items.length; j++) {
        if (i === j) continue
        const a = items[i]
        const b = items[j]
        const verticalOverlap = a.y < b.y + b.height && b.y < a.y + a.height
        const horizontalOverlap = a.x < b.x + b.width && b.x < a.x + a.width
        // "Adjacent" (not just "somewhere to the right/below"): the two boxes
        // share a row/column band and the gap is small enough to be a real
        // neighbor, not a widget two columns/rows away.
        if (verticalOverlap && b.x > a.x && b.x - a.right < 100) gaps.push({ type: "h", gap: b.x - a.right, a: a.id, b: b.id })
        if (horizontalOverlap && b.y > a.y && b.y - a.bottom < 100) gaps.push({ type: "v", gap: b.y - a.bottom, a: a.id, b: b.id })
      }
    }
    return { items, gaps }
  })
}

/** Every measured adjacent gap must be exactly 16px (raw
 * `right.left - left.right`, no tolerance). GAP-8B: fractional column widths
 * (a 3-column track's 33.333...% etc.) used to leave a 1/64px truncation
 * artifact (16.015625); `dashboard.css` now rounds GridStack's column width
 * down to a whole 1/64px, so the measurement is exact at every width. */
function expectAll16px(gaps: Gap[]) {
  expect(gaps.length).toBeGreaterThan(0)
  for (const g of gaps) {
    expect(g.gap).toBe(16)
  }
}

async function gotoFreshDashboard(page: Page) {
  await page.goto("/dashboard")
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await expect(page.getByText("Daily Gain")).toBeVisible()
}

const evidence: Record<string, Gap[]> = {}

test.describe("GAP-5A: live GridStack exact 16px spacing", () => {
  test("AC1/AC2/AC3: desktop horizontal and vertical adjacent gaps are exactly 16px, never 0 or 32", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await gotoFreshDashboard(page)

    const { gaps } = await measure(page)
    expectAll16px(gaps)
    for (const g of gaps) {
      expect(g.gap).not.toBe(0)
      expect(g.gap).not.toBe(32)
    }
    evidence.desktop = gaps
  })

  test("AC4: tablet and mobile viewports still measure exactly 16px (column reflow itself is a separate, known gap)", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 })
    await gotoFreshDashboard(page)
    const tablet = await measure(page)
    expectAll16px(tablet.gaps)
    evidence.tablet = tablet.gaps

    await page.setViewportSize({ width: 400, height: 900 })
    const mobile = await measure(page)
    expectAll16px(mobile.gaps)
    evidence.mobile = mobile.gaps
  })

  test("AC7: entering Edit mode does not change the measured 16px gap", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await gotoFreshDashboard(page)

    await page.getByRole("button", { name: "Edit Layout" }).click()
    const { gaps } = await measure(page)
    expectAll16px(gaps)
    evidence.edit = gaps
  })

  test("AC8/AC10: a valid drag settles with exactly 16px gaps and no new overflow", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await gotoFreshDashboard(page)
    await page.getByRole("button", { name: "Edit Layout" }).click()

    const before = await measure(page)
    const first = before.items[0]
    const startX = first.x + first.width / 2
    const startY = first.y + 10
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(startX + first.width + 40, startY, { steps: 10 })
    await page.mouse.move(startX + first.width + 40, startY, { steps: 2 })
    await page.mouse.up()
    await page.waitForTimeout(300)

    const after = await measure(page)
    expectAll16px(after.gaps)
    evidence.postDrag = after.gaps

    // AC10: no widget escapes the grid container's own bounds.
    const gridBox = await page.locator(".grid-stack").boundingBox()
    for (const item of after.items) {
      expect(item.x).toBeGreaterThanOrEqual(gridBox!.x - 0.5)
      expect(item.y).toBeGreaterThanOrEqual(gridBox!.y - 0.5)
      expect(item.right).toBeLessThanOrEqual(gridBox!.x + gridBox!.width + 0.5)
      expect(item.bottom).toBeLessThanOrEqual(gridBox!.y + gridBox!.height + 0.5)
    }
  })

  test("AC9: a rejected resize's rollback retains exactly 16px gaps", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await gotoFreshDashboard(page)
    await page.getByRole("button", { name: "Edit Layout" }).click()

    const before = await measure(page)
    const gbc = before.items.find((i) => i.id?.startsWith("growth-bar-chart"))!
    const gsHBefore = await page.locator(`[gs-id="${gbc.id}"]`).getAttribute("gs-h")

    // growth-bar-chart's GAP-2E allowedHeights is [1] only: shrinking it to
    // 0.5X (dragging the se handle up) is a real canonical capability
    // rejection, exactly as e2e/gap4c-pointer-wiring.spec.ts's own
    // "rejected resize" test already establishes for this same widget type.
    // The `.ui-resizable-se` handle is `autoHide`-styled (zero layout size
    // until the widget itself is hovered), so the widget must be hovered
    // first before the handle's own bounding box is meaningful.
    const widgetLocator = page.locator(`[gs-id="${gbc.id}"]`)
    await page.mouse.move(gbc.x + gbc.width / 2, gbc.y + gbc.height / 2)
    const handleLocator = widgetLocator.locator(".ui-resizable-se")
    await handleLocator.waitFor({ state: "visible" })
    const handle = await handleLocator.boundingBox()
    const hx = handle!.x + handle!.width / 2
    const hy = handle!.y + handle!.height / 2
    await page.mouse.move(hx, hy)
    await page.mouse.down()
    await page.mouse.move(hx, hy - 60, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(300)

    const gsHAfter = await page.locator(`[gs-id="${gbc.id}"]`).getAttribute("gs-h")
    expect(gsHAfter).toBe(gsHBefore) // the resize was rejected and rolled back

    const after = await measure(page)
    expectAll16px(after.gaps)
    evidence.postRollback = after.gaps
  })
})

test.afterAll(() => {
  const outDir = path.join(__dirname, "results")
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, "gap5a-spacing-evidence.json"), JSON.stringify(evidence, null, 2))
})
