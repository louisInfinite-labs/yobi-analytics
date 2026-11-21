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

  it("carries the never-started list (a confirmed abandoned waiting room the backend no longer lists) on the returned array, next to recentlyEnded, when supplied", async () => {
    const neverStarted = [{ videoId: "v9", confirmedAt: "2026-11-17T01:00:00Z" }]
    const recentlyEnded = [{ videoId: "v0", confirmedEndedAt: "2026-10-16T03:00:00Z" }]
    vi.mocked(apiClient.apiRequest).mockResolvedValue({ streams: [], recentlyEnded, neverStarted })

    const result = await fetchLiveStreams()

    expect(result.neverStarted).toEqual(neverStarted)
    expect(result.recentlyEnded).toEqual(recentlyEnded) // the two lists are independent: a never-started stream is not an ended one
  })

  it("leaves neverStarted undefined when the response has none (nothing to release), and ignores a malformed value", async () => {
    vi.mocked(apiClient.apiRequest).mockResolvedValue({ streams: [] })
    expect("neverStarted" in (await fetchLiveStreams())).toBe(false)

    vi.mocked(apiClient.apiRequest).mockResolvedValue({ streams: [], neverStarted: "nope" })
    expect("neverStarted" in (await fetchLiveStreams())).toBe(false)
  })
})
