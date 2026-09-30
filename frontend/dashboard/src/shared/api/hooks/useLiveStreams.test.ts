import { renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useLiveStreams } from "./useLiveStreams"
import * as liveStreams from "../liveStreams"

vi.mock("../liveStreams", () => ({ fetchLiveStreams: vi.fn() }))

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
  vi.clearAllMocks()
  vi.mocked(liveStreams.fetchLiveStreams).mockResolvedValue([STREAM])
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("useLiveStreams", () => {
  it("starts loading, then resolves with the fetched streams", async () => {
    const { result } = renderHook(() => useLiveStreams())

    expect(result.current.isLoading).toBe(true)

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.streams).toEqual([STREAM])
    expect(result.current.error).toBeNull()
  })

  it("two simultaneously mounted consumers share one fetch", async () => {
    renderHook(() => useLiveStreams())
    renderHook(() => useLiveStreams())

    await waitFor(() => expect(liveStreams.fetchLiveStreams).toHaveBeenCalled())
    expect(liveStreams.fetchLiveStreams).toHaveBeenCalledTimes(1)
  })
})
