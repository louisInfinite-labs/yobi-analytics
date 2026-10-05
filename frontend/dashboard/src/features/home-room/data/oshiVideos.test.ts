import { beforeEach, describe, expect, it, vi } from "vitest"
import { fetchOshiVideos } from "./oshiVideos"
import { ApiError, apiRequest } from "../../../shared/api/apiClient"
import type { OshiVideosQuery } from "../model/oshiVideosQuery"

vi.mock("../../../shared/api/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shared/api/apiClient")>()),
  apiRequest: vi.fn(),
}))

const query: OshiVideosQuery = { creatorId: "aizawa_ema", topic: "sf6", contentType: "live", sort: "newest", viewWindow: "total" }

beforeEach(() => {
  vi.mocked(apiRequest).mockReset()
})

describe("fetchOshiVideos", () => {
  it("pages the archive endpoint and maps live to live_archive and uploads to normal_video", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      videos: [
        { videoId: "s1", title: "stream", publishedAt: "2026-09-02T00:00:00Z", contentType: "live", currentViewCount: 1200 },
        { videoId: "u1", title: "upload", publishedAt: "2026-09-01T00:00:00Z", contentType: "upload", currentViewCount: 50 },
      ],
      hasMore: true,
    })

    const page = await fetchOshiVideos(query, 20)

    expect(vi.mocked(apiRequest).mock.calls[0][0]).toContain("/creators/aizawa_ema/videos/recent?")
    expect(vi.mocked(apiRequest).mock.calls[0][0]).toContain("offset=20")
    expect(page.nextOffset).toBe(22)
    expect(page.hasMore).toBe(true)
    expect(page.videos).toEqual([
      { videoId: "s1", title: "stream", publishedAt: "2026-09-02T00:00:00Z", contentFormat: "live_archive", viewCount: 1200 },
      { videoId: "u1", title: "upload", publishedAt: "2026-09-01T00:00:00Z", contentFormat: "normal_video", viewCount: 50 },
    ])
  })

  it("reads the ranking endpoint as one bounded, unpaged response in the server's order", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      rows: [
        { videoId: "b", title: "second place", publishedAt: "2026-09-01T00:00:00Z", contentType: "live", currentViewCount: 900 },
        { videoId: "a", title: null, publishedAt: null, contentType: null, currentViewCount: 100 },
      ],
    })

    const page = await fetchOshiVideos({ ...query, sort: "mostViews", viewWindow: "7d" })

    expect(vi.mocked(apiRequest).mock.calls[0][0]).toContain("/creators/aizawa_ema/videos/ranking?")
    expect(vi.mocked(apiRequest).mock.calls[0][0]).toContain("metric=7d")
    expect(page.hasMore).toBe(false)
    expect(page.videos.map((video) => video.videoId)).toEqual(["b", "a"]) // not re-sorted in the browser
    // Missing fields degrade (blank title, epoch date, plain video) instead of dropping the card.
    expect(page.videos[1]).toMatchObject({ title: "", publishedAt: new Date(0).toISOString(), contentFormat: "normal_video" })
  })

  it("propagates a request failure to the caller (no fallback data)", async () => {
    vi.mocked(apiRequest).mockRejectedValue(new Error("boom"))

    await expect(fetchOshiVideos(query)).rejects.toThrow("boom")
  })

  it.each([
    ["the paged recent endpoint", query],
    ["the ranking endpoint", { ...query, sort: "mostViews" as const, viewWindow: "7d" as const }],
  ])("renders a creator with unavailable historical data as an empty shelf (%s)", async (_label, shelfQuery) => {
    vi.mocked(apiRequest).mockRejectedValue(new ApiError(404, "unavailable", "HISTORICAL_DATA_UNAVAILABLE"))

    await expect(fetchOshiVideos(shelfQuery, 0)).resolves.toEqual({ videos: [], nextOffset: 0, hasMore: false })
  })

  it("still surfaces a real 503 or 500 as an error, and a 404 without the domain code too", async () => {
    for (const error of [new ApiError(503, "x", "RANKING_NOT_READY"), new ApiError(500, "x"), new ApiError(404, "x")]) {
      vi.mocked(apiRequest).mockRejectedValueOnce(error)
      await expect(fetchOshiVideos(query)).rejects.toBe(error)
    }
  })
})
