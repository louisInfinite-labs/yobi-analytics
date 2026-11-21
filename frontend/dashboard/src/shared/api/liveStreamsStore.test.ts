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

describe("liveStreamsStore recentlyEnded", () => {
  it("puts the backend's confirmed-ended list in the shared state, and omits it when the response had none", async () => {
    const recentlyEnded = [{ videoId: "v0", confirmedEndedAt: "2026-10-16T03:00:00Z" }]
    vi.mocked(liveStreams.fetchLiveStreams).mockResolvedValue(Object.assign([STREAM], { recentlyEnded }))
    const release = acquireLiveStreamsPolling()
    await vi.waitFor(() => expect(liveStreamsStore.get().isLoading).toBe(false))
    expect(liveStreamsStore.get()).toEqual({ streams: [STREAM], recentlyEnded, isLoading: false, error: null, fetchedThisSession: true })

    vi.mocked(liveStreams.fetchLiveStreams).mockResolvedValue([STREAM])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(liveStreamsStore.get()).toEqual({ streams: [STREAM], isLoading: false, error: null, fetchedThisSession: true }) // unknown again, not "none ended"

    release()
  })

  it("keeps the last confirmed-ended list when a refresh fails", async () => {
    const recentlyEnded = [{ videoId: "v0", confirmedEndedAt: "2026-10-16T03:00:00Z" }]
    vi.mocked(liveStreams.fetchLiveStreams).mockResolvedValueOnce(Object.assign([STREAM], { recentlyEnded })).mockRejectedValue(new Error("offline"))
    const release = acquireLiveStreamsPolling()
    await vi.waitFor(() => expect(liveStreamsStore.get().isLoading).toBe(false))

    await vi.advanceTimersByTimeAsync(60_000)

    expect(liveStreamsStore.get().error).toBe("offline")
    expect(liveStreamsStore.get().recentlyEnded).toEqual(recentlyEnded)
    expect(liveStreamsStore.get().fetchedThisSession).toBe(true) // a later failed refresh does not un-confirm the earlier data
    release()
  })
})
describe("liveStreamsStore neverStarted", () => {
  it("puts the backend's never-started list in the shared state, and drops it again when a later response has none", async () => {
    const neverStarted = [{ videoId: "v9", confirmedAt: "2026-11-17T01:00:00Z" }]
    vi.mocked(liveStreams.fetchLiveStreams).mockResolvedValue(Object.assign([STREAM], { neverStarted }))
    const release = acquireLiveStreamsPolling()
    await vi.waitFor(() => expect(liveStreamsStore.get().isLoading).toBe(false))
    expect(liveStreamsStore.get()).toEqual({ streams: [STREAM], neverStarted, isLoading: false, error: null, fetchedThisSession: true })

    vi.mocked(liveStreams.fetchLiveStreams).mockResolvedValue([STREAM])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(liveStreamsStore.get()).toEqual({ streams: [STREAM], isLoading: false, error: null, fetchedThisSession: true }) // the signal is gone with the evidence

    release()
  })
})
describe("liveStreamsStore fetchedThisSession", () => {
  it("stays false when the session's first request fails", async () => {
    vi.mocked(liveStreams.fetchLiveStreams).mockRejectedValue(new Error("offline"))
    const release = acquireLiveStreamsPolling()
    await vi.waitFor(() => expect(liveStreamsStore.get().isLoading).toBe(false))
    expect(liveStreamsStore.get()).toMatchObject({ isLoading: false, error: "offline", fetchedThisSession: false })
    release()
  })
})
describe("liveStreamsStore polling", () => {
  it("fetches once on first subscriber and updates the shared store", async () => {
    const release = acquireLiveStreamsPolling()
    await vi.waitFor(() => expect(liveStreamsStore.get().isLoading).toBe(false))

    expect(liveStreams.fetchLiveStreams).toHaveBeenCalledTimes(1)
    expect(liveStreamsStore.get()).toEqual({ streams: [STREAM], isLoading: false, error: null, fetchedThisSession: true })

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
