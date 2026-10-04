import { beforeEach, describe, expect, it, vi } from "vitest"
import { OSHI_STATUS_RECENT_LIMIT, buildOshiStatusPath, fetchOshiStatus } from "./oshiStatus"
import { apiRequest } from "../../../shared/api/apiClient"

vi.mock("../../../shared/api/apiClient", () => ({ apiRequest: vi.fn() }))

const FULL_RESPONSE = {
  reportDate: "2026-10-01",
  generatedAt: "2026-10-01T09:05:00+00:00",
  creatorId: "aizawa_ema",
  subscriberCount: 123456,
  latestVideo: { videoId: "u1", title: "Latest upload", thumbnailUrl: "https://img/u1.jpg", publishedAt: "2026-09-30T00:00:00Z", currentViewCount: 900 },
  thisWeek: { newUploads: 2, newStreams: 3 },
  growth: {
    "1d": { absoluteGrowth: 10, videoCount: 5 },
    "7d": { absoluteGrowth: 700, videoCount: 40 },
    "30d": { absoluteGrowth: 3000, videoCount: 90 },
  },
  recent: [
    { videoId: "u1", kind: "upload", title: "Latest upload", thumbnailUrl: "https://img/u1.jpg", publishedAt: "2026-09-30T00:00:00Z", currentViewCount: 900 },
    { videoId: "s1", kind: "livestream", title: "A stream", thumbnailUrl: null, publishedAt: "2026-09-29T00:00:00Z", currentViewCount: 50 },
  ],
  sinceLastVisit: { since: "2026-09-25T00:00:00+00:00", clamped: false, newUploads: 4, newStreams: 1 },
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset()
})

function parse(path: string) {
  const url = new URL(path, "https://example.test")
  return { pathname: url.pathname, params: Object.fromEntries(url.searchParams) }
}

describe("buildOshiStatusPath", () => {
  it("scopes the path to the creator and always asks for the 6 recent rows", () => {
    const { pathname, params } = parse(buildOshiStatusPath("aizawa_ema", null))

    expect(pathname).toBe("/creators/aizawa_ema/oshi-status")
    expect(params).toEqual({ recentLimit: "6" })
    expect(OSHI_STATUS_RECENT_LIMIT).toBe(6)
  })

  it("a first visit (no stored last visit) omits `since`", () => {
    expect(parse(buildOshiStatusPath("aizawa_ema", null)).params).not.toHaveProperty("since")
  })

  it("sends the stored last visit as an ISO UTC timestamp", () => {
    const lastVisit = new Date("2026-09-25T09:30:00+09:00")

    expect(parse(buildOshiStatusPath("aizawa_ema", lastVisit)).params.since).toBe("2026-09-25T00:30:00.000Z")
  })

  it("encodes the creator id into the path", () => {
    expect(parse(buildOshiStatusPath("a/b c", null)).pathname).toBe("/creators/a%2Fb%20c/oshi-status")
  })
})

describe("fetchOshiStatus", () => {
  it("maps the backend fields the panel uses and exposes no raw history", async () => {
    vi.mocked(apiRequest).mockResolvedValue(FULL_RESPONSE)

    const status = await fetchOshiStatus("aizawa_ema", new Date("2026-09-25T00:00:00Z"))

    expect(vi.mocked(apiRequest).mock.calls[0][0]).toContain("/creators/aizawa_ema/oshi-status?")
    expect(status.subscriberCount).toBe(123456)
    expect(status.thisWeek).toEqual({ newUploads: 2, newStreams: 3 })
    expect(status.growth["7d"]).toEqual({ absoluteGrowth: 700, videoCount: 40 })
    expect(status.sinceLastVisit).toEqual({ newUploads: 4, newStreams: 1, clamped: false })
    expect(status.recent.map((row) => [row.videoId, row.kind, row.thumbnailUrl])).toEqual([
      ["u1", "upload", "https://img/u1.jpg"],
      ["s1", "livestream", null],
    ])
    // latestVideo carries no growth fields (they were removed from the backend contract on purpose)
    expect(Object.keys(status.latestVideo!).sort()).toEqual(["currentViewCount", "publishedAt", "thumbnailUrl", "title", "videoId"])
    expect(JSON.stringify(status)).not.toContain("anchor")
  })

  it("keeps a null subscriber count null -- never a fabricated 0", async () => {
    vi.mocked(apiRequest).mockResolvedValue({ ...FULL_RESPONSE, subscriberCount: null })

    expect((await fetchOshiStatus("aizawa_ema", null)).subscriberCount).toBeNull()
  })

  it("a first-visit response has no sinceLastVisit block", async () => {
    vi.mocked(apiRequest).mockResolvedValue({ ...FULL_RESPONSE, sinceLastVisit: null })

    expect((await fetchOshiStatus("aizawa_ema", null)).sinceLastVisit).toBeNull()
  })

  it("handles an empty creator: no latest video and no recent rows", async () => {
    vi.mocked(apiRequest).mockResolvedValue({ ...FULL_RESPONSE, latestVideo: null, recent: [] })

    const status = await fetchOshiStatus("aizawa_ema", null)

    expect(status.latestVideo).toBeNull()
    expect(status.recent).toEqual([])
  })

  it("skips a malformed recent row instead of failing the whole panel", async () => {
    vi.mocked(apiRequest).mockResolvedValue({ ...FULL_RESPONSE, recent: [{ title: "no id" }, FULL_RESPONSE.recent[0]] })

    expect((await fetchOshiStatus("aizawa_ema", null)).recent.map((row) => row.videoId)).toEqual(["u1"])
  })

  it("propagates a request failure (no fallback data)", async () => {
    vi.mocked(apiRequest).mockRejectedValue(new Error("boom"))

    await expect(fetchOshiStatus("aizawa_ema", null)).rejects.toThrow("boom")
  })
})
