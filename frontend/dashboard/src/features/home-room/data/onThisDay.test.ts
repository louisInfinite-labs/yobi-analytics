import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildOnThisDayPath, fetchOnThisDay } from "./onThisDay"

vi.stubEnv("VITE_API_BASE_URL", "http://localhost")

const FILTERS = { topic: "all", contentType: "all", excludeShorts: true } as const

function respond(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: status < 400, status, json: () => Promise.resolve(body) }))
}

afterEach(() => vi.unstubAllGlobals())

describe("buildOnThisDayPath", () => {
  it("always asks in the Tokyo zone and carries the filters as the backend names them", () => {
    const params = new URL(buildOnThisDayPath("emma", { month: 2, day: 29 }, { topic: "mv", contentType: "live", excludeShorts: true }), "http://x").searchParams
    expect(params.get("month")).toBe("2")
    expect(params.get("day")).toBe("29")
    expect(params.get("timeZone")).toBe("Asia/Tokyo")
    expect([params.get("topic"), params.get("contentType"), params.get("excludeShorts")]).toEqual(["mv", "live", "true"])
  })

  it("encodes the creator id into the path", () => {
    expect(buildOnThisDayPath("a/b", { month: 1, day: 1 }, FILTERS).startsWith("/creators/a%2Fb/videos/on-this-day?")).toBe(true)
  })
})

describe("fetchOnThisDay", () => {
  beforeEach(() => respond(200, {}))

  it("maps years, dates and coverage and drops nothing the view needs", async () => {
    respond(200, {
      years: [{ year: 2024, videos: [{ videoId: "v1", title: "T", topic: "mv", contentType: "live", currentViewCount: 7, date: "2024-03-15", eventAt: "2024-03-14T16:30:00+00:00", dateKind: "actualStart" }] }],
      total: 1,
      truncated: false,
      coverage: { catalogStart: "2019-07-18", undatedLivestreams: 4 },
    })

    const result = await fetchOnThisDay("emma", { month: 3, day: 15 }, FILTERS)

    expect(result.unavailable).toBe(false)
    expect(result.coverage).toEqual({ catalogStart: "2019-07-18", undatedLivestreams: 4 })
    expect(result.years[0].videos[0]).toEqual({ videoId: "v1", title: "T", topic: "mv", contentType: "live", viewCount: 7, date: "2024-03-15", eventAt: "2024-03-14T16:30:00+00:00", dateKind: "actualStart" })
  })

  it("a creator with no historical catalog is a valid empty answer flagged unavailable, not an error", async () => {
    respond(404, { error: "Historical data unavailable", code: "HISTORICAL_DATA_UNAVAILABLE" })
    const result = await fetchOnThisDay("emma", { month: 3, day: 15 }, FILTERS)
    expect(result).toMatchObject({ unavailable: true, total: 0, years: [] })
  })

  it("any other failure is an error (never rendered as no videos)", async () => {
    respond(500, { error: "boom" })
    await expect(fetchOnThisDay("emma", { month: 3, day: 15 }, FILTERS)).rejects.toThrow()
  })
})
