import { test, expect, type Page } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** GAP-2C browser verification: does each real production widget component
 * fit inside the real canonical 0.5X/1X box, at desktop and tablet
 * viewports? Evidence only -- no widget/CSS/canonical-contract code is
 * changed by this file or by the harness it drives
 * (e2e/harness/mount-widget-sizing.tsx).
 */

const WIDGET_TYPES = ["kpi-summary", "growth-bar-chart", "contribution-ring", "ranking", "insights", "video-stats-table"] as const
type WidgetType = (typeof WIDGET_TYPES)[number]
const HEIGHTS = [0.5, 1] as const

const DESKTOP_VIEWPORT = { width: 1280, height: 900 }
// Representative valid tablet placement under the product's 3x3 max --
// viewport width only needs to comfortably fit one canonical column
// (320px) plus chrome; the canonical pixel-per-grid-unit config itself is
// not breakpoint-conditional in the current renderer (verified below), so
// this viewport's only job is to prove that fact holds at a realistic
// tablet width, not to pick a different column width.
const TABLET_VIEWPORT = { width: 820, height: 1180 }

interface OverflowMeasurement {
  boxWidth: number
  boxHeight: number
  /** `.widget-shell__body`'s own box -- must always equal the probe box
   * (it's `height:100%` inside it); confirms content never visually escapes
   * the canonical box, because `.widget-shell__body`'s `overflow: auto`
   * (dashboard.css, the real production wrapper `DashboardGrid.tsx` already
   * uses) contains it instead. */
  contentBoxEscapesProbeBox: boolean
  /** The real signal once `overflow: auto` is in effect: does the content
   * need scrolling to be fully seen? */
  scrollHeight: number
  clientHeight: number
  needsInternalScroll: boolean
}

async function measureOverflow(page: Page, widgetType: WidgetType, heightUnits: 0.5 | 1): Promise<OverflowMeasurement> {
  const probe = page.getByTestId(`widget-probe-${widgetType}-${heightUnits}`)
  const box = await probe.boundingBox()
  if (!box) throw new Error(`probe box missing for ${widgetType} ${heightUnits}`)

  const content = page.getByTestId(`widget-content-${widgetType}-${heightUnits}`)
  const contentBox = await content.boundingBox()
  if (!contentBox) throw new Error(`content box missing for ${widgetType} ${heightUnits}`)

  const scroll = await content.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }))

  const boxBottom = box.y + box.height
  const boxRight = box.x + box.width
  const contentBottom = contentBox.y + contentBox.height
  const contentRight = contentBox.x + contentBox.width
  const contentBoxEscapesProbeBox = contentBottom > boxBottom + 1 || contentRight > boxRight + 1

  return {
    boxWidth: box.width,
    boxHeight: box.height,
    contentBoxEscapesProbeBox,
    scrollHeight: scroll.scrollHeight,
    clientHeight: scroll.clientHeight,
    needsInternalScroll: scroll.scrollHeight > scroll.clientHeight + 1,
  }
}

interface Evidence {
  widgetType: WidgetType
  breakpoint: "desktop" | "tablet"
  heightUnits: 0.5 | 1
  measurement: OverflowMeasurement
  chartHasNonZeroArea: boolean | null
  chartFullyVisibleWithoutScroll: boolean | null
  scrollRegion: { present: boolean; scrollable: boolean } | null
  controlsVisibleWithoutScroll: boolean | null
}

/** Is `selector` (queried inside the box identified by `contentTestId`)
 * entirely within that box's visible, unscrolled viewport? */
async function isWithinVisibleArea(page: Page, contentTestId: string, selector: string): Promise<boolean> {
  return page.evaluate(
    ({ contentTestId, selector }) => {
      const content = document.querySelector(`[data-testid="${contentTestId}"]`)
      const target = content?.querySelector(selector)
      if (!content || !target) return false
      const contentRect = content.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      return targetRect.top >= contentRect.top - 1 && targetRect.bottom <= contentRect.bottom + 1
    },
    { contentTestId, selector },
  )
}

const evidence: Evidence[] = []

async function gotoHarness(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport)
  await page.goto("/widget-sizing-harness.html")
  await page.waitForSelector('[data-testid="sanity-grid"]')
}

test.describe("GAP-2C: canonical geometry sanity check (real CanonicalWidgetGrid, no override)", () => {
  test("computeWidgetPixelRect's predicted 1X/0.5X heights match the real rendered CanonicalWidgetGrid boxes", async ({ page }) => {
    await gotoHarness(page, DESKTOP_VIEWPORT)

    const boxes = await page.locator('[data-testid="sanity-grid"] [data-testid="canonical-widget-box"]').all()
    const rectsById: Record<string, { x: number; y: number; width: number; height: number }> = {}
    for (const box of boxes) {
      const id = await box.getAttribute("data-widget-id")
      const rect = await box.boundingBox()
      if (id && rect) rectsById[id] = rect
    }

    // Production default GridPixelConfig is {columnWidthPx:320, rowHeightPx:240};
    // computeWidgetPixelRect's own edge contribution is 8px per side.
    expect(Math.round(rectsById["sanity-1x"].height)).toBe(1 * 240 - 8 - 8) // 224
    expect(Math.round(rectsById["sanity-05x-a"].height)).toBe(0.5 * 240 - 8 - 8) // 104
    expect(Math.round(rectsById["sanity-05x-b"].height)).toBe(0.5 * 240 - 8 - 8) // 104

    writeFileSync(
      path.join((() => {
        const dir = path.join(__dirname, "results")
        mkdirSync(dir, { recursive: true })
        return dir
      })(), "gap2c-geometry-sanity.json"),
      JSON.stringify({ measured1XHeight: rectsById["sanity-1x"].height, measured05XHeight: rectsById["sanity-05x-a"].height }, null, 2),
    )
  })
})

for (const breakpoint of ["desktop", "tablet"] as const) {
  const viewport = breakpoint === "desktop" ? DESKTOP_VIEWPORT : TABLET_VIEWPORT

  test.describe(`GAP-2C widget sizing (${breakpoint})`, () => {
    for (const widgetType of WIDGET_TYPES) {
      for (const heightUnits of HEIGHTS) {
        test(`${widgetType} at ${heightUnits}X`, async ({ page }) => {
          await gotoHarness(page, viewport)

          const measurement = await measureOverflow(page, widgetType, heightUnits)

          let chartHasNonZeroArea: boolean | null = null
          // Precise, per-element signal: is the chart's own <svg> -- not
          // just "the content block" -- entirely within the box's visible
          // (unscrolled) viewport? A cut-off bar chart or ring is unreadable
          // even though scrolling is otherwise a fine UX for list content.
          let chartFullyVisibleWithoutScroll: boolean | null = null
          if (widgetType === "growth-bar-chart" || widgetType === "contribution-ring") {
            const contentTestId = `widget-content-${widgetType}-${heightUnits}`
            const svg = page.getByTestId(contentTestId).locator("svg").first()
            // GAP-2C1 correction: a short explicit timeout, not the 30s
            // default. If a future regression again makes the chart never
            // render at some geometry, this fails fast as `chartHasNonZeroArea:
            // false` instead of racing the whole test's own timeout and
            // tearing down the page mid-evaluation (the exact failure mode
            // this correction fixes at the production-code level).
            const svgBox = await svg.boundingBox({ timeout: 5000 }).catch(() => null)
            chartHasNonZeroArea = !!svgBox && svgBox.width > 0 && svgBox.height > 0
            chartFullyVisibleWithoutScroll = await page.evaluate(
              ({ testId }) => {
                const content = document.querySelector(`[data-testid="${testId}"]`)
                const svgEl = content?.querySelector("svg")
                if (!content || !svgEl) return false
                const contentRect = content.getBoundingClientRect()
                const svgRect = svgEl.getBoundingClientRect()
                return svgRect.top >= contentRect.top - 1 && svgRect.bottom <= contentRect.bottom + 1
              },
              { testId: contentTestId },
            )
          }

          let scrollRegion: { present: boolean; scrollable: boolean } | null = null
          if (widgetType === "video-stats-table") {
            // `.table-scroll` (dashboard.css) is `overflow-x: auto` only --
            // a horizontal scroll wrapper for wide tables, not a vertical
            // row-scroll region. Vertical overflow (too many rows/controls
            // for the box) is handled by the outer `.widget-shell__body`
            // wrapper instead (already captured in `measurement` above).
            const scrollEl = page.getByTestId(`widget-content-${widgetType}-${heightUnits}`).locator(".table-scroll").first()
            const present = (await scrollEl.count()) > 0
            const scrollable = present
              ? await scrollEl.evaluate((el) => el.scrollWidth > el.clientWidth + 1)
              : false
            scrollRegion = { present, scrollable }
          }

          // Are the widget's own primary controls (search input for the
          // table, the ranking-type tab group) within the visible,
          // unscrolled area -- or does even reaching them require scrolling
          // first?
          let controlsVisibleWithoutScroll: boolean | null = null
          const contentTestId = `widget-content-${widgetType}-${heightUnits}`
          if (widgetType === "video-stats-table") {
            controlsVisibleWithoutScroll = await isWithinVisibleArea(page, contentTestId, 'input[aria-label="Search video statistics"]')
          } else if (widgetType === "ranking") {
            controlsVisibleWithoutScroll = await isWithinVisibleArea(page, contentTestId, '[aria-label="Ranking type"]')
          }

          evidence.push({
            widgetType,
            breakpoint,
            heightUnits,
            measurement,
            chartHasNonZeroArea,
            chartFullyVisibleWithoutScroll,
            scrollRegion,
            controlsVisibleWithoutScroll,
          })

          // No hard pass/fail assertion here -- this is evidence gathering.
          // Classification happens from the collected evidence, per the task.
          expect(measurement.boxHeight).toBeGreaterThan(0)
        })
      }
    }
  })
}

test.afterAll(async () => {
  const outDir = path.join(__dirname, "results")
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, "gap2c-widget-sizing-evidence.json"), JSON.stringify(evidence, null, 2))
})
