import { test, expect, type Page, type Locator } from "@playwright/test"

/** GAP-4C "Live Canonical State Cutover + GridStack Pointer Wiring" browser
 * evidence. Drives the real production DashboardGrid.tsx (real GridStack,
 * real dragstop/resizestop listeners, real GAP-4A adapter) through
 * e2e/harness/mount-gap4c-grid.tsx (gap4c-grid-harness.html) -- the same
 * "no App.tsx routing change needed" Vite multi-entry harness convention
 * gap2c-widget-sizing.spec.ts / mount-widget-sizing.tsx already established.
 *
 * GridStack's own drag-and-drop (dd-draggable.js) only starts a drag once
 * `_mouseMove` sees at least 3px of combined x+y movement past the initial
 * `mousedown` -- a single instantaneous jump is not enough. Every gesture
 * below is therefore driven with explicit low-level `page.mouse`
 * down/move/move/up steps (several intermediate moves), not a single
 * synthetic drag helper.
 */

interface CanonicalWidget {
  widgetId: string
  widgetType: string
  x: number
  y: number
  width: number
  height: number
}
interface CanonicalState {
  grid: { columns: number; rows: number }
  widgets: CanonicalWidget[]
}

async function readCanonicalState(page: Page): Promise<CanonicalState> {
  const text = await page.getByTestId("canonical-json").textContent()
  return JSON.parse(text ?? "{}")
}

function widgetBox(page: Page, widgetId: string): Locator {
  return page.locator(`[gs-id="${widgetId}"]`)
}

/** Moves `widgetId` by `columns` full grid columns (negative = left) via a
 * real low-level pointer sequence. The delta is computed from the widget's
 * own current box width (plus a safety margin) rather than a fixed pixel
 * guess, since GridStack only commits a new cell once the cursor has
 * crossed comfortably past the next cell's boundary -- a fixed small pixel
 * offset can land back in the same cell once resolved to a grid column. A
 * short pause after `mousedown` (matching this GridStack version's own
 * drag-start handling, confirmed by direct inspection) and several
 * intermediate `mousemove` steps are both required for `_mouseMove`'s
 * distance-threshold check to actually start the drag. */
async function dragWidgetByColumns(page: Page, widgetId: string, columns: number) {
  const box = await widgetBox(page, widgetId).boundingBox()
  if (!box) throw new Error(`widget box missing for ${widgetId}`)
  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2
  const endX = startX + (box.width + 20) * columns
  const endY = startY

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.waitForTimeout(50)
  const steps = 12
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(startX + ((endX - startX) * i) / steps, startY + ((endY - startY) * i) / steps)
    await page.waitForTimeout(15)
  }
  await page.mouse.up()
}

/** GridStack's `se` resize handle is styled `autohide`: it has zero layout
 * size (confirmed by direct inspection) until the widget is actually
 * hovered, at which point it becomes a real, positioned, rotated square.
 * Starting a resize gesture therefore requires hovering the widget first
 * and then locating that handle's own bounding box -- computing a corner
 * point from the widget's own box (as `dragWidgetByColumns` does for a
 * drag) lands just outside the handle's real hit area and silently misses
 * it entirely. */
async function seHandleCenter(page: Page, widgetId: string): Promise<{ x: number; y: number }> {
  const widget = widgetBox(page, widgetId)
  const box = await widget.boundingBox()
  if (!box) throw new Error(`widget box missing for ${widgetId}`)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  const handle = widget.locator(".ui-resizable-se")
  await handle.waitFor({ state: "visible" })
  const handleBox = await handle.boundingBox()
  if (!handleBox) throw new Error(`resize handle box missing for ${widgetId}`)
  return { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 }
}

/** Grows/shrinks `widgetId` by `columns` full grid columns from its `se`
 * (bottom-right) resize handle -- the only handle this production
 * configuration exposes (GridStack's own default `resizable.handles`, never
 * overridden by DashboardGrid.tsx), so no gesture here ever moves the
 * top-left anchor. See `dragWidgetByColumns` for why the delta is
 * box-relative and why the down/wait/move-steps shape is required. */
async function resizeWidgetByColumns(page: Page, widgetId: string, columns: number) {
  const box = await widgetBox(page, widgetId).boundingBox()
  if (!box) throw new Error(`widget box missing for ${widgetId}`)
  const { x: startX, y: startY } = await seHandleCenter(page, widgetId)
  const endX = startX + (box.width + 20) * columns
  const endY = startY

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.waitForTimeout(50)
  const steps = 12
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(startX + ((endX - startX) * i) / steps, startY + ((endY - startY) * i) / steps)
    await page.waitForTimeout(15)
  }
  await page.mouse.up()
}

/** Shrinks `widgetId`'s height by `rows` canonical row-units (0.5X each)
 * from the `se` handle -- box-relative for the same reason
 * `dragWidgetByColumns` is. */
async function resizeWidgetHeightByRows(page: Page, widgetId: string, rows: number) {
  const box = await widgetBox(page, widgetId).boundingBox()
  if (!box) throw new Error(`widget box missing for ${widgetId}`)
  const { x: startX, y: startY } = await seHandleCenter(page, widgetId)
  const endX = startX
  const endY = startY + (box.height / 2 + 20) * rows // box.height spans 2 GridStack rows (1X) here

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.waitForTimeout(50)
  const steps = 12
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(startX + ((endX - startX) * i) / steps, startY + ((endY - startY) * i) / steps)
    await page.waitForTimeout(15)
  }
  await page.mouse.up()
}

test.describe("GAP-4C GridStack pointer wiring", () => {
  test("valid drag: dragstop commits canonical x/y through updateDraftWidget (AC7, AC9, AC14)", async ({ page }) => {
    await page.goto("/gap4c-grid-harness.html?fixture=spare-capacity")
    const before = await readCanonicalState(page)
    const a = before.widgets.find((w) => w.widgetId === "a")!
    expect(a.x).toBe(0)

    await dragWidgetByColumns(page, "a", 2)

    await expect
      .poll(async () => {
        const state = await readCanonicalState(page)
        return state.widgets.find((w) => w.widgetId === "a")?.x
      })
      .not.toBe(0)

    const after = await readCanonicalState(page)
    const movedA = after.widgets.find((w) => w.widgetId === "a")!
    // widgetId preserved (AC14), width/height untouched by a pure drag.
    expect(movedA.widgetId).toBe("a")
    expect(movedA.width).toBe(1)
    expect(movedA.height).toBe(1)
    expect(movedA.y).toBe(0)

    // Visual GridStack attributes match the new canonical geometry.
    await expect(widgetBox(page, "a")).toHaveAttribute("gs-x", String(movedA.x))
    await expect(widgetBox(page, "a")).toHaveAttribute("gs-y", "0")

    // Neighbor "b" untouched canonically and visually (AC13's baseline: a
    // resync after every gesture always reflects only-the-manipulated-widget
    // having actually changed).
    const b = after.widgets.find((w) => w.widgetId === "b")!
    expect(b).toEqual(before.widgets.find((w) => w.widgetId === "b"))
    await expect(widgetBox(page, "b")).toHaveAttribute("gs-x", "1")
  })

  test("valid resize: resizestop commits canonical width through updateDraftWidget (AC8, AC9, AC14)", async ({ page }) => {
    await page.goto("/gap4c-grid-harness.html?fixture=resize-spare-capacity")
    const before = await readCanonicalState(page)
    expect(before.widgets.find((w) => w.widgetId === "a")!.width).toBe(1)

    // Grow "a" from the se handle into the spare third column.
    await resizeWidgetByColumns(page, "a", 2)

    await expect
      .poll(async () => {
        const state = await readCanonicalState(page)
        return state.widgets.find((w) => w.widgetId === "a")?.width
      })
      .toBeGreaterThan(1)

    const after = await readCanonicalState(page)
    const resizedA = after.widgets.find((w) => w.widgetId === "a")!
    expect(resizedA.widgetId).toBe("a")
    expect(resizedA.x).toBe(0)
    expect(resizedA.y).toBe(0)
    expect(resizedA.height).toBe(1)
    await expect(widgetBox(page, "a")).toHaveAttribute("gs-w", String(resizedA.width))
  })

  test("rejected resize (GAP-2E capability): visual geometry rolls back and canonical draft is unchanged (AC11, AC12, AC14)", async ({
    page,
  }) => {
    await page.goto("/gap4c-grid-harness.html?fixture=capability-reject")
    const before = await readCanonicalState(page)
    const chartBefore = before.widgets.find((w) => w.widgetId === "chart")!
    expect(chartBefore.height).toBe(1) // growth-bar-chart only allows 1X (GAP-2E)
    const beforeGsH = await widgetBox(page, "chart").getAttribute("gs-h")

    // Shrink "chart" height toward 0.5X -- GridStack's own resize handle
    // permits this (no GridStack-level minH conflict at this size, since
    // GAP-4C's minGridStackHeightForAllowedHeights derives minH from
    // growth-bar-chart's own allowedHeights, [1] -- a floor of 2 rows, not
    // reachable *below*); only canonical GAP-2E capability enforcement
    // rejects a *shrink* attempt, since GridStack has no minH concept for
    // "this specific type never allows 0.5X" as a rule of its own.
    await resizeWidgetHeightByRows(page, "chart", -1)

    // Give the rejection's synchronous rollback (grid.load in
    // syncGridToCurrentWidgets) a moment, then assert it actually happened:
    // no repeated-rejection loop, no lingering rejected geometry.
    await page.waitForTimeout(300)

    const after = await readCanonicalState(page)
    expect(after).toEqual(before) // canonical draft fully unchanged
    const afterGsH = await widgetBox(page, "chart").getAttribute("gs-h")
    expect(afterGsH).toBe(beforeGsH) // GridStack visual geometry restored
    expect(after.widgets.find((w) => w.widgetId === "chart")!.widgetId).toBe("chart")
  })

  test("rejected drag (INCOMPLETE_COLUMN): dragging one of a stacked 0.5X pair away is rejected and rolls back (AC10, AC11, AC13, AC14)", async ({
    page,
  }) => {
    await page.goto("/gap4c-grid-harness.html?fixture=incomplete-column-reject")
    const before = await readCanonicalState(page)
    const topBefore = before.widgets.find((w) => w.widgetId === "top")!
    expect(topBefore.x).toBe(0)

    // Drag "top" into the empty third column, which GridStack's own
    // collision engine allows (no overlap) but which would leave "bottom"
    // as an unresolvable lone 0.5X widget -- an INCOMPLETE_COLUMN rejection
    // GridStack itself has no concept of.
    await dragWidgetByColumns(page, "top", 2)
    await page.waitForTimeout(300)

    const after = await readCanonicalState(page)
    expect(after).toEqual(before) // canonical draft fully unchanged, including "bottom" and "filler"
    expect(after.widgets.find((w) => w.widgetId === "top")!.widgetId).toBe("top")
    await expect(widgetBox(page, "top")).toHaveAttribute("gs-x", "0")
    // "bottom" (never the manipulated widget) also confirmed at its
    // original canonical position -- the full resync this rejection path
    // triggers reloads every widget, not only the one that was dragged.
    await expect(widgetBox(page, "bottom")).toHaveAttribute("gs-x", "0")
    await expect(widgetBox(page, "bottom")).toHaveAttribute("gs-y", "1")
  })

  test("position swap (Manual Layout Correction Pass, Defect B): dragging 'a' fully onto 'b's same-footprint cell swaps them both, submitted atomically", async ({
    page,
  }) => {
    await page.goto("/gap4c-grid-harness.html?fixture=collision-neighbor-push")
    const before = await readCanonicalState(page)
    const bBefore = before.widgets.find((w) => w.widgetId === "b")!
    expect(bBefore).toEqual({ widgetId: "b", widgetType: "ranking", x: 1, y: 0, width: 1, height: 1 })

    const boxA = await widgetBox(page, "a").boundingBox()
    if (!boxA) throw new Error("widget box missing for a")
    const startX = boxA.x + boxA.width / 2
    const startY = boxA.y + boxA.height / 2
    // 0.9 of a's own cell width: enough to cross fully into "b"'s cell
    // (this fixture has no spare column), not enough to overshoot past it.
    const endX = startX + boxA.width * 0.9

    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.waitForTimeout(50)
    const steps = 15
    let sawNeighborDisplacement = false
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(startX + ((endX - startX) * i) / steps, startY)
      await page.waitForTimeout(20)
      // GridStack's own float:true collision resolution (gridstack-engine.js's
      // _fixCollisions -> moveNode(collide, {y: nn.y + nn.h, ...})) pushes "b"
      // down mid-drag, purely as a side effect of GridStack's own engine --
      // "b" was never the widget the user is manipulating.
      const bGsY = await widgetBox(page, "b").getAttribute("gs-y")
      if (bGsY !== null && bGsY !== "0") sawNeighborDisplacement = true
      // Canonical state must never reflect this mid-gesture GridStack-only
      // displacement -- dragstop/resizestop (the only commit path) has not
      // fired yet, and even once it does, only "a"'s own final geometry is
      // ever submitted (see DashboardGrid.tsx's handleGestureEnd).
      const midState = await readCanonicalState(page)
      expect(midState.widgets.find((w) => w.widgetId === "b")).toEqual(bBefore)
    }
    expect(sawNeighborDisplacement).toBe(true) // the displacement this AC is about is real and reproducible

    await page.mouse.up()
    await page.waitForTimeout(300)

    const after = await readCanonicalState(page)
    // "a" landed in "b"'s old cell, and the canonical `updateWidgetGeometry`
    // swap path (dashboardWidgetActions.ts's tryPositionSwap) atomically
    // moved "b" into "a"'s old cell in the same commit -- both submitted
    // together, not "a" alone with "b" untouched.
    expect(after.widgets.find((w) => w.widgetId === "a")).toMatchObject({ x: 1, y: 0 })
    expect(after.widgets.find((w) => w.widgetId === "b")).toMatchObject({ x: 0, y: 0 })
    // GridStack's visual nodes resync to that same swapped canonical state.
    await expect(widgetBox(page, "a")).toHaveAttribute("gs-x", "1")
    await expect(widgetBox(page, "b")).toHaveAttribute("gs-x", "0")
    await expect(widgetBox(page, "b")).toHaveAttribute("gs-y", "0")
  })

  test("cancel after a valid pointer edit (GAP-4C Correction Pass AC15): restores pre-edit canonical geometry and GridStack visual state", async ({
    page,
  }) => {
    await page.goto("/gap4c-grid-harness.html?fixture=spare-capacity")
    const before = await readCanonicalState(page)
    const aBefore = before.widgets.find((w) => w.widgetId === "a")!
    expect(aBefore.x).toBe(0)

    await dragWidgetByColumns(page, "a", 2)
    await expect
      .poll(async () => {
        const state = await readCanonicalState(page)
        return state.widgets.find((w) => w.widgetId === "a")?.x
      })
      .not.toBe(0) // the draft actually changed -- otherwise Cancel would trivially "pass"

    await page.getByTestId("harness-cancel").click()

    const after = await readCanonicalState(page)
    expect(after).toEqual(before) // full pre-edit canonical snapshot restored, not just widget "a"
    const restoredA = after.widgets.find((w) => w.widgetId === "a")!
    expect(restoredA.widgetId).toBe("a") // widgetId unchanged across the whole edit-then-cancel cycle

    // GridStack visual state matches the restored (original) canonical projection.
    await expect(widgetBox(page, "a")).toHaveAttribute("gs-x", "0")
    await expect(widgetBox(page, "a")).toHaveAttribute("gs-y", "0")
  })
})
