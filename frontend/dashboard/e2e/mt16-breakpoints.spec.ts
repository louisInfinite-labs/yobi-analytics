import { test, expect, type Page } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** MT-16 AC3 correction: real per-breakpoint browser evidence against the
 * actual rendered Dashboard (`canonical-dashboard-harness.html`, mounting
 * the real `DashboardCanonicalEditor` -- see `e2e/harness/mount.tsx`).
 * Every rect below comes from Playwright's `boundingBox()`, which reads
 * real layout from the real browser engine -- `computeWidgetPixelRect`
 * (pure arithmetic) is never substituted for it.
 *
 * Viewport widths are chosen strictly inside each of `useBreakpoint.ts`'s
 * own thresholds (mobile < 768, tablet < 1024, else desktop), the same
 * breakpoint resolution `CanonicalWidgetGrid` now actually uses when
 * rendering (see `DashboardCanonicalEditor.tsx`'s MT-16 docstring).
 */

interface WidgetRect {
  widgetId: string
  x: number
  y: number
  width: number
  height: number
}

interface BreakpointEvidence {
  breakpoint: string
  viewport: { width: number; height: number }
  detectedBreakpoint: string
  widgets: WidgetRect[]
}

const BREAKPOINTS: { name: string; viewport: { width: number; height: number } }[] = [
  { name: "desktop", viewport: { width: 1280, height: 800 } },
  { name: "tablet", viewport: { width: 900, height: 800 } },
  { name: "mobile", viewport: { width: 400, height: 800 } },
]

function rectsOverlap(a: WidgetRect, b: WidgetRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

async function captureWidgetRects(page: Page): Promise<WidgetRect[]> {
  const boxes = await page.locator('[data-testid="canonical-widget-box"]').all()
  const rects: WidgetRect[] = []
  for (const box of boxes) {
    const widgetId = await box.getAttribute("data-widget-id")
    const box2 = await box.boundingBox()
    if (!widgetId || !box2) throw new Error("widget box missing id or bounding box")
    rects.push({ widgetId, x: box2.x, y: box2.y, width: box2.width, height: box2.height })
  }
  return rects
}

const evidence: BreakpointEvidence[] = []

for (const { name, viewport } of BREAKPOINTS) {
  test(`MT-16 AC3 (${name}): real rendered widget geometry, no overlap/overflow, 16px adjacent gaps`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto("/canonical-dashboard-harness.html")

    const grid = page.getByTestId("canonical-widget-grid")
    await expect(grid).toHaveAttribute("data-breakpoint", name)

    const rects = await captureWidgetRects(page)
    const gridBox = await grid.boundingBox()
    if (!gridBox) throw new Error("grid container missing bounding box")

    // 1/2. Widget IDs captured above (`rects[].widgetId`).
    expect(rects.map((r) => r.widgetId).sort()).toEqual(["a", "b", "c"])

    // 5. No overlap.
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(rectsOverlap(rects[i], rects[j])).toBe(false)
      }
    }
    // 5. No overflow past the grid container.
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(gridBox.x - 0.5)
      expect(r.y).toBeGreaterThanOrEqual(gridBox.y - 0.5)
      expect(r.x + r.width).toBeLessThanOrEqual(gridBox.x + gridBox.width + 0.5)
      expect(r.y + r.height).toBeLessThanOrEqual(gridBox.y + gridBox.height + 0.5)
    }

    // 4. Every applicable adjacent pair is exactly 16px apart. "Adjacent"
    // here is read directly off the real rendered rects (two boxes whose
    // vertical ranges overlap and sit side by side horizontally, or whose
    // horizontal ranges overlap and sit one above the other) -- not
    // inferred from the grid-unit reflow algorithm.
    let checkedPair = false
    for (let i = 0; i < rects.length; i++) {
      for (let j = 0; j < rects.length; j++) {
        if (i === j) continue
        const a = rects[i]
        const b = rects[j]
        const verticalOverlap = a.y < b.y + b.height && b.y < a.y + a.height
        const horizontalOverlap = a.x < b.x + b.width && b.x < a.x + a.width
        if (verticalOverlap && b.x > a.x && b.x - (a.x + a.width) < 32) {
          expect(Math.round(b.x - (a.x + a.width))).toBe(16)
          checkedPair = true
        }
        if (horizontalOverlap && b.y > a.y && b.y - (a.y + a.height) < 32) {
          expect(Math.round(b.y - (a.y + a.height))).toBe(16)
          checkedPair = true
        }
      }
    }
    expect(checkedPair).toBe(true)

    evidence.push({ breakpoint: name, viewport, detectedBreakpoint: (await grid.getAttribute("data-breakpoint")) ?? "", widgets: rects })
  })
}

test.afterAll(() => {
  // Machine-readable evidence, reusable by MT-17's own "browser measurement
  // output" requirement without re-running these tests.
  const outDir = path.join(__dirname, "results")
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, "mt16-ac3-breakpoint-geometry.json"), JSON.stringify(evidence, null, 2))
})
