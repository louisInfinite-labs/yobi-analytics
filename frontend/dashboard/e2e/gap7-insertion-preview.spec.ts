import { test, expect, type Page } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** GAP-7 "Production Insertion Preview + Widget-Sized Placeholder" browser
 * evidence, against the real production `/dashboard` route (never a
 * harness). Every measurement waits for GridStack's own position/size CSS
 * transitions to settle first (`settled`), since a preview changes the
 * column count and every node animates to its new box.
 */

const STORAGE_KEY = "yobi-analytics-canonical-dashboard-layout"
const DESKTOP = { width: 1280, height: 1500 }

interface Rect {
  id: string | null
  x: number
  y: number
  width: number
  height: number
  right: number
  bottom: number
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

/** Absolute (viewport) border-boxes of every widget shell. */
async function measureOnce(page: Page): Promise<Rect[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".widget-shell")].map((el) => {
      const r = el.getBoundingClientRect()
      return { id: el.closest("[gs-id]")?.getAttribute("gs-id") ?? null, x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
    }),
  )
}

/** Re-measures until two consecutive reads (150ms apart) are identical. */
async function settled(page: Page): Promise<Rect[]> {
  let previous = JSON.stringify(await measureOnce(page))
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(150)
    const current = JSON.stringify(await measureOnce(page))
    if (current === previous) return JSON.parse(current)
    previous = current
  }
  throw new Error("layout never settled")
}

function adjacentGaps(items: Rect[]) {
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

async function startAdd(page: Page) {
  await page.getByRole("button", { name: "Edit Layout" }).click()
  await page.locator(".widget-tray").getByRole("button", { name: /KPI Summary/ }).click()
}

const slot = (page: Page, index: number) => page.getByTestId("widget-insertion-row-0").getByRole("button").nth(index)
const panelCancel = (page: Page) => page.getByTestId("widget-insertion-slots").getByRole("button", { name: "Cancel" })
const readStorage = (page: Page) => page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)

/** gs attributes of the placeholder's node. */
async function placeholderNode(page: Page) {
  const shell = page.getByTestId("insertion-placeholder")
  const node = shell.locator("xpath=ancestor::*[@gs-id][1]")
  return {
    id: await node.getAttribute("gs-id"),
    x: await node.getAttribute("gs-x"),
    y: await node.getAttribute("gs-y"),
    // GridStack omits `gs-w` entirely for its default width of 1.
    w: (await node.getAttribute("gs-w")) ?? "1",
    h: await node.getAttribute("gs-h"),
  }
}

/** widget type prefixes of the widgets in canonical row 0, left to right. */
async function rowZeroOrder(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[gs-id]")]
      .filter((el) => el.getAttribute("gs-y") === "0")
      .sort((a, b) => Number(a.getAttribute("gs-x")) - Number(b.getAttribute("gs-x")))
      .map((el) => el.getAttribute("gs-id")!),
  )
}

test.describe("GAP-7: live insertion preview + widget-sized placeholder", () => {
  test("AC1-AC5/AC14/AC15/AC26/AC27: middle preview shows A | candidate | B, marks the slot, keeps 16px gaps, changes no draft", async ({ page }) => {
    await freshDashboard(page, DESKTOP)
    const storageBefore = await readStorage(page)
    await startAdd(page)
    // AC1: selecting a type alone previews nothing.
    await expect(page.getByTestId("insertion-placeholder")).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Insert here" })).toBeDisabled()

    await slot(page, 1).click() // between KPI Summary and Growth Bar Chart
    const rects = await settled(page)

    const node = await placeholderNode(page)
    expect(node).toMatchObject({ x: "1", y: "0", w: "1", h: "2" })
    const order = await rowZeroOrder(page)
    expect(order[0]).toMatch(/^kpi-summary-/)
    expect(order[1]).toBe(node.id)
    expect(order[2]).toMatch(/^growth-bar-chart-/)
    // AC4: the entire affected layout is the preview -- 3 columns, other row untouched.
    const rowOne = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("[gs-id]")]
        .filter((el) => el.getAttribute("gs-y") === "2")
        .map((el) => `${el.getAttribute("gs-x")}:${el.getAttribute("gs-w") ?? "1"}`)
        .sort(),
    )
    expect(rowOne).toEqual(["0:1", "1:1"])
    // AC14: every adjacent gap, placeholder included, is 16px.
    const gaps = adjacentGaps(rects)
    expect(gaps.length).toBeGreaterThan(0)
    for (const gap of gaps) expect(gap).toBe(16)
    // AC15: no previewed widget renders below the minimum readable width.
    for (const rect of rects) expect(rect.width).toBeGreaterThanOrEqual(240)
    // AC26/AC27: semantic + non-color active state, and the pending-change status.
    await expect(slot(page, 1)).toHaveAttribute("aria-pressed", "true")
    await expect(slot(page, 1)).toHaveText("✓")
    await expect(slot(page, 0)).toHaveAttribute("aria-pressed", "false")
    await expect(page.getByTestId("widget-insertion-preview-status")).toHaveText(
      "Previewing KPI Summary at position 2 in row 1; grid becomes 3 columns.",
    )
    // The placeholder is preview-only decoration: dashed outline, hidden from AT, no Remove.
    const placeholder = page.getByTestId("insertion-placeholder")
    expect(await placeholder.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("dashed")
    await expect(placeholder).toHaveAttribute("aria-hidden", "true")
    await expect(placeholder.getByRole("button")).toHaveCount(0)
    // AC2/AC25: nothing was written anywhere.
    expect(await readStorage(page)).toBe(storageBefore)
    await expect(page.getByTestId("dashboard-editor-announcer")).toHaveText("")
  })

  test("AC6/AC7/AC3: right preview puts the candidate at the row edge; a different slot recomputes from the unchanged draft with the same candidate id", async ({
    page,
  }) => {
    await freshDashboard(page, DESKTOP)
    await startAdd(page)
    await slot(page, 1).click()
    await settled(page)
    const middle = await placeholderNode(page)

    await slot(page, 2).click() // after Growth Bar Chart
    const rects = await settled(page)
    const right = await placeholderNode(page)

    await expect(page.getByTestId("insertion-placeholder")).toHaveCount(1) // replaced, not stacked
    expect(right).toMatchObject({ x: "2", y: "0", w: "1", h: "2" })
    expect(right.id).toBe(middle.id) // AC3: one candidate id for the whole session
    const order = await rowZeroOrder(page)
    expect(order[0]).toMatch(/^kpi-summary-/)
    expect(order[1]).toMatch(/^growth-bar-chart-/)
    expect(order[2]).toBe(right.id)
    for (const gap of adjacentGaps(rects)) expect(gap).toBe(16)
    await expect(slot(page, 1)).toHaveAttribute("aria-pressed", "false")
    await expect(slot(page, 2)).toHaveAttribute("aria-pressed", "true")
  })

  test("AC9/AC10/AC25: panel Cancel and Dashboard Cancel both roll back to the exact pre-preview state", async ({ page }) => {
    await freshDashboard(page, DESKTOP)
    const storageBefore = await readStorage(page)
    await startAdd(page)
    const before = await settled(page)

    await slot(page, 1).click()
    await settled(page)
    await expect(page.getByTestId("insertion-placeholder")).toHaveCount(1)
    await panelCancel(page).click()
    const afterPanelCancel = await settled(page)

    await expect(page.getByTestId("insertion-placeholder")).toHaveCount(0)
    await expect(page.getByTestId("widget-insertion-slots")).toHaveCount(0)
    expect(afterPanelCancel.map((r) => r.id)).toEqual(before.map((r) => r.id))
    for (const [index, rect] of afterPanelCancel.entries()) {
      expect(rect.x).toBeCloseTo(before[index].x, 1)
      expect(rect.y).toBeCloseTo(before[index].y, 1)
      expect(rect.width).toBeCloseTo(before[index].width, 1)
      expect(rect.height).toBeCloseTo(before[index].height, 1)
    }
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled() // draft is still clean
    expect(await readStorage(page)).toBe(storageBefore)

    // AC10: Dashboard Cancel while a preview is showing.
    await page.locator(".widget-tray").getByRole("button", { name: /KPI Summary/ }).click()
    await slot(page, 2).click()
    await settled(page)
    await page.getByRole("toolbar").getByRole("button", { name: "Cancel" }).click()
    await expect(page.getByTestId("insertion-placeholder")).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Edit Layout" })).toBeVisible()
    const viewMode = await settled(page)
    expect(viewMode).toHaveLength(4)
    expect(await readStorage(page)).toBe(storageBefore)
    await page.getByRole("button", { name: "Edit Layout" }).click()
    await expect(page.getByTestId("widget-insertion-slots")).toHaveCount(0) // pending selection did not survive
    await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(4)
  })

  test("AC8/AC24: an invalid slot creates no preview, shows the rejection alert, changes nothing and announces no success", async ({ page }) => {
    await freshDashboard(page, DESKTOP)
    await startAdd(page)
    // Grow row 0 to the 3-column maximum (preview, then commit).
    await slot(page, 0).click()
    await page.getByRole("button", { name: "Insert here" }).click()
    await page.locator(".widget-tray").getByRole("button", { name: /KPI Summary/ }).click()
    await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(5)
    const announcerBefore = await page.getByTestId("dashboard-editor-announcer").textContent()
    const layoutBefore = await settled(page)

    await slot(page, 0).click() // a 4th widget in the row cannot fit
    await expect(page.getByTestId("widget-insertion-rejected")).toBeVisible()
    await expect(page.getByTestId("insertion-placeholder")).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Insert here" })).toBeDisabled()
    await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(5)
    expect(await settled(page)).toEqual(layoutBefore)
    await expect(page.getByTestId("dashboard-editor-announcer")).toHaveText(announcerBefore ?? "")
  })

  test("AC11/AC12/AC13/AC22/AC23: Insert here commits the same widgetId at identical coordinates and an identical border-box, announcing once", async ({
    page,
  }) => {
    await freshDashboard(page, DESKTOP)
    await startAdd(page)
    await slot(page, 1).click()
    const previewRects = await settled(page)
    const previewNode = await placeholderNode(page)
    const previewRect = previewRects.find((rect) => rect.id === previewNode.id)!

    await page.getByRole("button", { name: "Insert here" }).click()
    const committedRects = await settled(page)

    await expect(page.getByTestId("insertion-placeholder")).toHaveCount(0)
    await expect(page.getByTestId("widget-insertion-slots")).toHaveCount(0)
    const node = page.locator(`[gs-id="${previewNode.id}"]`)
    await expect(node).toHaveCount(1) // same widgetId, not a second one
    expect({
      x: await node.getAttribute("gs-x"),
      y: await node.getAttribute("gs-y"),
      w: (await node.getAttribute("gs-w")) ?? "1",
      h: await node.getAttribute("gs-h"),
    }).toEqual({ x: previewNode.x, y: previewNode.y, w: previewNode.w, h: previewNode.h })
    const committedRect = committedRects.find((rect) => rect.id === previewNode.id)!
    expect(committedRect).toEqual(previewRect) // AC13: byte-identical absolute getBoundingClientRect
    const delta = {
      x: committedRect.x - previewRect.x,
      y: committedRect.y - previewRect.y,
      width: committedRect.width - previewRect.width,
      height: committedRect.height - previewRect.height,
    }
    expect(delta).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    const outDir = path.join(__dirname, "results")
    mkdirSync(outDir, { recursive: true })
    writeFileSync(
      path.join(outDir, "gap7a-rect-parity-evidence.json"),
      JSON.stringify(
        {
          widgetId: previewNode.id,
          gsGeometry: { x: previewNode.x, y: previewNode.y, w: previewNode.w, h: previewNode.h },
          placeholderRectBeforeCommit: previewRect,
          committedRectAfterCommit: committedRect,
          delta,
          adjacentGapsAfterCommit: adjacentGaps(committedRects),
        },
        null,
        2,
      ),
    )
    // Every other widget's box is also unchanged by the commit (preview == result).
    expect(committedRects).toEqual(previewRects)
    await expect(node.getByRole("button", { name: "Remove KPI Summary" })).toBeVisible() // now a real widget
    await expect(page.getByRole("button", { name: /Remove KPI Summary/ })).toHaveCount(2)
    await expect(page.getByTestId("dashboard-editor-announcer")).toHaveText("KPI Summary added at position 2 in row 1.")
    await expect(page.getByRole("button", { name: "Save" })).toBeEnabled()
  })

  test("AC16/AC17/AC18/AC19/AC20: preview locks drag, resize, Remove and Save; Restore Default and another widget type leave no stale preview", async ({
    page,
  }) => {
    await freshDashboard(page, DESKTOP)
    await startAdd(page)
    // Make the draft dirty first (a valid insertion into row 1, leaving row 0 room for a
    // 3-column preview), so Save's disabled state can only come from the preview.
    await page.getByTestId("widget-insertion-row-1").getByRole("button").first().click()
    await page.getByRole("button", { name: "Insert here" }).click()
    await expect(page.getByRole("button", { name: "Save" })).toBeEnabled()
    await page.locator(".widget-tray").getByRole("button", { name: /KPI Summary/ }).click()
    await slot(page, 1).click()
    const previewRects = await settled(page)
    const firstCandidate = (await placeholderNode(page)).id

    // AC18: Save is disabled while the draft is dirty AND previewing; the dirty label stays.
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled()
    await expect(page.getByText(/unsaved changes/)).toBeVisible()
    // AC17: every Remove is disabled.
    for (const remove of await page.getByRole("button", { name: /^Remove / }).all()) await expect(remove).toBeDisabled()
    // AC16: no resize handles; a real drag does not move anything or write to the draft.
    expect(await page.locator(".ui-resizable-handle").count()).toBe(0)
    const first = (await page.locator(".widget-shell").first().boundingBox())!
    await page.mouse.move(first.x + first.width / 2, first.y + 10)
    await page.mouse.down()
    await page.mouse.move(first.x + first.width + 60, first.y + 10, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    expect(await settled(page)).toEqual(previewRects)
    await expect(page.getByTestId("dashboard-editor-announcer")).toHaveText("KPI Summary added at position 1 in row 2.") // unchanged: no gesture announcement

    // AC20: another widget type ends the session and mints a new candidate id.
    await page.locator(".widget-tray").getByRole("button", { name: /Rankings/ }).click()
    await expect(page.getByTestId("insertion-placeholder")).toHaveCount(0)
    await slot(page, 1).click()
    await settled(page)
    expect((await placeholderNode(page)).id).not.toBe(firstCandidate)
    expect((await placeholderNode(page)).id).toMatch(/^ranking-/)

    // AC19: Restore Default leaves no stale preview or pending selection.
    await page.getByRole("button", { name: "Restore Default" }).click()
    await expect(page.getByTestId("insertion-placeholder")).toHaveCount(0)
    await expect(page.getByTestId("widget-insertion-slots")).toHaveCount(0)
    await settled(page)
    await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(4)
    for (const remove of await page.getByRole("button", { name: /^Remove / }).all()) await expect(remove).toBeEnabled()
  })

  test("AC21/AC15: on tablet a readable preview works, and narrowing the viewport past the dynamic cap clears it without touching the draft", async ({
    page,
  }) => {
    await freshDashboard(page, { width: 900, height: 1400 })
    const storageBefore = await readStorage(page)
    await startAdd(page)
    await slot(page, 1).click()
    const rects = await settled(page)
    await expect(page.getByTestId("insertion-placeholder")).toHaveCount(1)
    for (const rect of rects) expect(rect.width).toBeGreaterThanOrEqual(240) // still readable at 3 columns
    for (const gap of adjacentGaps(rects)) expect(gap).toBe(16)

    // The dynamic readable cap drops to 2 at 768px; the 3-column preview no longer fits.
    await page.setViewportSize({ width: 768, height: 1400 })
    await expect(page.getByTestId("insertion-placeholder")).toHaveCount(0)
    await expect(page.getByTestId("widget-insertion-preview-status")).toHaveText("")
    await expect(page.getByRole("button", { name: "Insert here" })).toBeDisabled()
    await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(4)
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled() // draft untouched
    expect(await readStorage(page)).toBe(storageBefore)
    // ...and activating the same slot is now rejected outright (no preview created).
    await slot(page, 1).click()
    await expect(page.getByTestId("widget-insertion-rejected")).toBeVisible()
    await expect(page.getByTestId("insertion-placeholder")).toHaveCount(0)
  })
})
