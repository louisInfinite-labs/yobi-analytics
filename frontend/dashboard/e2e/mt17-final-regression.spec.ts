import { test, expect, type Locator, type Page } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Final regression evidence on the real `/dashboard` route and the real
 * backend (`src/api_handler.py` served by scripts/local_api_server.py).
 * Failure states are forced only by intercepting a network request. */

const API = "http://127.0.0.1:8787"
const CORS = { "access-control-allow-origin": "*" }
const LAYOUT_KEY = "yobi-analytics-canonical-dashboard-layout"
// Height raised from 1500 for the same reason as gap7-insertion-preview.spec.ts's
// DESKTOP constant: Defect A's fix grew the default layout's real page
// height (1X widgets now render tall enough for their content with no
// internal scroll), so this suite's absolute-pixel drag/measurement
// sequences need the whole page on screen without an incidental scroll.
const VIEWPORT = { width: 1280, height: 2600 }
const GROWTH = "daily-view-growth"
const TOTAL = "total-views"
const COMPARISON = "creator-comparison-chart"

const evidence: Record<string, unknown> = {}

async function measure(page: Page) {
  return page.evaluate(() => {
    const items = [...document.querySelectorAll<HTMLElement>(".widget-shell")].map((el) => {
      const r = el.getBoundingClientRect()
      return { id: el.closest("[gs-id]")?.getAttribute("gs-id") ?? null, x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
    })
    const gaps: { type: "h" | "v"; gap: number; a: string | null; b: string | null }[] = []
    let overlaps = 0
    for (let i = 0; i < items.length; i++) {
      for (let j = 0; j < items.length; j++) {
        if (i === j) continue
        const a = items[i]
        const b = items[j]
        const rowBand = a.y < b.y + b.height && b.y < a.y + a.height
        const colBand = a.x < b.x + b.width && b.x < a.x + a.width
        if (i < j && rowBand && colBand) overlaps++
        if (rowBand && b.x > a.x && b.x - a.right < 100) gaps.push({ type: "h", gap: b.x - a.right, a: a.id, b: b.id })
        if (colBand && b.y > a.y && b.y - a.bottom < 100) gaps.push({ type: "v", gap: b.y - a.bottom, a: a.id, b: b.id })
      }
    }
    const grid = document.querySelector(".grid-stack")!.getBoundingClientRect()
    const overflow = items.filter((r) => r.x < grid.x - 0.5 || r.right > grid.right + 0.5 || r.y < grid.y - 0.5 || r.bottom > grid.bottom + 0.5).length
    return { items, gaps, overlaps, overflow, minWidth: Math.min(...items.map((r) => r.width)) }
  })
}

async function expectSound(page: Page) {
  const m = await measure(page)
  expect(m.items.length).toBeGreaterThan(0)
  expect(m.overlaps).toBe(0)
  expect(m.overflow).toBe(0)
  expect(m.gaps.length).toBeGreaterThan(0)
  for (const gap of m.gaps) expect(gap.gap).toBe(16)
  expect(m.minWidth).toBeGreaterThanOrEqual(240)
  return m
}

/** Widget rectangles relative to the grid container, plus each widget's inset inside its own grid cell. */
const relativeRects = (page: Page) =>
  page.evaluate(() => {
    const grid = document.querySelector(".grid-stack")!.getBoundingClientRect()
    return [...document.querySelectorAll<HTMLElement>("[gs-id]")]
      .map((cell) => {
        const shell = cell.querySelector<HTMLElement>(".widget-shell")!.getBoundingClientRect()
        const c = cell.getBoundingClientRect()
        return {
          id: cell.getAttribute("gs-id")!,
          x: shell.x - grid.x,
          y: shell.y - grid.y,
          width: shell.width,
          height: shell.height,
          inset: { left: shell.left - c.left, top: shell.top - c.top, right: c.right - shell.right, bottom: c.bottom - shell.bottom },
        }
      })
      .sort((a, b) => a.id.localeCompare(b.id))
  })

const tabTo = async (page: Page, target: Locator) => {
  for (let i = 0; i < 120; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return
    await page.keyboard.press("Tab")
  }
  throw new Error("could not reach the control with Tab")
}
const hasVisibleFocus = (target: Locator) => target.evaluate((el) => { const s = getComputedStyle(el); return s.outlineStyle !== "none" && s.outlineWidth !== "0px" })

const gsGeometry = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[gs-id]")]
      .map((el) => ({ id: el.getAttribute("gs-id")!, x: el.getAttribute("gs-x") ?? "0", y: el.getAttribute("gs-y") ?? "0", w: el.getAttribute("gs-w") ?? "1", h: el.getAttribute("gs-h") ?? "1" }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  )
const readStorage = (page: Page) => page.evaluate((k) => localStorage.getItem(k), LAYOUT_KEY)
const layoutWrites = (page: Page) => page.evaluate(() => (window as unknown as { __layoutWrites: string[] }).__layoutWrites.length)
const idOf = (page: Page, needle: string) => gsGeometry(page).then((all) => all.find((g) => g.id.startsWith(needle))!.id)

const apiCalls = new WeakMap<Page, { path: string; params: Record<string, string> }[]>()
const callsOf = (page: Page, p: string) => (apiCalls.get(page) ?? []).filter((c) => c.path === p)

test.beforeEach(async ({ page }) => {
  const calls: { path: string; params: Record<string, string> }[] = []
  apiCalls.set(page, calls)
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) calls.length = 0
  })
  page.on("request", (request) => {
    if (!request.url().startsWith(API) || request.method() === "OPTIONS") return
    const url = new URL(request.url())
    calls.push({ path: url.pathname, params: Object.fromEntries(url.searchParams) })
  })
  await page.addInitScript(
    ({ key }) => {
      const win = window as unknown as { __layoutWrites: string[]; __failLayoutWrite: boolean }
      win.__layoutWrites = []
      win.__failLayoutWrite = false
      const realSetItem = Storage.prototype.setItem
      Storage.prototype.setItem = function (k: string, v: string) {
        if (k === key) {
          if (win.__failLayoutWrite) throw new Error("quota")
          win.__layoutWrites.push(v)
        }
        return realSetItem.call(this, k, v)
      }
    },
    { key: LAYOUT_KEY },
  )
})

async function openFresh(page: Page, layout: unknown | null = null) {
  await page.setViewportSize(VIEWPORT)
  await page.goto("/dashboard")
  await page.evaluate(
    ({ key, value }) => {
      localStorage.clear()
      if (value !== null) localStorage.setItem(key, value)
    },
    { key: LAYOUT_KEY, value: layout ? JSON.stringify(layout) : null },
  )
  await page.reload()
  await expect(page.getByTestId("chart-catalog-status")).toHaveText("success")
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await page.mouse.move(to.x, to.y, { steps: 2 })
  await page.mouse.up()
  await page.waitForTimeout(300)
}

async function resizeSE(page: Page, widgetId: string, dx: number, dy: number) {
  const widget = page.locator(`[gs-id="${widgetId}"]`)
  const box = (await widget.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  const handle = widget.locator(".ui-resizable-se")
  await handle.waitFor({ state: "visible" })
  const h = (await handle.boundingBox())!
  await drag(page, { x: h.x + h.width / 2, y: h.y + h.height / 2 }, { x: h.x + h.width / 2 + dx, y: h.y + h.height / 2 + dy })
}

test.describe("MT-17: full normal edit workflow on the real Dashboard", () => {
  test("one catalog request through Add, drag, resize, rejected gestures, Save and reload; identity and geometry survive; gaps stay exactly 16px", async ({ page }) => {
    await openFresh(page)
    expect(callsOf(page, "/dashboard/chart-catalog")).toHaveLength(1)
    const initial = await expectSound(page)
    const originalIds = (await gsGeometry(page)).map((g) => g.id)
    evidence.viewInitial = { widgets: initial.items.length, gaps: initial.gaps.map((g) => g.gap) }

    for (let i = 0; i < 3; i++) {
      await page.getByRole("button", { name: "Edit Layout" }).click()
      await page.getByRole("button", { name: "Cancel" }).click()
    }
    expect(callsOf(page, "/dashboard/chart-catalog")).toHaveLength(1)
    expect(await layoutWrites(page)).toBe(0)

    const viewRects = await relativeRects(page)
    for (const rect of viewRects) expect(rect.inset).toEqual({ left: 8, top: 8, right: 8, bottom: 8 }) // each widget contributes exactly 8px per edge
    await page.getByRole("button", { name: "Edit Layout" }).click()
    await expectSound(page)
    expect(await relativeRects(page)).toEqual(viewRects) // entering Edit changes no widget rectangle

    // Add: a chart is selected, a slot previewed (draft only), then committed with a fresh widgetId.
    await page.locator(".widget-tray").getByRole("button", { name: /KPI Summary/ }).click()
    await page.getByTestId("widget-insertion-row-0").getByRole("button").last().click()
    const preview = await expectSound(page)
    expect(await layoutWrites(page)).toBe(0)
    await page.getByRole("button", { name: "Insert here" }).click()
    const afterAdd = await expectSound(page)
    const idsAfterAdd = (await gsGeometry(page)).map((g) => g.id)
    const added = idsAfterAdd.filter((id) => !originalIds.includes(id))
    expect(added).toHaveLength(1)
    expect(new Set(idsAfterAdd).size).toBe(idsAfterAdd.length)
    expect(callsOf(page, "/dashboard/chart-catalog")).toHaveLength(1)
    const columns = new Set((await gsGeometry(page)).map((g) => g.x))
    expect(columns.size).toBe(3)
    evidence.add = { previewGaps: preview.gaps.map((g) => g.gap), afterAddGaps: afterAdd.gaps.map((g) => g.gap), newWidgetId: added[0] }

    // A fourth column cannot be created.
    await page.locator(".widget-tray").getByRole("button", { name: /KPI Summary/ }).click()
    await page.getByTestId("widget-insertion-row-0").getByRole("button").last().click()
    await expect(page.getByTestId("widget-insertion-rejected")).toBeVisible()
    expect(new Set((await gsGeometry(page)).map((g) => g.x)).size).toBe(3)
    expect((await gsGeometry(page)).length).toBe(idsAfterAdd.length)
    await page.getByTestId("widget-insertion-slots").getByRole("button", { name: "Cancel" }).click()
    await expect(page.getByTestId("widget-insertion-slots")).toHaveCount(0)

    const ringId = await idOf(page, "contribution-ring")
    const rankId = await idOf(page, "ranking")
    const before = await gsGeometry(page)
    const rects = await measure(page)
    const ring = rects.items.find((r) => r.id === ringId)!
    const rank = rects.items.find((r) => r.id === rankId)!
    const colPitch = rank.x - ring.x

    // Invalid target: widening the ring into rank's still-occupied cell is
    // rejected (a resize, not a move -- resize never swaps, see
    // dashboardWidgetActions.ts's tryPositionSwap); nothing moves
    // canonically. Deliberately not a *drag* directly onto rank's cell here:
    // since the Manual Layout Correction Pass (Defect B), a same-footprint
    // widget *moved* exactly onto another's cell swaps them instead of
    // rejecting -- see the dedicated swap coverage in
    // gap4c-pointer-wiring.spec.ts and dashboardWidgetActions.test.ts. This
    // is the same resize the "valid resize" step below performs successfully
    // once rank has actually moved out of the way.
    await resizeSE(page, ringId, colPitch, 0)
    expect(await gsGeometry(page)).toEqual(before)
    await expectSound(page)

    // Valid drag: ranking moves into the empty third column of the second row; its widgetId is unchanged.
    await drag(page, { x: rank.x + rank.width / 2, y: rank.y + 10 }, { x: rank.x + rank.width / 2 + colPitch, y: rank.y + 10 })
    const afterDrag = await gsGeometry(page)
    const movedRank = afterDrag.find((g) => g.id === rankId)!
    expect(movedRank.x).toBe("2")
    expect(afterDrag.map((g) => g.id).sort()).toEqual(before.map((g) => g.id).sort())
    await expectSound(page)

    // Valid resize: the ring widens into the freed cell; a rejected shrink of growth-bar-chart rolls back.
    await resizeSE(page, ringId, colPitch, 0)
    const afterResize = await gsGeometry(page)
    expect(afterResize.find((g) => g.id === ringId)!.w).toBe("2")
    const growthId = await idOf(page, "growth-bar-chart")
    const growthBefore = afterResize.find((g) => g.id === growthId)!
    await resizeSE(page, growthId, 0, -60)
    expect((await gsGeometry(page)).find((g) => g.id === growthId)).toEqual(growthBefore)
    const committed = await gsGeometry(page)
    const sound = await expectSound(page)
    expect(await layoutWrites(page)).toBe(0) // still draft-only
    evidence.dragResize = { movedRankX: movedRank.x, ringWidth: "2", gaps: sound.gaps.map((g) => g.gap), overlaps: sound.overlaps, overflow: sound.overflow }

    // Save: existing widgets changed geometry, so the confirmation dialog opens first (focus trapped, Escape closes, focus returns).
    const editRects = await relativeRects(page)
    const saveButton = page.getByRole("button", { name: "Save", exact: true })
    await saveButton.click()
    const confirm = page.getByRole("dialog", { name: "Save layout changes?" })
    await expect(confirm).toBeVisible()
    await expect(confirm.getByTestId("current-grid")).toHaveText("2x2")
    await expect(confirm.getByTestId("target-grid")).toHaveText("3x2")
    await expect(confirm.getByTestId("affected-widget-count")).toHaveText("2")
    await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused()
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab")
      expect(await confirm.evaluate((el) => el.contains(document.activeElement))).toBe(true)
    }
    await page.keyboard.press("Escape")
    await expect(confirm).toHaveCount(0)
    await expect(saveButton).toBeFocused()
    expect(await layoutWrites(page)).toBe(0)

    await saveButton.click()
    await confirm.getByRole("button", { name: "Continue and Save" }).click()
    await expect(page.getByRole("button", { name: "Edit Layout" })).toBeVisible()
    expect(await layoutWrites(page)).toBe(1)
    const storedBeforeReload = JSON.parse((await readStorage(page))!)
    const viewAfterSave = await gsGeometry(page)
    expect(viewAfterSave).toEqual(committed)
    expect(callsOf(page, "/dashboard/chart-catalog")).toHaveLength(1)
    await expectSound(page)
    expect(await relativeRects(page)).toEqual(editRects) // the edit preview and the saved view-mode widgets share identical rectangles

    await page.reload()
    await expect(page.getByTestId("chart-catalog-status")).toHaveText("success")
    expect(callsOf(page, "/dashboard/chart-catalog")).toHaveLength(1) // a new page lifecycle makes its own single request
    const storedAfterReload = JSON.parse((await readStorage(page))!)
    expect(storedAfterReload).toEqual(storedBeforeReload)
    expect(storedAfterReload.widgets.map((w: { widgetId: string }) => w.widgetId)).toEqual(storedBeforeReload.widgets.map((w: { widgetId: string }) => w.widgetId))
    expect(await gsGeometry(page)).toEqual(committed)
    const afterReload = await expectSound(page)
    evidence.saveReload = {
      orderedWidgetIds: storedAfterReload.widgets.map((w: { widgetId: string }) => w.widgetId),
      grid: storedAfterReload.grid,
      geometry: storedAfterReload.widgets.map((w: { widgetId: string; x: number; y: number; width: number; height: number; widgetType: string }) => [w.widgetId, w.widgetType, w.x, w.y, w.width, w.height]),
      gapsAfterReload: afterReload.gaps.map((g) => g.gap),
    }
  })
})

test.describe("MT-17: chart catalog source of truth", () => {
  test("explicit Retry after an error makes exactly one additional request and then offers the backend's charts", async ({ page }) => {
    let served = 0
    await page.route("**/dashboard/chart-catalog", (route) => {
      served++
      if (served === 1) return route.fulfill({ status: 500, headers: CORS, contentType: "application/json", body: JSON.stringify({ error: "Internal server error" }) })
      return route.continue()
    })
    await page.setViewportSize(VIEWPORT)
    await page.goto("/dashboard")
    await expect(page.getByTestId("chart-catalog-status")).toHaveText("error")
    expect(callsOf(page, "/dashboard/chart-catalog")).toHaveLength(1)
    await page.getByRole("button", { name: "Edit Layout" }).click()
    await page.getByRole("button", { name: "Add" }).count()
    expect(callsOf(page, "/dashboard/chart-catalog")).toHaveLength(1)
    await page.locator(".widget-tray").getByRole("button", { name: "Retry" }).click()
    await expect(page.getByTestId("chart-catalog-status")).toHaveText("success")
    expect(callsOf(page, "/dashboard/chart-catalog")).toHaveLength(2)
    await expect(page.locator(".widget-tray").getByRole("button")).toHaveCount(4)
    evidence.catalogRetry = { requests: callsOf(page, "/dashboard/chart-catalog").length }
  })

  test("a successful empty catalog shows the empty state and deletes no widget; backend order is respected", async ({ page }) => {
    await page.route("**/dashboard/chart-catalog", (route) => route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ charts: [] }) }))
    await page.setViewportSize(VIEWPORT)
    await page.goto("/dashboard")
    await expect(page.getByTestId("chart-catalog-status")).toHaveText("success")
    await page.getByRole("button", { name: "Edit Layout" }).click()
    await expect(page.getByTestId("widget-tray-status")).toContainText("No charts are currently available")
    await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(4)
    expect(await layoutWrites(page)).toBe(0)
  })

  test("the Add tray follows the order the backend returns", async ({ page }) => {
    await page.route("**/dashboard/chart-catalog", (route) =>
      route.fulfill({
        status: 200,
        headers: CORS,
        contentType: "application/json",
        body: JSON.stringify({ charts: [{ chartDefinitionId: "ranking", title: "Rankings" }, { chartDefinitionId: "contribution-ring", title: "Channel Contribution" }, { chartDefinitionId: "kpi-summary", title: "KPI Summary" }] }),
      }),
    )
    await page.setViewportSize(VIEWPORT)
    await page.goto("/dashboard")
    await expect(page.getByTestId("chart-catalog-status")).toHaveText("success")
    await page.getByRole("button", { name: "Edit Layout" }).click()
    const titles = (await page.locator(".widget-tray__item-title").allTextContents()).map((t) => t.trim())
    expect(titles).toEqual(["Rankings", "Channel Contribution", "KPI Summary"])
  })
})

const FLOW_LAYOUT = {
  grid: { columns: 2, rows: 2 },
  widgets: [
    { widgetId: "cmp0", widgetType: COMPARISON, x: 0, y: 0, width: 1, height: 1, comparison: { creatorIds: ["ch_gawr_gura"], comparisonItemIds: [GROWTH] } },
    { widgetId: "cmp1", widgetType: COMPARISON, x: 1, y: 0, width: 1, height: 1, comparison: { creatorIds: ["ch_gawr_gura", "ch_usada_pekora"], comparisonItemIds: [TOTAL] } },
    { widgetId: "kpi", widgetType: "kpi-summary", x: 0, y: 1, width: 1, height: 1 },
    { widgetId: "rank", widgetType: "ranking", x: 1, y: 1, width: 1, height: 1 },
  ],
}

async function expectTrapped(page: Page, dialog: Locator) {
  await expect.poll(() => dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab")
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  }
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Shift+Tab")
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  }
}

test.describe("MT-17: production dialogs", () => {
  test("Flow 2 dialog: focus moves in and is trapped, Escape closes without writing, focus returns to its trigger; items are exactly the backend's", async ({ page, request }) => {
    const backendItems = await (await request.get(`${API}/dashboard/comparison-items`)).json()
    expect(backendItems.comparisonItems.map((i: { comparisonItemId: string }) => i.comparisonItemId)).toEqual([GROWTH, TOTAL])

    await openFresh(page, FLOW_LAYOUT)
    const trigger = page.getByRole("button", { name: "Compare Creators" })
    await trigger.focus()
    await trigger.click()
    const dialog = page.getByRole("dialog", { name: "Add Comparison Charts" })
    await expect(dialog).toBeVisible()
    await expectTrapped(page, dialog)

    const itemLabels = (await dialog.getByRole("region", { name: "Comparison items" }).getByRole("button").allTextContents()).map((t) => t.trim())
    expect(itemLabels).toEqual(backendItems.comparisonItems.map((i: { label: string }) => i.label))
    for (const forbidden of ["Revenue", "Engagement", "Growth"]) expect(itemLabels).not.toContain(forbidden)
    expect(callsOf(page, "/dashboard/comparison-items")).toHaveLength(1)

    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    expect(await layoutWrites(page)).toBe(0)
    evidence.flow2Dialog = { itemLabels, focusReturnedToTrigger: true }
  })

  test("Flow 1 picker: focus moves in and is trapped, Escape cancels leaving the draft unchanged, focus returns to Select Creators", async ({ page }) => {
    await openFresh(page, FLOW_LAYOUT)
    await page.getByRole("button", { name: "Edit Layout" }).click()
    const select = page.getByRole("button", { name: /Select Creators/ }).first()
    await select.focus()
    await select.click()
    const dialog = page.getByRole("dialog", { name: "Select Creators" })
    await expect(dialog).toBeVisible()
    await expectTrapped(page, dialog)
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await expect(select).toBeFocused()
    expect(await layoutWrites(page)).toBe(0)
    await expect(page.locator('[gs-id="cmp0"]').getByTestId("comparison-widget-creators").locator("li")).toHaveCount(1)
  })
})

test.describe("MT-17: real comparison backend contract", () => {
  test("items come from the backend, an unsupported item is rejected with 400, and creator and item order are preserved", async ({ request }) => {
    const items = await (await request.get(`${API}/dashboard/comparison-items`)).json()
    expect(items).toEqual({ comparisonItems: [{ comparisonItemId: GROWTH, label: "Daily view growth" }, { comparisonItemId: TOTAL, label: "Total views" }] })

    const unsupported = await request.get(`${API}/dashboard/comparison-data`, { params: { creatorIds: "gawr_gura,usada_pekora", comparisonItemIds: "revenue", reportDate: "2026-09-03", timeZone: "Asia/Tokyo" } })
    expect(unsupported.status()).toBe(400)
    const unsupportedBody = await unsupported.json()
    expect(typeof unsupportedBody.error).toBe("string")

    const ordered = await (await request.get(`${API}/dashboard/comparison-data`, { params: { creatorIds: "shirakami_fubuki,gawr_gura,usada_pekora", comparisonItemIds: `${TOTAL},${GROWTH}`, reportDate: "2026-09-03", timeZone: "Asia/Tokyo" } })).json()
    expect(ordered.items.map((i: { comparisonItemId: string }) => i.comparisonItemId)).toEqual([TOTAL, GROWTH])
    for (const item of ordered.items) expect(item.creators.map((c: { creatorId: string }) => c.creatorId)).toEqual(["shirakami_fubuki", "gawr_gura", "usada_pekora"])
    evidence.backendContract = { items: items.comparisonItems, unsupportedStatus: unsupported.status(), unsupportedBody, orderedItemIds: ordered.items.map((i: { comparisonItemId: string }) => i.comparisonItemId) }
  })
})

test.describe("MT-17: persistence failure, focus visibility, comparison edge cases", () => {
  test("a failed Save leaves the stored layout byte-identical, keeps the draft, and a later Save succeeds", async ({ page }) => {
    await openFresh(page)
    await page.getByRole("button", { name: "Edit Layout" }).click()
    await page.locator(".widget-tray").getByRole("button", { name: /KPI Summary/ }).click()
    await page.getByTestId("widget-insertion-row-0").getByRole("button").last().click()
    await page.getByRole("button", { name: "Insert here" }).click()
    const draftGeometry = await gsGeometry(page)
    const storedBefore = await readStorage(page)

    await page.evaluate(() => ((window as unknown as { __failLayoutWrite: boolean }).__failLayoutWrite = true))
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible() // still editing
    await expect.poll(() => page.getByRole("button", { name: "Save", exact: true }).isEnabled()).toBe(true)
    expect(await readStorage(page)).toBe(storedBefore)
    expect(await layoutWrites(page)).toBe(0)
    expect(await gsGeometry(page)).toEqual(draftGeometry) // the draft survives the failure
    await expect(page.getByRole("button", { name: "Edit Layout" })).toHaveCount(0)

    await page.evaluate(() => ((window as unknown as { __failLayoutWrite: boolean }).__failLayoutWrite = false))
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await expect(page.getByRole("button", { name: "Edit Layout" })).toBeVisible()
    expect(await layoutWrites(page)).toBe(1)
    expect(JSON.parse((await readStorage(page))!).widgets).toHaveLength(5)
    evidence.failedSave = { storedUnchangedAfterFailure: true, writesAfterFailure: 0, draftPreserved: true }
  })

  test("Restore Default changes only the draft to the 2x2 default, sends no save until Save, and Cancel restores the saved layout", async ({ page }) => {
    await openFresh(page, FLOW_LAYOUT)
    const saved = await readStorage(page)
    await page.getByRole("button", { name: "Edit Layout" }).click()
    await page.getByRole("button", { name: "Restore Default" }).click()

    const geometry = await gsGeometry(page)
    expect(geometry).toHaveLength(4)
    expect(geometry.map((g) => `${g.x},${g.y},${g.w},${g.h}`).sort()).toEqual(["0,0,1,2", "0,2,1,2", "1,0,1,2", "1,2,1,2"]) // GridStack rows: one 1X row = 2 rows
    expect(geometry.some((g) => g.id === "cmp0")).toBe(false) // the draft was replaced by the default widgets
    expect(await readStorage(page)).toBe(saved)
    expect(await layoutWrites(page)).toBe(0)

    await page.getByRole("button", { name: "Cancel" }).click()
    expect(await readStorage(page)).toBe(saved)
    expect(await layoutWrites(page)).toBe(0)
    expect((await gsGeometry(page)).map((g) => g.id).sort()).toEqual(["cmp0", "cmp1", "kpi", "rank"])
  })

  test("ordinary editor actions show a visible focus indicator on the real route", async ({ page }) => {
    await openFresh(page, FLOW_LAYOUT)
    const visible: Record<string, boolean> = {}
    for (const [name, locator] of [
      ["Edit Layout", page.getByRole("button", { name: "Edit Layout" })],
      ["Compare Creators", page.getByRole("button", { name: "Compare Creators" })],
    ] as const) {
      await tabTo(page, locator)
      visible[name] = await hasVisibleFocus(locator)
    }
    await page.getByRole("button", { name: "Edit Layout" }).click()
    const select = page.getByRole("button", { name: /Select Creators/ }).first()
    await tabTo(page, select)
    visible["Select Creators"] = await hasVisibleFocus(select)
    for (const [name, ok] of Object.entries(visible)) expect(ok, `${name} focus indicator`).toBe(true)
    evidence.focusVisible = visible
  })

  test("the catalog Retry control has a visible focus indicator", async ({ page }) => {
    await page.route("**/dashboard/chart-catalog", (route) => route.fulfill({ status: 500, headers: CORS, contentType: "application/json", body: JSON.stringify({ error: "Internal server error" }) }))
    await page.setViewportSize(VIEWPORT)
    await page.goto("/dashboard")
    await expect(page.getByTestId("chart-catalog-status")).toHaveText("error")
    await page.getByRole("button", { name: "Edit Layout" }).click()
    const retry = page.locator(".widget-tray").getByRole("button", { name: "Retry" })
    await tabTo(page, retry)
    expect(await hasVisibleFocus(retry)).toBe(true)
  })

  test("Flow 1: Apply changes only the draft (no save, no catalog request), keeps creator order, and focus stays on a live control", async ({ page }) => {
    await openFresh(page, FLOW_LAYOUT)
    await page.getByRole("button", { name: "Edit Layout" }).click()
    const before = await readStorage(page)
    await page.getByRole("button", { name: /Select Creators/ }).first().click()
    const dialog = page.getByRole("dialog", { name: "Select Creators" })
    await dialog.getByRole("button", { name: "白上フブキ", exact: true }).click()
    await dialog.getByRole("button", { name: "Apply" }).click()
    await expect(dialog).toHaveCount(0)

    const ids = await page.locator('[gs-id="cmp0"]').getByTestId("comparison-widget-creators").locator("li").evaluateAll((els) => els.map((el) => el.getAttribute("data-creator-id")))
    expect(ids).toEqual(["ch_gawr_gura", "ch_shirakami_fubuki"])
    expect(await readStorage(page)).toBe(before)
    expect(await layoutWrites(page)).toBe(0)
    expect(callsOf(page, "/dashboard/chart-catalog")).toHaveLength(1)
    await expect.poll(() => callsOf(page, "/dashboard/comparison-data").some((c) => c.params.creatorIds === "gawr_gura,shirakami_fubuki")).toBe(true)
    const focus = await page.evaluate(() => ({ tag: document.activeElement?.tagName, inBody: document.activeElement === document.body }))
    evidence.flow1Apply = { creatorOrder: ids, focusAfterApply: focus }
    expect(focus.inBody).toBe(false)
  })

  test("Flow 2 with more widgets than items assigns from the top-left widget and leaves every unassigned widget untouched", async ({ page }) => {
    await openFresh(page, FLOW_LAYOUT)
    const before = JSON.parse((await readStorage(page))!)
    await page.getByRole("button", { name: "Compare Creators" }).click()
    const dialog = page.getByRole("dialog", { name: "Add Comparison Charts" })
    for (const name of ["Gawr Gura", "兎田ぺこら"]) await dialog.getByRole("button", { name, exact: true }).click()
    for (const item of ["Total views", "Daily view growth"]) await dialog.getByRole("button", { name: item }).click()
    await dialog.getByRole("button", { name: "Save" }).click()
    await expect(dialog).toHaveCount(0)

    expect(await layoutWrites(page)).toBe(1)
    const after = JSON.parse((await readStorage(page))!)
    expect(after.widgets).toHaveLength(4)
    const byId = (layout: typeof after) => new Map(layout.widgets.map((w: { widgetId: string }) => [w.widgetId, w]))
    const b = byId(before)
    const a = byId(after)
    expect(a.get("cmp0").comparison).toEqual({ creatorIds: ["ch_gawr_gura", "ch_usada_pekora"], comparisonItemIds: [TOTAL] })
    expect(a.get("cmp1").comparison).toEqual({ creatorIds: ["ch_gawr_gura", "ch_usada_pekora"], comparisonItemIds: [GROWTH] })
    expect(a.get("kpi")).toEqual(b.get("kpi"))
    expect(a.get("rank")).toEqual(b.get("rank"))
    for (const id of ["cmp0", "cmp1"]) expect(["x", "y", "width", "height"].map((k) => a.get(id)[k])).toEqual(["x", "y", "width", "height"].map((k) => b.get(id)[k]))
  })
})

test.afterAll(() => {
  const outDir = path.join(__dirname, "results")
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, "mt17-browser-evidence.json"), JSON.stringify(evidence, null, 2))
})
