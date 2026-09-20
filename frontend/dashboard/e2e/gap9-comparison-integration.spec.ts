import { test, expect, type Locator, type Page } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** GAP-9 / GAP-3+10 browser evidence: MT-10 through MT-14 driven through the
 * real `/dashboard` route against the REAL backend -- `src/api_handler.py`'s
 * own routing, validation and computation, served by
 * `scripts/local_api_server.py` over a seeded local JSON store (see
 * playwright.config.ts). The Dashboard's default `ComparisonSource` and chart
 * catalog fetcher talk to it exactly as they talk to the deployed API.
 *
 * Failure and edge states (loading, full error, empty, partial error) are
 * forced with Playwright network interception on the comparison-data request
 * only; the request the Dashboard sends is inspected the same way. Production
 * code carries no test switches and no test globals.
 */

const API = "http://127.0.0.1:8787"
const LAYOUT_KEY = "yobi-analytics-canonical-dashboard-layout"
const ACTIVE_CREATOR_KEY = "yobi.home.selectedCreatorId"
const VIEWPORT = { width: 1280, height: 2600 }

// Roster ids (`ch_<creatorId>`) of creators the backend fixture has snapshots for.
// (`ch_iofi` is deliberately not used: its roster id is not `ch_` + its Creator Master id, so the backend cannot match it.)
const A = { id: "ch_gawr_gura", name: "Gawr Gura", backendId: "gawr_gura" }
const B = { id: "ch_usada_pekora", name: "兎田ぺこら", backendId: "usada_pekora" }
const C = { id: "ch_shirakami_fubuki", name: "白上フブキ", backendId: "shirakami_fubuki" }
// A roster creator with no Creator Master counterpart: the backend reports it unavailable.
const UNAVAILABLE = { id: "ch_amelia_myth_graduated", name: "Watson Amelia", backendId: "amelia_myth_graduated" }

const GROWTH = "daily-view-growth"
const TOTAL = "total-views"

const COMPARISON = "creator-comparison-chart"
const w = (widgetId: string, widgetType: string, x: number, y: number, extra: object = {}) => ({ widgetId, widgetType, x, y, width: 1, height: 1, ...extra })
const cmp = (widgetId: string, x: number, y: number, creatorIds: string[], item: string) =>
  w(widgetId, COMPARISON, x, y, { comparison: { creatorIds, comparisonItemIds: [item] } })

const FLOW_LAYOUT = {
  grid: { columns: 2, rows: 2 },
  widgets: [cmp("cmp0", 0, 0, [A.id], GROWTH), cmp("cmp1", 1, 0, [A.id, B.id], TOTAL), w("kpi", "kpi-summary", 0, 1), w("rank", "ranking", 1, 1)],
}

interface ApiCall {
  path: string
  params: Record<string, string>
}

const evidence: Record<string, unknown> = {}

const apiCalls = new WeakMap<Page, ApiCall[]>()
const callsOf = (page: Page, path: string) => (apiCalls.get(page) ?? []).filter((call) => call.path === path)

test.beforeEach(async ({ page }) => {
  const calls: ApiCall[] = []
  apiCalls.set(page, calls)
  // Only the requests made since the most recent navigation (the page under test) are counted.
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

async function seed(page: Page, layout: unknown | null, viewport = VIEWPORT) {
  await page.setViewportSize(viewport)
  await page.goto("/dashboard")
  await page.evaluate(
    ({ layoutKey, layoutValue }) => {
      localStorage.clear()
      if (layoutValue !== null) localStorage.setItem(layoutKey, layoutValue)
    },
    { layoutKey: LAYOUT_KEY, layoutValue: layout ? JSON.stringify(layout) : null },
  )
  await page.reload()
  await expect(page.getByTestId("chart-catalog-status")).toHaveText("success")
}

const CORS = { "access-control-allow-origin": "*" }
type DataScenario = "loading" | "error" | "empty" | { partialError: string[] }

/** Forces one comparison-data outcome by intercepting only that request. */
async function forceComparisonData(page: Page, scenario: DataScenario) {
  await page.route("**/dashboard/comparison-data**", async (route) => {
    if (scenario === "loading") return new Promise<void>(() => undefined)
    if (scenario === "error") return route.fulfill({ status: 500, headers: CORS, contentType: "application/json", body: JSON.stringify({ error: "Internal server error" }) })
    const real = await route.fetch()
    const json = await real.json()
    if (scenario === "empty") {
      json.items = json.items.map((item: { comparisonItemId: string }) => ({ comparisonItemId: item.comparisonItemId, creators: [] }))
    } else {
      for (const item of json.items) {
        item.creators = item.creators.map((c: { creatorId: string }) => (scenario.partialError.includes(c.creatorId) ? { creatorId: c.creatorId, status: "error" } : c))
      }
    }
    return route.fulfill({ response: real, json })
  })
}

const readStorage = (page: Page, key = LAYOUT_KEY) => page.evaluate((k) => localStorage.getItem(k), key)
const readLayout = async (page: Page) => JSON.parse((await readStorage(page))!) as { grid: unknown; widgets: { widgetId: string; widgetType: string; x: number; y: number; width: number; height: number; comparison?: { creatorIds: string[]; comparisonItemIds: string[] } }[] }
const layoutWrites = (page: Page) => page.evaluate(() => (window as unknown as { __layoutWrites: string[] }).__layoutWrites.length)
const dataCalls = (page: Page) => callsOf(page, "/dashboard/comparison-data")
const shell = (page: Page, widgetId: string) => page.locator(`[gs-id="${widgetId}"]`)
const creatorList = (page: Page, widgetId: string) => shell(page, widgetId).getByTestId("comparison-widget-creators").locator("li")
const creatorListIds = async (page: Page, widgetId: string) => creatorList(page, widgetId).evaluateAll((els) => els.map((el) => el.getAttribute("data-creator-id")))
const creatorListBadges = async (page: Page, widgetId: string) => creatorList(page, widgetId).locator(".comparison-order-badge").evaluateAll((els) => els.map((el) => `${el.getAttribute("aria-label")}|${el.textContent}`))
const gsGeometry = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[gs-id]")]
      .map((el) => ({ id: el.getAttribute("gs-id")!, x: el.getAttribute("gs-x") ?? "0", y: el.getAttribute("gs-y") ?? "0", w: el.getAttribute("gs-w") ?? "1", h: el.getAttribute("gs-h") ?? "1" }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  )
const editButton = (page: Page) => page.getByRole("button", { name: "Edit Layout" })
const badgeOf = (button: Locator) => button.locator(".comparison-order-badge")

async function orderBadges(dialog: Locator, creators: { name: string }[]) {
  const out: Record<string, string | null> = {}
  for (const creator of creators) {
    const badge = badgeOf(dialog.getByRole("button", { name: creator.name, exact: true }))
    out[creator.name] = (await badge.count()) === 0 ? null : `${await badge.getAttribute("aria-label")}|${await badge.textContent()}`
  }
  return out
}

async function dragCreator(page: Page, creatorName: string, target: Locator, options: { release?: "drop" | "escape" | "outside" } = {}) {
  const cell = page.locator(".draggable-creator-list").getByRole("button", { name: creatorName, exact: true })
  const from = (await cell.boundingBox())!
  const to = (await target.boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 12, { steps: 4 })
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 })
  const midDrag = await page.locator("[data-drop-state]").evaluateAll((els) => els.map((el) => `${el.closest("[gs-id]")?.getAttribute("gs-id")}:${el.getAttribute("data-drop-state")}`))
  if (options.release === "escape") {
    await page.keyboard.press("Escape")
    await page.mouse.up()
  } else if (options.release === "outside") {
    await page.mouse.move(to.x + to.width / 2, 5, { steps: 10 })
    await page.mouse.up()
  } else {
    await page.mouse.up()
  }
  return midDrag
}

test.describe("GAP-9: MT-10 ordered creator selection (Flow 2 dialog and Flow 1 picker)", () => {
  test("Scenario 1: A, B, C selection numbers 1-2-3, renumbers on deselect and appends on reselect; the active creator never changes", async ({ page }) => {
    await seed(page, FLOW_LAYOUT)
    const activeBefore = await readStorage(page, ACTIVE_CREATOR_KEY)
    await page.getByRole("button", { name: "Compare Creators" }).click()
    const dialog = page.getByRole("dialog", { name: "Add Comparison Charts" })

    // MT-14 AC2: the selectable items are exactly what the backend defines (one request), nothing else.
    const itemLabels = await dialog.getByRole("region", { name: "Comparison items" }).getByRole("button").allTextContents()
    expect(itemLabels).toEqual(["Daily view growth", "Total views"])
    expect(callsOf(page, "/dashboard/comparison-items")).toHaveLength(1)

    for (const creator of [A, B, C]) await dialog.getByRole("button", { name: creator.name, exact: true }).click()
    const abc = await orderBadges(dialog, [A, B, C])
    expect(abc).toEqual({ [A.name]: "Comparison order 1|1", [B.name]: "Comparison order 2|2", [C.name]: "Comparison order 3|3" })
    await expect(dialog.getByRole("button", { name: A.name, exact: true })).toHaveAttribute("aria-pressed", "true")

    await dialog.getByRole("button", { name: B.name, exact: true }).click()
    const ac = await orderBadges(dialog, [A, B, C])
    expect(ac).toEqual({ [A.name]: "Comparison order 1|1", [B.name]: null, [C.name]: "Comparison order 2|2" })

    await dialog.getByRole("button", { name: B.name, exact: true }).click()
    const acb = await orderBadges(dialog, [A, B, C])
    expect(acb).toEqual({ [A.name]: "Comparison order 1|1", [C.name]: "Comparison order 2|2", [B.name]: "Comparison order 3|3" })

    // A creator is one entry: toggling an already-selected creator never duplicates it.
    await dialog.getByRole("button", { name: A.name, exact: true }).click()
    await dialog.getByRole("button", { name: A.name, exact: true }).click()
    expect(await orderBadges(dialog, [A, B, C])).toEqual({ [C.name]: "Comparison order 1|1", [B.name]: "Comparison order 2|2", [A.name]: "Comparison order 3|3" })

    // Fewer than two creators (or no item) keeps Save disabled.
    await dialog.getByRole("button", { name: C.name, exact: true }).click()
    await dialog.getByRole("button", { name: B.name, exact: true }).click()
    await dialog.getByRole("button", { name: "Daily view growth" }).click()
    await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled()

    expect(await readStorage(page, ACTIVE_CREATOR_KEY)).toBe(activeBefore)
    evidence.orderedSelection = { abc, ac, acb, activeCreatorUnchanged: true }
  })

  test("MT-10 AC6: searching the picker never removes a selected creator; Apply needs two creators", async ({ page }) => {
    await seed(page, FLOW_LAYOUT)
    await editButton(page).click()
    await shell(page, "cmp0").getByRole("button", { name: "Select Creators" }).click()
    const picker = page.getByRole("dialog", { name: "Select Creators" })
    await expect(badgeOf(picker.getByRole("button", { name: A.name, exact: true }))).toHaveAttribute("aria-label", "Comparison order 1")
    await expect(picker.getByRole("button", { name: "Apply" })).toBeDisabled() // one creator only

    await picker.getByRole("button", { name: B.name, exact: true }).click()
    await picker.getByLabel("Search creators").fill("Nyx")
    await expect(picker.getByRole("button", { name: A.name, exact: true })).toHaveCount(0) // filtered out of view...
    await picker.getByLabel("Search creators").fill("")
    await expect(badgeOf(picker.getByRole("button", { name: A.name, exact: true }))).toHaveAttribute("aria-label", "Comparison order 1") // ...but still selected
    await expect(badgeOf(picker.getByRole("button", { name: B.name, exact: true }))).toHaveAttribute("aria-label", "Comparison order 2")
    await expect(picker.getByRole("button", { name: "Apply" })).toBeEnabled()
  })
})

test.describe("GAP-9: MT-11 Flow 1 in-widget picker", () => {
  test("Scenario 2: Select Creators updates only the draft; Cancel changes nothing; Save persists order via the normal Dashboard Save", async ({ page }) => {
    await seed(page, FLOW_LAYOUT)
    const canonicalRaw = await readStorage(page)
    const geometryBefore = await gsGeometry(page)
    const activeBefore = await readStorage(page, ACTIVE_CREATOR_KEY)
    await expect(shell(page, "cmp0").getByRole("button", { name: "Select Creators" })).toHaveCount(0) // view mode: not offered
    await editButton(page).click()

    // Cancel: nothing changes.
    await shell(page, "cmp0").getByRole("button", { name: "Select Creators" }).click()
    let picker = page.getByRole("dialog", { name: "Select Creators" })
    await picker.getByRole("button", { name: B.name, exact: true }).click()
    await picker.getByRole("button", { name: "Cancel" }).click()
    expect(await creatorListIds(page, "cmp0")).toEqual([A.id])
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled() // draft still clean

    // Apply: draft only.
    await shell(page, "cmp0").getByRole("button", { name: "Select Creators" }).click()
    picker = page.getByRole("dialog", { name: "Select Creators" })
    await picker.getByRole("button", { name: B.name, exact: true }).click()
    await picker.getByRole("button", { name: C.name, exact: true }).click()
    expect(await orderBadges(picker, [A, B, C])).toEqual({ [A.name]: "Comparison order 1|1", [B.name]: "Comparison order 2|2", [C.name]: "Comparison order 3|3" })
    await picker.getByRole("button", { name: "Apply" }).click()
    expect(await creatorListIds(page, "cmp0")).toEqual([A.id, B.id, C.id])
    expect(await creatorListBadges(page, "cmp0")).toEqual(["Comparison order 1|1", "Comparison order 2|2", "Comparison order 3|3"])
    expect(await creatorListIds(page, "cmp1")).toEqual([A.id, B.id]) // other widget untouched
    expect(await readStorage(page)).toBe(canonicalRaw) // canonical storage unchanged before Save
    expect(await layoutWrites(page)).toBe(0)
    expect(await gsGeometry(page)).toEqual(geometryBefore)
    await expect(page.getByTestId("dashboard-editor-announcer")).toContainText(`Comparison creators updated: 1, ${A.name}; 2, ${B.name}; 3, ${C.name}.`)

    // Save through the normal Dashboard Save: exactly one write.
    await page.getByRole("button", { name: "Save" }).click()
    await expect(editButton(page)).toBeVisible()
    expect(await layoutWrites(page)).toBe(1)
    const saved = await readLayout(page)
    const savedCmp0 = saved.widgets.find((x) => x.widgetId === "cmp0")!
    expect(savedCmp0.comparison).toEqual({ creatorIds: [A.id, B.id, C.id], comparisonItemIds: [GROWTH] })
    expect(saved.widgets.map((x) => [x.widgetId, x.x, x.y, x.width, x.height])).toEqual(FLOW_LAYOUT.widgets.map((x) => [x.widgetId, x.x, x.y, x.width, x.height]))

    await page.reload()
    await expect(page.getByTestId("chart-catalog-status")).toHaveText("success")
    expect(await creatorListIds(page, "cmp0")).toEqual([A.id, B.id, C.id])
    expect(await readStorage(page, ACTIVE_CREATOR_KEY)).toBe(activeBefore)
    evidence.flow1 = { cancelUnchanged: true, draftOnlyBeforeSave: true, canonicalWrites: 1, savedCreatorIds: savedCmp0.comparison!.creatorIds, reloaded: [A.id, B.id, C.id], geometryUnchanged: true, activeCreatorUnchanged: true }
  })
})

test.describe("GAP-9: MT-12 Flow 2 dialog", () => {
  const TWO_WIDGETS_SHUFFLED = {
    grid: { columns: 2, rows: 2 },
    // storage-array order deliberately differs from visual order: the second visual widget is stored first
    widgets: [w("w1", "ranking", 1, 0), w("w0", "kpi-summary", 0, 0)],
  }
  const ONE_WIDGET = { grid: { columns: 2, rows: 2 }, widgets: [w("only", "kpi-summary", 1, 0)] }

  async function gapsAndWidths(page: Page) {
    const rects = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".widget-shell")].map((el) => {
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width }
      }),
    )
    const gaps: number[] = []
    for (const a of rects) for (const b of rects) {
      if (a === b) continue
      const vOverlap = a.y < b.bottom && b.y < a.bottom
      const hOverlap = a.x < b.right && b.x < a.right
      if (vOverlap && b.x > a.x && b.x - a.right < 100) gaps.push(b.x - a.right)
      if (hOverlap && b.y > a.y && b.y - a.bottom < 100) gaps.push(b.y - a.bottom)
    }
    return { minWidth: Math.min(...rects.map((r) => r.width)), gaps }
  }

  test("Scenario 3: visual-order mapping with items in the caller's order, reused widgets keep id and geometry, one atomic write, ordered backend requests, reload keeps mapping", async ({ page }) => {
    await seed(page, TWO_WIDGETS_SHUFFLED)
    const before = await readLayout(page)
    await page.getByRole("button", { name: "Compare Creators" }).click()
    const dialog = page.getByRole("dialog", { name: "Add Comparison Charts" })
    for (const creator of [A, B, C]) await dialog.getByRole("button", { name: creator.name, exact: true }).click()
    // Item order is the caller's (Total views first), not the backend's definition order.
    for (const item of ["Total views", "Daily view growth"]) await dialog.getByRole("button", { name: item }).click()

    expect(await orderBadges(dialog, [A, B, C])).toEqual({ [A.name]: "Comparison order 1|1", [B.name]: "Comparison order 2|2", [C.name]: "Comparison order 3|3" })
    const previewRows = (await dialog.getByTestId("comparison-mapping-row").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim())
    expect(previewRows).toEqual(["Total views → widget[0]", "Daily view growth → widget[1]"])
    expect(await layoutWrites(page)).toBe(0) // the preview writes nothing
    await dialog.getByRole("button", { name: "Save" }).click()
    await expect(dialog).toHaveCount(0)

    await expect(page.getByTestId("comparison-widget")).toHaveCount(2) // rendered at once, no reload
    expect(await layoutWrites(page)).toBe(1) // one atomic transaction
    const after = await readLayout(page)
    const byId = new Map(after.widgets.map((x) => [x.widgetId, x]))
    expect(after.widgets).toHaveLength(2)
    for (const original of before.widgets) {
      const reused = byId.get(original.widgetId)!
      expect([reused.x, reused.y, reused.width, reused.height]).toEqual([original.x, original.y, original.width, original.height])
    }
    expect(byId.get("w0")!.comparison).toEqual({ creatorIds: [A.id, B.id, C.id], comparisonItemIds: [TOTAL] }) // widget[0] = top-left, not storage index 0
    expect(byId.get("w1")!.comparison).toEqual({ creatorIds: [A.id, B.id, C.id], comparisonItemIds: [GROWTH] })

    const { minWidth, gaps } = await gapsAndWidths(page)
    expect(minWidth).toBeGreaterThanOrEqual(240)
    expect(gaps.length).toBeGreaterThan(0)
    for (const gap of gaps) expect(gap).toBe(16)

    // Every request the Dashboard sent carries the configured creator order and only backend-supported items.
    await expect.poll(() => dataCalls(page).length).toBeGreaterThanOrEqual(2)
    const supported = new Set([GROWTH, TOTAL])
    for (const call of dataCalls(page)) {
      expect(call.params.creatorIds).toBe([A, B, C].map((c) => c.backendId).join(","))
      expect(supported.has(call.params.comparisonItemIds)).toBe(true)
    }

    await page.reload()
    await expect(page.getByTestId("chart-catalog-status")).toHaveText("success")
    for (const id of ["w0", "w1"]) expect(await creatorListIds(page, id)).toEqual([A.id, B.id, C.id])
    expect(await page.getByTestId("comparison-widget").evaluateAll((els) => els.map((el) => el.getAttribute("data-comparison-item-id")))).toEqual([TOTAL, GROWTH])
    evidence.flow2 = { previewRows, canonicalWrites: 1, reusedGeometryUnchanged: true, gaps, dataRequests: dataCalls(page).map((c) => c.params) }
  })

  test("Flow 2 appends exactly one widget with a unique id into a free slot without moving the existing widget", async ({ page }) => {
    await seed(page, ONE_WIDGET)
    await page.getByRole("button", { name: "Compare Creators" }).click()
    const dialog = page.getByRole("dialog", { name: "Add Comparison Charts" })
    for (const creator of [A, B]) await dialog.getByRole("button", { name: creator.name, exact: true }).click()
    for (const item of ["Daily view growth", "Total views"]) await dialog.getByRole("button", { name: item }).click()
    await dialog.getByRole("button", { name: "Save" }).click()
    await expect(dialog).toHaveCount(0)

    await expect(page.getByTestId("comparison-widget")).toHaveCount(2)
    expect(await layoutWrites(page)).toBe(1)
    const after = await readLayout(page)
    const existing = after.widgets.find((x) => x.widgetId === "only")!
    const appended = after.widgets.find((x) => x.widgetId !== "only")!
    expect([existing.x, existing.y, existing.width, existing.height]).toEqual([1, 0, 1, 1])
    expect(existing.comparison).toEqual({ creatorIds: [A.id, B.id], comparisonItemIds: [GROWTH] })
    expect(appended.comparison).toEqual({ creatorIds: [A.id, B.id], comparisonItemIds: [TOTAL] })
    expect([appended.x, appended.y, appended.width, appended.height]).toEqual([0, 0, 1, 1])
    expect(new Set(after.widgets.map((x) => x.widgetId)).size).toBe(2)
    const { minWidth, gaps } = await gapsAndWidths(page)
    expect(minWidth).toBeGreaterThanOrEqual(240)
    for (const gap of gaps) expect(gap).toBe(16)
  })

  test("Flow 2 Cancel changes nothing; a failed Save keeps the dialog open and leaves storage and the Dashboard unchanged", async ({ page }) => {
    await seed(page, TWO_WIDGETS_SHUFFLED)
    const raw = await readStorage(page)
    await page.getByRole("button", { name: "Compare Creators" }).click()
    let dialog = page.getByRole("dialog", { name: "Add Comparison Charts" })
    for (const creator of [A, B]) await dialog.getByRole("button", { name: creator.name, exact: true }).click()
    await dialog.getByRole("button", { name: "Daily view growth" }).click()
    await dialog.getByRole("button", { name: "Cancel" }).click()
    await expect(dialog).toHaveCount(0)
    expect(await readStorage(page)).toBe(raw)
    await expect(page.getByTestId("comparison-widget")).toHaveCount(0)

    await page.getByRole("button", { name: "Compare Creators" }).click()
    dialog = page.getByRole("dialog", { name: "Add Comparison Charts" })
    for (const creator of [A, B]) await dialog.getByRole("button", { name: creator.name, exact: true }).click()
    await dialog.getByRole("button", { name: "Daily view growth" }).click()
    await page.evaluate(() => { (window as unknown as { __failLayoutWrite: boolean }).__failLayoutWrite = true })
    await dialog.getByRole("button", { name: "Save" }).click()

    await expect(dialog.getByRole("alert")).toBeVisible()
    await expect(dialog).toBeVisible() // stays open
    expect(await readStorage(page)).toBe(raw)
    await expect(page.getByTestId("comparison-widget")).toHaveCount(0)
    evidence.flow2Failure = { dialogStaysOpen: true, storageUnchanged: true, noWidgetsRendered: true }
  })
})

test.describe("GAP-9: MT-13 Flow 3 creator drag and drop", () => {
  test("Scenario 4: B then C append in order, duplicates and incompatible targets are rejected, cancel/leave change nothing, Save persists", async ({ page }) => {
    await seed(page, FLOW_LAYOUT)
    const canonicalRaw = await readStorage(page)
    const activeBefore = await readStorage(page, ACTIVE_CREATOR_KEY)
    await editButton(page).click()
    const listOrder = () => page.locator(".draggable-creator-list button").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")))
    const sourceBefore = await listOrder()
    const geometryBefore = await gsGeometry(page)
    const target = () => shell(page, "cmp0").locator(".widget-shell")

    const mid = await dragCreator(page, B.name, target())
    expect(mid).toContain("cmp0:active") // compatible chart shows an active target while hovered
    expect(await creatorListIds(page, "cmp0")).toEqual([A.id, B.id])
    await expect(page.getByTestId("dashboard-editor-announcer")).toContainText("added to the comparison at order 2")

    await dragCreator(page, C.name, target())
    expect(await creatorListIds(page, "cmp0")).toEqual([A.id, B.id, C.id])
    expect(await creatorListBadges(page, "cmp0")).toEqual(["Comparison order 1|1", "Comparison order 2|2", "Comparison order 3|3"])

    await dragCreator(page, B.name, target()) // duplicate
    expect(await creatorListIds(page, "cmp0")).toEqual([A.id, B.id, C.id])
    await expect(page.getByTestId("dashboard-editor-announcer")).toContainText("already in this comparison")

    const draftBefore = JSON.stringify(await gsGeometry(page))
    const midIncompatible = await dragCreator(page, C.name, shell(page, "kpi").locator(".widget-shell"))
    expect(midIncompatible).toContain("kpi:disabled") // disabled target shown
    await expect(page.getByTestId("dashboard-editor-announcer")).toContainText("not a comparison chart")
    expect(await creatorListIds(page, "cmp1")).toEqual([A.id, B.id]) // nothing leaked to another chart
    expect(JSON.stringify(await gsGeometry(page))).toBe(draftBefore)

    await dragCreator(page, C.name, shell(page, "cmp1").locator(".widget-shell"), { release: "escape" }) // cancelled drag
    expect(await creatorListIds(page, "cmp1")).toEqual([A.id, B.id])
    await dragCreator(page, C.name, shell(page, "cmp1").locator(".widget-shell"), { release: "outside" }) // left the target
    expect(await creatorListIds(page, "cmp1")).toEqual([A.id, B.id])

    expect(await listOrder()).toEqual(sourceBefore) // source Creator List unchanged
    expect(await readStorage(page)).toBe(canonicalRaw) // canonical unchanged until Save
    expect(await layoutWrites(page)).toBe(0)
    expect(await gsGeometry(page)).toEqual(geometryBefore) // creator drops never change geometry

    await page.getByRole("button", { name: "Save" }).click()
    await expect(editButton(page)).toBeVisible()
    expect(await layoutWrites(page)).toBe(1)
    const saved = await readLayout(page)
    expect(saved.widgets.find((x) => x.widgetId === "cmp0")!.comparison!.creatorIds).toEqual([A.id, B.id, C.id])
    expect(saved.widgets.find((x) => x.widgetId === "cmp1")!.comparison!.creatorIds).toEqual([A.id, B.id])
    expect(saved.widgets.map((x) => [x.widgetId, x.x, x.y, x.width, x.height])).toEqual(FLOW_LAYOUT.widgets.map((x) => [x.widgetId, x.x, x.y, x.width, x.height]))
    expect(await readStorage(page, ACTIVE_CREATOR_KEY)).toBe(activeBefore)

    await page.reload()
    await expect(page.getByTestId("chart-catalog-status")).toHaveText("success")
    expect(await creatorListIds(page, "cmp0")).toEqual([A.id, B.id, C.id])
    evidence.flow3 = { activeTargetShown: true, disabledTargetShown: true, order: [A.id, B.id, C.id], duplicateRejected: true, cancelledUnchanged: true, leftTargetUnchanged: true, sourceListUnchanged: true, savedAndReloaded: true }
  })
})

test.describe("GAP-9: MT-14 request, series, legend and tooltip order (real backend data)", () => {
  test("Scenario 5: one configured creator order drives storage, badges, request, series, legend and tooltip (non-alphabetical, non-roster order), with real snapshot values", async ({ page }) => {
    const ORDER = [C, A, B] // 白上フブキ, Gawr Gura, 兎田ぺこら: not alphabetical, not roster order
    const responsePromise = page.waitForResponse((r) => r.url().includes("/dashboard/comparison-data"))
    await seed(page, { grid: { columns: 2, rows: 1 }, widgets: [cmp("orderChart", 0, 0, ORDER.map((c) => c.id), TOTAL)] })
    const backend = await (await responsePromise).json()

    await expect(shell(page, "orderChart").locator(".recharts-line")).toHaveCount(3)
    const saved = await readLayout(page)
    expect(saved.widgets[0].comparison!.creatorIds).toEqual(ORDER.map((c) => c.id))
    expect(await creatorListIds(page, "orderChart")).toEqual(ORDER.map((c) => c.id))
    expect(await creatorListBadges(page, "orderChart")).toEqual(["Comparison order 1|1", "Comparison order 2|2", "Comparison order 3|3"])

    // The request: creator ids in configured order (backend form), the single item, the Dashboard's report date.
    const calls = dataCalls(page)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[calls.length - 1].params).toMatchObject({ creatorIds: ORDER.map((c) => c.backendId).join(","), comparisonItemIds: TOTAL, reportDate: "2026-09-03" })
    // The real backend answered in that same order, with real stored values.
    expect(backend.items[0].creators.map((c: { creatorId: string }) => c.creatorId)).toEqual(ORDER.map((c) => c.backendId))
    const guraPoints = backend.items[0].creators[1].points
    expect(guraPoints[guraPoints.length - 1]).toEqual({ label: "2026-09-03", value: 1_605_000 })

    const legend = await shell(page, "orderChart").locator(".recharts-legend-item-text").allTextContents()
    expect(legend).toEqual(ORDER.map((c) => c.name))
    const seriesStrokes = await shell(page, "orderChart").locator("path.recharts-line-curve").evaluateAll((els) => els.map((el) => el.getAttribute("stroke")))
    const legendStrokes = await shell(page, "orderChart").locator(".recharts-legend-item .recharts-surface path").evaluateAll((els) => els.map((el) => el.getAttribute("stroke")))
    expect(seriesStrokes).toHaveLength(3)
    expect(legendStrokes.filter(Boolean)).toEqual(seriesStrokes) // series i is legend item i
    await expect(shell(page, "orderChart").getByTestId("comparison-widget-sample-data")).toHaveCount(0) // real data: no sample label

    const plot = (await shell(page, "orderChart").locator(".recharts-wrapper").boundingBox())!
    await page.mouse.move(plot.x + plot.width / 2, plot.y + plot.height / 2 - 10)
    await page.mouse.move(plot.x + plot.width / 2 + 3, plot.y + plot.height / 2 - 10)
    await expect(page.locator(".recharts-tooltip-item-name").first()).toBeVisible()
    const tooltip = await page.locator(".recharts-tooltip-item-name").allTextContents()
    expect(tooltip).toEqual(ORDER.map((c) => c.name))
    evidence.renderOrder = { configured: ORDER.map((c) => c.name), requestCreatorIds: calls[calls.length - 1].params.creatorIds, legend, seriesStrokes, tooltip }
  })
})

test.describe("GAP-9: MT-14 loading, empty, error and unavailable states keep the configuration", () => {
  const STATE_LAYOUT = { grid: { columns: 2, rows: 1 }, widgets: [cmp("state", 0, 0, [A.id, B.id, UNAVAILABLE.id], GROWTH)] }
  const CONFIG = [A.id, B.id, UNAVAILABLE.id]

  async function expectConfigPreserved(page: Page, raw: string | null) {
    expect(await creatorListIds(page, "state")).toEqual(CONFIG)
    expect(await readStorage(page)).toBe(raw)
    expect(await layoutWrites(page)).toBe(0)
  }

  test("Scenario 6a: a creator the backend cannot serve is reported unavailable (real backend), the others still chart, nothing is rewritten", async ({ page }) => {
    await seed(page, STATE_LAYOUT)
    const raw = await readStorage(page)
    const activeBefore = await readStorage(page, ACTIVE_CREATOR_KEY)
    await expect(shell(page, "state").getByTestId(`comparison-chart-issue-${UNAVAILABLE.id}`)).toHaveAttribute("data-status", "unavailable")
    await expect(shell(page, "state").getByTestId(`comparison-chart-issue-${UNAVAILABLE.id}`)).toContainText("No longer available for comparison.")
    await expect(shell(page, "state").locator(".recharts-line")).toHaveCount(2)
    expect(await shell(page, "state").locator(".recharts-legend-item-text").allTextContents()).toEqual([A.name, B.name])
    await expectConfigPreserved(page, raw)
    expect(await readStorage(page, ACTIVE_CREATOR_KEY)).toBe(activeBefore)
    evidence.unavailable = { configPreserved: CONFIG, remainingSeries: [A.name, B.name] }
  })

  test("Scenario 6b: loading keeps the configuration and shows a loading container", async ({ page }) => {
    await forceComparisonData(page, "loading")
    await seed(page, STATE_LAYOUT)
    const raw = await readStorage(page)
    await expect(shell(page, "state").getByTestId("comparison-chart-loading")).toBeVisible()
    await expectConfigPreserved(page, raw)
  })

  test("Scenario 6c: a full error (backend 500) keeps the configuration", async ({ page }) => {
    await forceComparisonData(page, "error")
    await seed(page, STATE_LAYOUT)
    const raw = await readStorage(page)
    await expect(shell(page, "state").getByTestId("comparison-chart-error")).toBeVisible()
    await expectConfigPreserved(page, raw)
  })

  test("Scenario 6d: an empty backend response renders an empty state, not fabricated zero values", async ({ page }) => {
    await forceComparisonData(page, "empty")
    await seed(page, STATE_LAYOUT)
    const raw = await readStorage(page)
    await expect(shell(page, "state").getByTestId("comparison-chart-empty")).toBeVisible()
    await expect(shell(page, "state").locator(".recharts-line")).toHaveCount(0)
    await expectConfigPreserved(page, raw)
  })

  test("Scenario 6e: a partial error names the failed creator and keeps the others' series", async ({ page }) => {
    await forceComparisonData(page, { partialError: [B.backendId] })
    await seed(page, STATE_LAYOUT)
    const raw = await readStorage(page)
    await expect(shell(page, "state").getByTestId(`comparison-chart-issue-${B.id}`)).toHaveAttribute("data-status", "error")
    await expect(shell(page, "state").locator(".recharts-line")).toHaveCount(1) // A ok; B errored; the unavailable creator has no series
    await expectConfigPreserved(page, raw)
  })
})

test.describe("GAP-3+10: MT-14 AC2 -- only backend-supported comparison items", () => {
  test("the backend rejects an unsupported item and the Dashboard never sends one", async ({ page, request }) => {
    const query = (item: string) => `${API}/dashboard/comparison-data?creatorIds=gawr_gura&comparisonItemIds=${item}&reportDate=2026-09-03&timeZone=Asia/Tokyo`
    const rejected = await request.get(query("revenue"))
    expect(rejected.status()).toBe(400)
    expect((await rejected.json()).error).toContain("revenue")
    expect((await request.get(query(TOTAL))).status()).toBe(200)
    const items = (await (await request.get(`${API}/dashboard/comparison-items`)).json()).comparisonItems
    expect(items.map((i: { comparisonItemId: string }) => i.comparisonItemId)).toEqual([GROWTH, TOTAL])

    await seed(page, { grid: { columns: 2, rows: 1 }, widgets: [cmp("a", 0, 0, [A.id, B.id], GROWTH), cmp("b", 1, 0, [A.id, B.id], TOTAL)] })
    await expect(page.locator(".recharts-line")).toHaveCount(4)
    const supported = new Set(items.map((i: { comparisonItemId: string }) => i.comparisonItemId))
    expect(dataCalls(page).length).toBeGreaterThanOrEqual(2)
    for (const call of dataCalls(page)) expect(supported.has(call.params.comparisonItemIds)).toBe(true)
    evidence.mt14Ac2 = { backendItems: items, rejectedStatus: rejected.status(), dashboardRequestedItems: dataCalls(page).map((c) => c.params.comparisonItemIds) }
  })
})

test.afterAll(() => {
  const outDir = path.join(__dirname, "results")
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, "gap9-comparison-evidence.json"), JSON.stringify(evidence, null, 2))
})
