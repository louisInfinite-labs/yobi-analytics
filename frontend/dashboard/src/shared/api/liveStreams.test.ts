import { describe, expect, it, vi } from "vitest"
import { fetchLiveStreams } from "./liveStreams"
import * as apiClient from "./apiClient"

vi.mock("./apiClient", () => ({ apiRequest: vi.fn() }))

describe("fetchLiveStreams", () => {
  it("calls GET /live-streams and returns its streams array", async () => {
    const streams = [
      {
        videoId: "v1",
        creatorId: "aizawa_ema",
        channelName: "藍沢エマ",
        title: "Test",
        status: "live" as const,
        scheduledStart: null,
        actualStart: "2026-09-29T10:00:00Z",
        thumbnailUrl: "https://img.youtube.com/vi/v1/hqdefault.jpg",
      },
    ]
    vi.mocked(apiClient.apiRequest).mockResolvedValue({ streams })

    const result = await fetchLiveStreams()

    expect(apiClient.apiRequest).toHaveBeenCalledWith("/live-streams")
    expect(result).toBe(streams)
  })
  it("carries the backend's confirmed-ended list on the returned array when the backend supplies it", async () => {
    const recentlyEnded = [{ videoId: "v0", creatorId: "aizawa_ema", confirmedEndedAt: "2026-10-16T03:00:00Z", archive: { status: "pending", attempts: 0 } }]
    vi.mocked(apiClient.apiRequest).mockResolvedValue({ streams: [], recentlyEnded })

    const result = await fetchLiveStreams()

    expect([...result]).toEqual([]) // the streams themselves are untouched
    expect(result.recentlyEnded).toEqual(recentlyEnded)
  })

  it("leaves it undefined -- 'the backend sent no end signal', not 'nothing ended' -- when the response has no such field", async () => {
    vi.mocked(apiClient.apiRequest).mockResolvedValue({ streams: [] })

    const result = await fetchLiveStreams()

    expect("recentlyEnded" in result).toBe(false)
  })
})
