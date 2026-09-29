import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { acquireLiveStreamsPolling, liveStreamsStore } from "./liveStreamsStore"
import * as liveStreams from "./liveStreams"

vi.mock("./liveStreams", () => ({ fetchLiveStreams: vi.fn() }))

const STREAM = {
  videoId: "v1",
  creatorId: "aizawa_ema",
  channelName: "藍沢エマ",
  title: "Test",
  status: "live" as const,
  scheduledStart: null,
  actualStart: "2026-09-29T10:00:00Z",
  thumbnailUrl: "https://img.youtube.com/vi/v1/hqdefault.jpg",
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  vi.mocked(liveStreams.fetchLiveStreams).mockResolvedValue([STREAM])
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("liveStreamsStore polling", () => {
  it("fetches once on first subscriber and updates the shared store", async () => {
    const release = acquireLiveStreamsPolling()
    await vi.waitFor(() => expect(liveStreamsStore.get().isLoading).toBe(false))

    expect(liveStreams.fetchLiveStreams).toHaveBeenCalledTimes(1)
    expect(liveStreamsStore.get()).toEqual({ streams: [STREAM], isLoading: false, error: null })

    release()
  })

  it("does not start a second fetch/poll for a second simultaneous subscriber", async () => {
    const releaseA = acquireLiveStreamsPolling()
    const releaseB = acquireLiveStreamsPolling()
    await vi.waitFor(() => expect(liveStreams.fetchLiveStreams).toHaveBeenCalledTimes(1))

    await vi.advanceTimersByTimeAsync(60_000)
    expect(liveStreams.fetchLiveStreams).toHaveBeenCalledTimes(2)

    releaseA()
    releaseB()
  })

  it("stops polling only once every subscriber has released", async () => {
    const releaseA = acquireLiveStreamsPolling()
    const releaseB = acquireLiveStreamsPolling()
    await vi.waitFor(() => expect(liveStreams.fetchLiveStreams).toHaveBeenCalledTimes(1))

    releaseA()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(liveStreams.fetchLiveStreams).toHaveBeenCalledTimes(2) // still polling -- releaseB is still held

    releaseB()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(liveStreams.fetchLiveStreams).toHaveBeenCalledTimes(2) // no more polling once the last subscriber released
  })

  it("keeps the previous streams and surfaces an error when a refresh fails", async () => {
    const release = acquireLiveStreamsPolling()
    await vi.waitFor(() => expect(liveStreamsStore.get().isLoading).toBe(false))

    vi.mocked(liveStreams.fetchLiveStreams).mockRejectedValueOnce(new Error("network down"))
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(liveStreamsStore.get().error).toBe("network down"))

    expect(liveStreamsStore.get().streams).toEqual([STREAM])

    release()
  })
})
