import type { Page } from "@playwright/test"

/** Polls the Dashboard's own rendered widget geometry until two consecutive
 * reads are identical, so a test's first real interaction (a click, a
 * bounding-box measurement) never races `DashboardPage.tsx`'s own
 * ResizeObserver-driven readable-column-cap calculation (see that
 * component's own comment on `gridContentWidth`/`computeReadableColumnCap`):
 * its first callback only fires asynchronously after mount, using a static
 * fallback cap until then, so a widget/insertion-preview computed on the
 * very first paint can still reflow (or become enabled) once more a moment
 * later. Waiting for page content (e.g. "Daily Gain") to be visible only
 * proves data loaded, not that this geometry has already settled -- every
 * caller of this helper already treats geometry as significant (bounding
 * boxes, column counts, Insert-here enablement), so a settled reading is
 * the correctness precondition their own assertions already assume. */
export async function waitForStableDashboardGeometry(page: Page, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 3000
  const intervalMs = options.intervalMs ?? 100
  const deadline = Date.now() + timeoutMs

  async function snapshot(): Promise<string> {
    return page.evaluate(() => {
      const items = [...document.querySelectorAll<HTMLElement>(".widget-shell")]
        .map((el) => {
          const r = el.getBoundingClientRect()
          const parent = el.closest("[gs-id]")
          return { id: parent?.getAttribute("gs-id") ?? null, x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
        })
        .sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""))
      return JSON.stringify(items)
    })
  }

  let previous = await snapshot()
  while (Date.now() < deadline) {
    await page.waitForTimeout(intervalMs)
    const current = await snapshot()
    if (current === previous && current !== "[]") return
    previous = current
  }
  // Reaching the deadline without two consecutive identical (non-empty)
  // snapshots means geometry never actually settled -- resolving
  // successfully here anyway would defeat this helper's whole purpose: every
  // caller awaits it specifically so their own geometry assertions never
  // race the ResizeObserver-driven reflow described above, and a caller that
  // proceeds against still-unsettled geometry would misattribute genuine
  // instability to whatever it asserts next instead of to this timeout.
  throw new Error(`Dashboard geometry did not stabilize within ${timeoutMs}ms`)
}
