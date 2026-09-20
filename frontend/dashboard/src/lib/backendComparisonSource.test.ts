import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createBackendComparisonSource, fromBackendCreatorId, toBackendCreatorId } from "./backendComparisonSource"
import { fetchChartCatalog } from "./dashboardChartCatalogSource"
import { defaultComparisonSource } from "./defaultComparisonSource"
import { ApiError } from "./apiClient"
import backendSourceText from "./backendComparisonSource.ts?raw"
import comparisonSourceText from "./dashboardComparisonSource.ts?raw"
import defaultSourceText from "./defaultComparisonSource.ts?raw"
import catalogSourceText from "./dashboardChartCatalogSource.ts?raw"
import pageText from "../components/DashboardPage.tsx?raw"
import widgetText from "../components/ComparisonWidget.tsx?raw"
import itemsHookText from "../hooks/useComparisonItems.ts?raw"

const CONTEXT = { reportDate: "2026-09-07", timeZone: "Asia/Tokyo" }

function respondWith(status: number, body: unknown) {
  const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })))
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

beforeEach(() => vi.stubEnv("VITE_API_BASE_URL", "https://api.test"))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const requestedUrl = (fetchMock: ReturnType<typeof vi.fn>) => new URL((fetchMock.mock.calls[0] as unknown as [string])[0])

describe("fetchChartCatalog", () => {
  it("GETs /dashboard/chart-catalog and returns the backend's charts as-is", async () => {
    const charts = [{ chartDefinitionId: "kpi-summary", title: "KPI Summary" }]
    const fetchMock = respondWith(200, { charts })

    await expect(fetchChartCatalog()).resolves.toEqual(charts)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(requestedUrl(fetchMock).pathname).toBe("/dashboard/chart-catalog")
  })

  it("surfaces a backend failure instead of substituting a local list", async () => {
    respondWith(500, { error: "Internal server error" })
    await expect(fetchChartCatalog()).rejects.toBeInstanceOf(ApiError)
  })
})

describe("createBackendComparisonSource", () => {
  const source = createBackendComparisonSource(() => CONTEXT)

  it("is a backend source (its values are real, not sample data)", () => {
    expect(source.origin).toBe("backend")
    expect(defaultComparisonSource.origin).toBe("backend")
  })

  it("loadItems GETs /dashboard/comparison-items and returns exactly what the backend defines", async () => {
    const comparisonItems = [{ comparisonItemId: "daily-view-growth", label: "Daily view growth" }]
    const fetchMock = respondWith(200, { comparisonItems })

    await expect(source.loadItems()).resolves.toEqual(comparisonItems)
    expect(requestedUrl(fetchMock).pathname).toBe("/dashboard/comparison-items")
  })

  it("fetchData sends creator ids (backend form) and item ids in exactly the caller's order, never sorted", async () => {
    const fetchMock = respondWith(200, { items: [{ comparisonItemId: "total-views", creators: [] }] })

    await source.fetchData({ creatorIds: ["ch_usada_pekora", "ch_aizawa_ema", "ch_gawr_gura"], comparisonItemIds: ["total-views", "daily-view-growth"] })

    const url = requestedUrl(fetchMock)
    expect(url.pathname).toBe("/dashboard/comparison-data")
    expect(url.searchParams.get("creatorIds")).toBe("usada_pekora,aizawa_ema,gawr_gura")
    expect(url.searchParams.get("comparisonItemIds")).toBe("total-views,daily-view-growth")
    expect(url.searchParams.get("reportDate")).toBe("2026-09-07")
    expect(url.searchParams.get("timeZone")).toBe("Asia/Tokyo")
  })

  it("maps the response back to roster ids in request order and keeps every status without fabricating points", async () => {
    respondWith(200, {
      items: [
        {
          comparisonItemId: "total-views",
          creators: [
            { creatorId: "gawr_gura", status: "ok", points: [{ label: "2026-09-07", value: 12 }] },
            { creatorId: "vspo_en_member", status: "unavailable" },
            { creatorId: "airani_iofifteen", status: "error" },
          ],
        },
      ],
    })

    const response = await source.fetchData({ creatorIds: ["ch_gawr_gura", "ch_vspo_en_member", "ch_iofi"], comparisonItemIds: ["total-views"] })

    expect(response.creators).toEqual([
      { status: "ok", creatorId: "ch_gawr_gura", points: [{ label: "2026-09-07", value: 12 }] },
      { status: "unavailable", creatorId: "ch_vspo_en_member" },
      { status: "error", creatorId: "airani_iofifteen" }, // unmatched backend id is passed through, never invented
    ])
  })

  it("returns the empty state for an empty backend item", async () => {
    respondWith(200, { items: [{ comparisonItemId: "total-views", creators: [] }] })
    await expect(source.fetchData({ creatorIds: ["ch_gawr_gura"], comparisonItemIds: ["total-views"] })).resolves.toEqual({ creators: [] })
  })

  it("propagates a backend rejection (unsupported item) as an error, not as data", async () => {
    respondWith(400, { error: "Unsupported comparisonItemIds: ['revenue']" })
    await expect(source.fetchData({ creatorIds: ["ch_gawr_gura"], comparisonItemIds: ["revenue"] })).rejects.toMatchObject({ status: 400 })
  })

  it("translates roster ids to backend ids at the boundary only", () => {
    expect(toBackendCreatorId("ch_gawr_gura")).toBe("gawr_gura")
    expect(toBackendCreatorId("gawr_gura")).toBe("gawr_gura")
    expect(fromBackendCreatorId("gawr_gura", ["ch_iofi", "ch_gawr_gura"])).toBe("ch_gawr_gura")
  })
})

describe("production comparison and catalog code carries no mock data and no hidden control surface", () => {
  it("has no storage-driven scenarios, test globals or environment switches", () => {
    for (const text of [backendSourceText, comparisonSourceText, defaultSourceText, catalogSourceText, itemsHookText, widgetText]) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
      expect(code).not.toMatch(/localStorage|sessionStorage|globalThis|__yobi|__e2e|import\.meta\.env\.(MODE|DEV)/)
    }
  })

  it("has no hard-coded catalog or comparison-item list, and does not import the test fake", () => {
    expect(catalogSourceText).not.toMatch(/kpi-summary|growth-bar-chart|contribution-ring/)
    for (const text of [backendSourceText, comparisonSourceText, defaultSourceText, pageText, itemsHookText]) {
      expect(text).not.toMatch(/fakeComparisonSource|test\/fake|"revenue"|"engagement"|"growth"|MOCK_COMPARISON/)
    }
  })
})
