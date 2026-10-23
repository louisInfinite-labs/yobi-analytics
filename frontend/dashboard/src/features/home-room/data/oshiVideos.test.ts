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
      { videoId: "s1", title: "stream", publishedAt: "2026-09-02T00:00:00Z", contentFormat: "live_archive", viewCount: 1200, thumbnailUrl: null, discoveredAt: null },
      { videoId: "u1", title: "upload", publishedAt: "2026-09-01T00:00:00Z", contentFormat: "normal_video", viewCount: 50, thumbnailUrl: null, discoveredAt: null },
    ])
  })

  it("maps the backend's contentType=short to the shorts format, and never guesses it from the title", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      videos: [
        { videoId: "sh1", title: "plain title", publishedAt: "2026-09-02T00:00:00Z", contentType: "short", currentViewCount: 10 },
        { videoId: "u2", title: "talk #shorts", publishedAt: "2026-09-01T00:00:00Z", contentType: "upload", currentViewCount: 5 },
      ],
      hasMore: false,
    })

    const page = await fetchOshiVideos({ ...query, topic: "all", contentType: "short" })

    expect(vi.mocked(apiRequest).mock.calls[0][0]).toContain("contentType=short")
    expect(page.videos.map((video) => video.contentFormat)).toEqual(["shorts", "normal_video"])
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

describe("fetchOshiVideos: provisional rows", () => {
  const fetchRows = async (videos: unknown[]) => {
    vi.mocked(apiRequest).mockResolvedValue({ videos, hasMore: false })
    return (await fetchOshiVideos({ ...query, contentType: "all" })).videos
  }

  it("an announced Premiere's provisional row (scheduled start, no contentType, no confirmed archive) is a not-watchable premiere ordered by its scheduled start", async () => {
    const [row] = await fetchRows([
      { videoId: "p1", title: "t", publishedAt: "2026-10-23T10:00:00+00:00", scheduledStart: "2026-10-23T10:00:00+00:00", contentType: null, provisional: true, currentViewCount: 0, discoveredAt: "2026-10-23T04:00:00+09:00" },
    ])

    expect(row).toMatchObject({ videoId: "p1", contentFormat: "premiere", eventAt: "2026-10-23T10:00:00+00:00", announcedPremiere: true })
  })

  it("an ordinary provisional row (no scheduled start) and the verified-archive overlay row keep their established mapping", async () => {
    const [ordinary, overlay, withArchiveTime] = await fetchRows([
      { videoId: "o1", title: "t", publishedAt: "2026-10-23T03:00:00Z", contentType: null, provisional: true, currentViewCount: 0 },
      { videoId: "a1", title: "t", publishedAt: "2026-10-23T03:00:00Z", contentType: "upload", provisional: true, archiveAvailableAt: "2026-10-23T05:00:00Z", currentViewCount: 0 },
      { videoId: "p2", title: "t", publishedAt: "2026-10-23T10:00:00Z", scheduledStart: "2026-10-23T10:00:00Z", contentType: null, provisional: true, archiveAvailableAt: "2026-10-23T12:00:00Z", currentViewCount: 0 },
    ])

    expect(ordinary).toMatchObject({ contentFormat: "normal_video" })
    expect(ordinary.announcedPremiere).toBeUndefined()
    expect(overlay).toMatchObject({ contentFormat: "normal_video", archiveAvailableAt: "2026-10-23T05:00:00Z" })
    expect(overlay.announcedPremiere).toBeUndefined()
    expect(withArchiveTime).toMatchObject({ contentFormat: "normal_video" }) // a confirmed archive time makes the announced row a normal, watchable video
    expect(withArchiveTime.announcedPremiere).toBeUndefined()
  })
})
