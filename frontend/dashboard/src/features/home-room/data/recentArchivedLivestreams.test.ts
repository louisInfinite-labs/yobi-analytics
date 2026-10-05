import { beforeEach, describe, expect, it, vi } from "vitest"
import { fetchArchivedLivestreams } from "./recentArchivedLivestreams"
import { ApiError, apiRequest } from "../../../shared/api/apiClient"

vi.mock("../../../shared/api/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shared/api/apiClient")>()),
  apiRequest: vi.fn(),
}))

beforeEach(() => {
  vi.mocked(apiRequest).mockReset()
})

describe("fetchArchivedLivestreams", () => {
  it("maps a normal response to live archives and pages by offset", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      videos: [{ videoId: "s1", title: "stream", publishedAt: "2026-09-02T00:00:00Z", contentType: "live", liveStatus: "completed", currentViewCount: 7 }],
      hasMore: true,
    })

    const page = await fetchArchivedLivestreams("aizawa_ema", { offset: 20 })

    expect(page).toMatchObject({ nextOffset: 21, hasMore: true })
    expect(page.videos[0]).toMatchObject({ videoId: "s1", contentFormat: "live_archive", viewCount: 7 })
  })

  it("renders a creator with unavailable historical data as an empty archive, not an error", async () => {
    vi.mocked(apiRequest).mockRejectedValue(new ApiError(404, "unavailable", "HISTORICAL_DATA_UNAVAILABLE"))

    await expect(fetchArchivedLivestreams("mano_aloe", { offset: 0 })).resolves.toEqual({ videos: [], nextOffset: 0, hasMore: false })
  })

  it("still surfaces a real 503 or 500 as an error", async () => {
    for (const error of [new ApiError(503, "x", "RANKING_NOT_READY"), new ApiError(500, "x")]) {
      vi.mocked(apiRequest).mockRejectedValueOnce(error)
      await expect(fetchArchivedLivestreams("aizawa_ema")).rejects.toBe(error)
    }
  })
})
