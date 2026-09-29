import { renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useRecentVideos } from "./useRecentVideos"
import * as useLiveStreamsModule from "../../../shared/api/hooks/useLiveStreams"
import type { LiveStreamDto } from "../../../shared/api/liveStreams"

vi.mock("../../../shared/api/hooks/useLiveStreams", () => ({ useLiveStreams: vi.fn() }))

function mockStreams(streams: LiveStreamDto[], overrides: { isLoading?: boolean; error?: string | null } = {}) {
  vi.mocked(useLiveStreamsModule.useLiveStreams).mockReturnValue({
    streams,
    isLoading: overrides.isLoading ?? false,
    error: overrides.error ?? null,
  })
}

const LIVE: LiveStreamDto = {
  videoId: "v1",
  creatorId: "aizawa_ema",
  channelName: "藍沢エマ",
  title: "Ranked grind",
  status: "live",
  scheduledStart: null,
  actualStart: "2026-09-29T10:00:00Z",
  thumbnailUrl: "https://img.youtube.com/vi/v1/hqdefault.jpg",
}

const UPCOMING: LiveStreamDto = {
  videoId: "v2",
  creatorId: "aizawa_ema",
  channelName: "藍沢エマ",
  title: "Anniversary goods",
  status: "upcoming",
  scheduledStart: "2026-10-02T14:45:00Z",
  actualStart: null,
  thumbnailUrl: "https://img.youtube.com/vi/v2/hqdefault.jpg",
}

describe("useRecentVideos streamVideos (Latest Live real data)", () => {
  it("maps a live stream for the current creator to a live_now RecentVideo with the real videoId/title", () => {
    mockStreams([LIVE])

    const { result } = renderHook(() => useRecentVideos("ch_aizawa_ema"))

    expect(result.current.streamVideos.videos).toEqual([
      { videoId: "v1", title: "Ranked grind", publishedAt: "2026-09-29T10:00:00Z", contentFormat: "live_now" },
    ])
  })

  it("maps an upcoming stream to live_upcoming (never selected by selectLivestreamSlots, same as before this migration)", () => {
    mockStreams([UPCOMING])

    const { result } = renderHook(() => useRecentVideos("ch_aizawa_ema"))

    expect(result.current.streamVideos.videos).toEqual([
      { videoId: "v2", title: "Anniversary goods", publishedAt: "2026-10-02T14:45:00Z", contentFormat: "live_upcoming" },
    ])
  })

  it("filters out another creator's streams", () => {
    mockStreams([{ ...LIVE, creatorId: "shirakami_fubuki" }])

    const { result } = renderHook(() => useRecentVideos("ch_aizawa_ema"))

    expect(result.current.streamVideos.videos).toEqual([])
  })

  it("reflects the shared store's loading/error state instead of fetching its own", () => {
    mockStreams([], { isLoading: true, error: "network down" })

    const { result } = renderHook(() => useRecentVideos("ch_aizawa_ema"))

    expect(result.current.streamVideos.loading).toBe(true)
    expect(result.current.streamVideos.error?.message).toBe("network down")
  })

  it("never paginates -- loadMore is a no-op and hasMore is always false", () => {
    mockStreams([LIVE])

    const { result } = renderHook(() => useRecentVideos("ch_aizawa_ema"))

    expect(result.current.streamVideos.hasMore).toBe(false)
    expect(() => result.current.streamVideos.loadMore()).not.toThrow()
  })
})
