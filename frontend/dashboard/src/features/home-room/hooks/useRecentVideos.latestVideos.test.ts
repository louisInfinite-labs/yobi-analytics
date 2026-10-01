import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useRecentVideos } from "./useRecentVideos"
import { getRecentVideosForCreator } from "../data/mockRecentVideos"
import * as holodexClientModule from "../../../integrations/holodex/holodexClient"
import type { HolodexPage } from "../../../integrations/holodex/holodexClient"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"

vi.mock("../../../integrations/holodex/holodexClient", () => ({ fetchUploadedVideosFromHolodex: vi.fn() }))
vi.mock("../../../shared/api/hooks/useLiveStreams", () => ({ useLiveStreams: () => ({ streams: [], isLoading: false, error: null }) }))
vi.mock("../data/recentArchivedLivestreams", () => ({
  fetchArchivedLivestreams: vi.fn().mockResolvedValue({ videos: [], nextOffset: 0, hasMore: false }),
}))

// gawr_gura is the only creator that fetches real "Latest Videos" (REAL_FETCH_ENABLED_CREATOR_IDS); every other creator stays on mock data.
const REAL = "ch_gawr_gura"
const MOCK_ONLY = "ch_aizawa_ema"

const fetchMock = () => vi.mocked(holodexClientModule.fetchUploadedVideosFromHolodex)

function video(videoId: string): RecentVideo {
  return { videoId, title: videoId, publishedAt: "2026-09-01T00:00:00Z", contentFormat: "normal_video" }
}

function page(ids: string[], hasMore: boolean): HolodexPage {
  return { videos: ids.map(video), nextOffset: ids.length, hasMore }
}

function deferredPage() {
  let resolve!: (value: HolodexPage) => void
  const promise = new Promise<HolodexPage>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const ids = (videos: RecentVideo[]) => videos.map((v) => v.videoId)

beforeEach(() => {
  fetchMock().mockReset()
})

describe("useRecentVideos latestVideos pool: creator switching and pagination guards", () => {
  it("does not keep the previous creator's rows (or hasMore) while the new creator's initial request is pending", async () => {
    const pending = deferredPage()
    fetchMock().mockReturnValue(pending.promise)
    const { result, rerender } = renderHook(({ id }) => useRecentVideos(id), { initialProps: { id: MOCK_ONLY } })
    expect(ids(result.current.latestVideos.videos)).toEqual(ids(getRecentVideosForCreator(MOCK_ONLY))) // mock creator: its own mock rows

    rerender({ id: REAL })

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(1))
    const shown = ids(result.current.latestVideos.videos)
    for (const previous of ids(getRecentVideosForCreator(MOCK_ONLY))) expect(shown).not.toContain(previous)
    expect(result.current.latestVideos.hasMore).toBe(false)
    await act(async () => pending.resolve(page(["real-1"], false)))
    expect(ids(result.current.latestVideos.videos)).toEqual(["real-1"])
  })

  it("drops the previous creator's loaded real page when switching creators", async () => {
    fetchMock().mockResolvedValue(page(["real-1", "real-2"], true))
    const { result, rerender } = renderHook(({ id }) => useRecentVideos(id), { initialProps: { id: REAL } })
    await waitFor(() => expect(ids(result.current.latestVideos.videos)).toEqual(["real-1", "real-2"]))

    rerender({ id: MOCK_ONLY })

    expect(ids(result.current.latestVideos.videos)).toEqual(ids(getRecentVideosForCreator(MOCK_ONLY)))
    expect(result.current.latestVideos.hasMore).toBe(false)
  })

  it("loadMore() is ignored while the initial request is still loading", async () => {
    const initial = deferredPage()
    fetchMock().mockReturnValueOnce(initial.promise)
    const { result } = renderHook(() => useRecentVideos(REAL))
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(1))

    act(() => result.current.latestVideos.loadMore())
    await act(async () => initial.resolve(page(["r1", "r2"], true)))

    expect(fetchMock()).toHaveBeenCalledTimes(1) // no second offset-0 request that would append a duplicate page
    expect(ids(result.current.latestVideos.videos)).toEqual(["r1", "r2"])
  })

  it("loadMore() is a no-op once hasMore is false", async () => {
    fetchMock().mockResolvedValue(page(["r1"], false))
    const { result } = renderHook(() => useRecentVideos(REAL))
    await waitFor(() => expect(result.current.latestVideos.loading).toBe(false))

    act(() => result.current.latestVideos.loadMore())
    act(() => result.current.latestVideos.loadMore())

    expect(fetchMock()).toHaveBeenCalledTimes(1)
  })

  it("loadMore() still fetches the next page from the server's offset when more exist, and ignores an overlapping call", async () => {
    const more = deferredPage()
    fetchMock().mockResolvedValueOnce(page(["r1", "r2"], true)).mockReturnValueOnce(more.promise)
    const { result } = renderHook(() => useRecentVideos(REAL))
    await waitFor(() => expect(result.current.latestVideos.hasMore).toBe(true))

    act(() => result.current.latestVideos.loadMore())
    act(() => result.current.latestVideos.loadMore()) // overlapping -- ignored
    await act(async () => more.resolve(page(["r3"], false)))

    expect(fetchMock()).toHaveBeenCalledTimes(2)
    expect(fetchMock().mock.calls[1][1]).toEqual({ offset: 2 })
    expect(ids(result.current.latestVideos.videos)).toEqual(["r1", "r2", "r3"])
    expect(result.current.latestVideos.hasMore).toBe(false)
  })
})
