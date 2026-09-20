import { test, expect, type Page } from "@playwright/test"

/** GAP-3 browser evidence: the Dashboard's Add UI is driven by the real
 * backend chart catalog (`GET /dashboard/chart-catalog`, served by the real
 * `api_handler` through scripts/local_api_server.py). Request counts are
 * observed at the network; an "omitted" or failing catalog is produced by
 * intercepting that one request. */

const API = "http://127.0.0.1:8787"
const CORS = { "access-control-allow-origin": "*" }

function trackCatalogRequests(page: Page): string[] {
  const seen: string[] = []
  page.on("request", (request) => {
    if (request.url().startsWith(`${API}/dashboard/chart-catalog`) && request.method() !== "OPTIONS") seen.push(request.url())
  })
  return seen
}

async function openDashboard(page: Page) {
  await page.setViewportSize({ width: 1280, height: 1200 })
  await page.goto("/dashboard")
  await expect(page.getByTestId("chart-catalog-status")).not.toHaveText("loading")
}

const trayButtons = (page: Page) => page.locator(".widget-tray").getByRole("button")

test("the real backend defines the catalog; the Add UI offers exactly those charts and the page requests it once, however often Edit is toggled", async ({ page, request }) => {
  const expected = await (await request.get(`${API}/dashboard/chart-catalog`)).json()
  expect(expected.charts.map((c: { chartDefinitionId: string }) => c.chartDefinitionId)).toEqual(["kpi-summary", "growth-bar-chart", "contribution-ring", "ranking"])

  const seen = trackCatalogRequests(page)
  await openDashboard(page)
  await expect(page.getByTestId("chart-catalog-status")).toHaveText("success")
  expect(seen).toHaveLength(1) // initial page load = one catalog request

  for (let i = 0; i < 4; i++) {
    await page.getByRole("button", { name: "Edit Layout" }).click()
    await expect(trayButtons(page)).toHaveCount(4)
    await page.getByRole("button", { name: "Cancel" }).click()
  }
  expect(seen).toHaveLength(1) // Edit/view cycles never refetch

  await page.getByRole("button", { name: "Edit Layout" }).click()
  const labels = (await trayButtons(page).allTextContents()).map((t) => t.trim())
  for (const title of ["KPI Summary", "Growth Bar Chart", "Channel Contribution", "Rankings"]) expect(labels.some((t) => t.startsWith(title))).toBe(true)
})

test("a chart the backend omits is not offered; the ones it returns are", async ({ page }) => {
  await page.route("**/dashboard/chart-catalog", (route) =>
    route.fulfill({
      status: 200,
      headers: CORS,
      contentType: "application/json",
      body: JSON.stringify({ charts: [{ chartDefinitionId: "kpi-summary", title: "KPI Summary" }, { chartDefinitionId: "growth-bar-chart", title: "Growth Bar Chart" }] }),
    }),
  )
  const seen = trackCatalogRequests(page)
  await openDashboard(page)
  await page.getByRole("button", { name: "Edit Layout" }).click()

  await expect(trayButtons(page)).toHaveCount(2)
  await expect(page.locator(".widget-tray").getByRole("button", { name: /KPI Summary/ })).toBeVisible()
  await expect(page.locator(".widget-tray").getByRole("button", { name: /Growth Bar Chart/ })).toBeVisible()
  await expect(page.locator(".widget-tray").getByRole("button", { name: /Rankings/ })).toHaveCount(0)
  await expect(page.locator(".widget-tray").getByRole("button", { name: /Channel Contribution/ })).toHaveCount(0)
  expect(seen).toHaveLength(1)
})

test("a catalog failure leaves the existing widgets in place and says Add is unavailable", async ({ page }) => {
  await page.route("**/dashboard/chart-catalog", (route) => route.fulfill({ status: 500, headers: CORS, contentType: "application/json", body: JSON.stringify({ error: "Internal server error" }) }))
  await openDashboard(page)
  await expect(page.getByTestId("chart-catalog-status")).toHaveText("error")
  await expect(page.getByText("Daily Gain").first()).toBeVisible()
  await page.getByRole("button", { name: "Edit Layout" }).click()
  await expect(page.getByTestId("widget-tray-status")).toContainText("Couldn't load")
  await expect(trayButtons(page)).toHaveText(["Retry"]) // no chart is offered; only the explicit retry action
  await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(4)
})

test("the plain dev server ships no hard-coded catalog, no mock comparison source and no test switches", async ({ request }) => {
  const catalog = await (await request.get("/src/lib/dashboardChartCatalogSource.ts")).text()
  expect(catalog).toContain("/dashboard/chart-catalog")
  expect(catalog).not.toMatch(/kpi-summary|growth-bar-chart|contribution-ring/)
  const wiring = await (await request.get("/src/lib/defaultComparisonSource.ts")).text()
  expect(wiring).toContain("createBackendComparisonSource")
  for (const file of ["/src/lib/backendComparisonSource.ts", "/src/lib/dashboardComparisonSource.ts", "/src/lib/defaultComparisonSource.ts", "/src/lib/dashboardChartCatalogSource.ts"]) {
    const text = await (await request.get(file)).text()
    expect(text, file).not.toMatch(/localStorage|__yobi|__e2e|fakeComparisonSource|MOCK_COMPARISON/)
  }
})
