import { beforeEach, describe, expect, it, vi } from "vitest"
import { apiRequest } from "../../../shared/api/apiClient"
import { fetchOshiVideos } from "./oshiVideos"
import { buildShelfQuery, HOME_ALL_DEFAULT_CONTROLS } from "../model/oshiVideosQuery"

vi.mock("../../../shared/api/apiClient", async () => ({ apiRequest: vi.fn(), isHistoricalDataUnavailable: () => false }))

const all = buildShelfQuery("all", "aizawa_ema", HOME_ALL_DEFAULT_CONTROLS)!
const row = { videoId: "v1", title: "t", contentType: null, currentViewCount: 1, publishedAt: "2026-10-17T00:00:00Z", discoveredAt: "2026-10-17T01:00:00Z" }

describe("fetchOshiVideos newContent", () => {
  beforeEach(() => vi.mocked(apiRequest).mockReset())

  it("returns the exact id groups of the whole list and keeps discoveredAt and the NULL contentType as sent", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      videos: [row],
      hasMore: true,
      newContent: { counts: { videos: 2, livestreams: 1, unclassified: 1 }, videoIds: "a,b", livestreamIds: "s1", unclassifiedIds: "x1" },
    })

    const page = await fetchOshiVideos(all, 0, { newSince: "2026-10-16T23:00:00.500Z" })

    expect(vi.mocked(apiRequest).mock.calls[0][0]).toContain("newSince=2026-10-16T23%3A00%3A00.500Z")
    expect(page.newContent).toEqual({ videoIds: ["a", "b"], livestreamIds: ["s1"], unclassifiedIds: ["x1"] })
    expect(page.videos[0]).toMatchObject({ discoveredAt: "2026-10-17T01:00:00Z" })
  })

  it("a backend without newContent (older deployment) yields no eligibility rather than a fake zero", async () => {
    vi.mocked(apiRequest).mockResolvedValue({ videos: [row], hasMore: false })

    expect((await fetchOshiVideos(all, 0, { newSince: "2026-10-16T23:00:00.500Z" })).newContent).toBeUndefined()
  })
})
