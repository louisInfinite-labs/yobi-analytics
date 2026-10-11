import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LOAD_MORE_RETRY_COOLDOWN_MS, useOshiVideos } from "./useOshiVideos"
import { fetchOshiVideos, type OshiVideosPage } from "../data/oshiVideos"
import type { OshiVideosQuery } from "../model/oshiVideosQuery"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"

vi.mock("../data/oshiVideos", () => ({ fetchOshiVideos: vi.fn() }))

const EMMA: OshiVideosQuery = { creatorId: "aizawa_ema", topic: "sf6", contentType: "live", sort: "mostViews", viewWindow: "7d" }
const SUBARU: OshiVideosQuery = { creatorId: "oozora_subaru", topic: "valorant", contentType: "upload", sort: "newest", viewWindow: "7d" }

function video(videoId: string): RecentVideo {
  return { videoId, title: `title ${videoId}`, publishedAt: "2026-09-01T00:00:00Z", contentFormat: "live_archive" }
}

function page(ids: string[], hasMore = false): OshiVideosPage {
  return { videos: ids.map(video), nextOffset: ids.length, hasMore }
}

/** A fetch whose resolution the test controls, so completion ORDER can be staged. */
function deferred() {
  let resolve!: (value: OshiVideosPage) => void
  let reject!: (error: Error) => void
  const promise = new Promise<OshiVideosPage>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const fetchMock = vi.mocked(fetchOshiVideos)

beforeEach(() => {
  fetchMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("useOshiVideos", () => {
  it("fetches the current creator's query and returns its videos", async () => {
    fetchMock.mockResolvedValue(page(["a", "b"]))

    const { result } = renderHook(() => useOshiVideos(EMMA))

    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(fetchMock).toHaveBeenCalledWith(EMMA, 0)
    expect(result.current.videos.map((v) => v.videoId)).toEqual(["a", "b"])
  })

  it("fetches nothing and shows nothing for a null query (quick filter / no canonical creator)", () => {
    const { result } = renderHook(() => useOshiVideos(null))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current).toMatchObject({ videos: [], loading: false, hasMore: false, error: null })
  })

  it("does not refetch when re-rendered with an equal query object", async () => {
    fetchMock.mockResolvedValue(page(["a"]))
    const { result, rerender } = renderHook(({ q }) => useOshiVideos(q), { initialProps: { q: { ...EMMA } } })
    await waitFor(() => expect(result.current.loading).toBe(false))

    rerender({ q: { ...EMMA } })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("switching creator refetches for the new creator and never shows the previous creator's videos, not even while loading", async () => {
    const emma = deferred()
    const subaru = deferred()
    fetchMock.mockImplementation((query) => (query.creatorId === "aizawa_ema" ? emma.promise : subaru.promise))
    const { result, rerender } = renderHook(({ q }) => useOshiVideos(q), { initialProps: { q: EMMA } })
    await act(async () => emma.resolve(page(["emma-1"])))
    expect(result.current.videos.map((v) => v.videoId)).toEqual(["emma-1"])

    rerender({ q: { ...EMMA, creatorId: "oozora_subaru" } })

    expect(fetchMock).toHaveBeenLastCalledWith({ ...EMMA, creatorId: "oozora_subaru" }, 0)
    expect(result.current.videos).toEqual([]) // emma's video is gone the instant the creator changes
    expect(result.current.loading).toBe(true)
    await act(async () => subaru.resolve(page(["subaru-1"])))
    expect(result.current.videos.map((v) => v.videoId)).toEqual(["subaru-1"])
  })

  it("a slow response for the previous creator/filter cannot overwrite the current one", async () => {
    const emma = deferred()
    const subaru = deferred()
    fetchMock.mockImplementation((query) => (query.creatorId === "aizawa_ema" ? emma.promise : subaru.promise))
    const { result, rerender } = renderHook(({ q }) => useOshiVideos(q), { initialProps: { q: EMMA } })

    rerender({ q: SUBARU }) // Emma + SF6 + live + views/7d  ->  Subaru + VALORANT + video + newest, immediately
    await act(async () => subaru.resolve(page(["subaru-1"])))
    await act(async () => emma.resolve(page(["emma-late"]))) // Emma's request finishes LAST

    expect(result.current.videos.map((v) => v.videoId)).toEqual(["subaru-1"])
    expect(result.current.loading).toBe(false)
  })

  it("rapid filter changes within one creator keep only the latest filter's result", async () => {
    const first = deferred()
    const second = deferred()
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { result, rerender } = renderHook(({ q }) => useOshiVideos(q), { initialProps: { q: EMMA } })

    rerender({ q: { ...EMMA, sort: "oldest" } })
    await act(async () => second.resolve(page(["oldest-1"])))
    await act(async () => first.resolve(page(["stale-views"])))

    expect(result.current.videos.map((v) => v.videoId)).toEqual(["oldest-1"])
  })

  it("a valid empty result shows nothing and never reuses the previous filter's videos", async () => {
    fetchMock.mockResolvedValueOnce(page(["a", "b"])).mockResolvedValueOnce(page([]))
    const { result, rerender } = renderHook(({ q }) => useOshiVideos(q), { initialProps: { q: EMMA } })
    await waitFor(() => expect(result.current.videos).toHaveLength(2))

    rerender({ q: { ...EMMA, topic: "minecraft" } })
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.videos).toEqual([])
    expect(result.current.error).toBeNull() // zero matches is not an error
  })

  it("a failed request shows an empty shelf with the error, never the previous videos or fallback data", async () => {
    fetchMock.mockResolvedValueOnce(page(["a"])).mockRejectedValueOnce(new Error("503"))
    const { result, rerender } = renderHook(({ q }) => useOshiVideos(q), { initialProps: { q: EMMA } })
    await waitFor(() => expect(result.current.videos).toHaveLength(1))

    rerender({ q: SUBARU })
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.videos).toEqual([])
    expect(result.current.error?.message).toBe("503")
  })

  it("loadMore appends the next page from the server's offset", async () => {
    fetchMock.mockResolvedValueOnce(page(["a", "b"], true)).mockResolvedValueOnce(page(["c"], false))
    const { result } = renderHook(() => useOshiVideos(SUBARU))
    await waitFor(() => expect(result.current.hasMore).toBe(true))

    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.videos).toHaveLength(3))

    expect(fetchMock).toHaveBeenLastCalledWith(SUBARU, 2)
    expect(result.current.videos.map((v) => v.videoId)).toEqual(["a", "b", "c"])
    expect(result.current.hasMore).toBe(false)
  })

  it("a loadMore response that lands after the creator changed is dropped", async () => {
    const more = deferred()
    const subaru = deferred()
    fetchMock
      .mockResolvedValueOnce(page(["e1"], true))
      .mockReturnValueOnce(more.promise)
      .mockReturnValueOnce(subaru.promise)
    const { result, rerender } = renderHook(({ q }) => useOshiVideos(q), { initialProps: { q: EMMA } })
    await waitFor(() => expect(result.current.hasMore).toBe(true))
    act(() => result.current.loadMore())

    rerender({ q: SUBARU })
    await act(async () => subaru.resolve(page(["s1"])))
    await act(async () => more.resolve(page(["e2-late"])))

    expect(result.current.videos.map((v) => v.videoId)).toEqual(["s1"])
  })

  it("reveals a most-viewed ranking in batches locally -- one request, never ~100 cards at once", async () => {
    const ids = Array.from({ length: 45 }, (_, i) => `v${i}`)
    fetchMock.mockResolvedValueOnce(page(ids, false))
    const { result } = renderHook(() => useOshiVideos(EMMA)) // EMMA is a most-viewed (7d) query
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.videos).toHaveLength(20)
    expect(result.current.hasMore).toBe(true)

    act(() => result.current.loadMore())
    expect(result.current.videos).toHaveLength(40)
    act(() => result.current.loadMore())
    expect(result.current.videos.map((v) => v.videoId)).toEqual(ids) // server order, nothing dropped
    expect(result.current.hasMore).toBe(false)

    act(() => result.current.loadMore()) // exhausted: a no-op
    expect(fetchMock).toHaveBeenCalledTimes(1) // revealing never calls the API
  })

  it("does not batch newest/oldest: the page the server returned is shown as is", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `n${i}`)
    fetchMock.mockResolvedValueOnce(page(ids, true))
    const { result } = renderHook(() => useOshiVideos(SUBARU)) // SUBARU is a newest query
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.videos).toHaveLength(20)
    expect(result.current.hasMore).toBe(true) // more pages exist server-side
  })

  describe("paging robustness (3+ pages)", () => {
    const ids = (from: number, count: number) => Array.from({ length: count }, (_, i) => `p${from + i}`)
    const serverPage = (offset: number): OshiVideosPage => {
      // 3 full pages of 20 and a short 4th: 64 videos in all.
      const count = offset >= 60 ? 4 : 20
      return { videos: ids(offset, count).map(video), nextOffset: offset + count, hasMore: offset + count < 64 }
    }

    it("a loadMore that arrives while a page is in flight is NOT dropped: it runs as soon as that page lands, so no page is ever skipped", async () => {
      const second = deferred()
      fetchMock.mockImplementation((_query, offset = 0) => (offset === 20 ? second.promise : Promise.resolve(serverPage(offset))))
      const { result } = renderHook(() => useOshiVideos(SUBARU))
      await waitFor(() => expect(result.current.videos).toHaveLength(20))

      act(() => result.current.loadMore()) // page 2 goes in flight
      act(() => result.current.loadMore()) // a second trigger lands during the flight (the old guard silently discarded it)
      act(() => result.current.loadMore())
      expect(fetchMock.mock.calls.map((call) => call[1])).toEqual([0, 20]) // still one request at a time

      await act(async () => second.resolve(serverPage(20)))

      await waitFor(() => expect(result.current.videos).toHaveLength(60)) // page 3 was fetched by the queued trigger
      expect(fetchMock.mock.calls.map((call) => call[1])).toEqual([0, 20, 40])
      expect(result.current.videos.map((v) => v.videoId)).toEqual(ids(0, 60))
    })

    it("walks every page to the end (4 pages, 64 videos, no gap, no duplicate) and stops requesting once hasMore is false", async () => {
      fetchMock.mockImplementation((_query, offset = 0) => Promise.resolve(serverPage(offset)))
      const { result } = renderHook(() => useOshiVideos(SUBARU))
      await waitFor(() => expect(result.current.videos).toHaveLength(20))

      for (const expected of [40, 60, 64]) {
        act(() => result.current.loadMore())
        await waitFor(() => expect(result.current.videos).toHaveLength(expected))
      }

      expect(result.current.videos.map((v) => v.videoId)).toEqual(ids(0, 64))
      expect(result.current.hasMore).toBe(false)
      act(() => result.current.loadMore())
      expect(fetchMock).toHaveBeenCalledTimes(4)
    })

    it("a failed middle page keeps what is shown, keeps hasMore TRUE, and the same offset is retried (after the cooldown) -- then paging continues to the end", async () => {
      vi.useFakeTimers({ toFake: ["Date"] })
      let failNext = true
      fetchMock.mockImplementation((_query, offset = 0) => {
        if (offset === 20 && failNext) {
          failNext = false
          return Promise.reject(new Error("503"))
        }
        return Promise.resolve(serverPage(offset))
      })
      const { result } = renderHook(() => useOshiVideos(SUBARU))
      await waitFor(() => expect(result.current.videos).toHaveLength(20))

      act(() => result.current.loadMore()) // page 2 fails
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
      await act(async () => {})

      expect(result.current.videos).toHaveLength(20) // nothing lost
      expect(result.current.hasMore).toBe(true) // NOT permanently false
      expect(result.current.error).toBeNull() // a failed background page is not the first-page error state

      act(() => result.current.loadMore()) // inside the cooldown: no hammering
      expect(fetchMock).toHaveBeenCalledTimes(2)

      vi.setSystemTime(Date.now() + LOAD_MORE_RETRY_COOLDOWN_MS + 1)
      act(() => result.current.loadMore()) // retried at the SAME offset
      await waitFor(() => expect(result.current.videos).toHaveLength(40))
      expect(fetchMock.mock.calls.map((call) => call[1])).toEqual([0, 20, 20])

      for (const expected of [60, 64]) {
        act(() => result.current.loadMore())
        await waitFor(() => expect(result.current.videos).toHaveLength(expected))
      }
      expect(result.current.videos.map((v) => v.videoId)).toEqual(ids(0, 64))
      expect(result.current.hasMore).toBe(false)
    })

    it("a queued trigger is discarded (not replayed) when the in-flight page fails, so a dead connection never loops", async () => {
      vi.useFakeTimers({ toFake: ["Date"] })
      const second = deferred()
      fetchMock.mockImplementation((_query, offset = 0) => (offset === 20 ? second.promise : Promise.resolve(serverPage(offset))))
      const { result } = renderHook(() => useOshiVideos(SUBARU))
      await waitFor(() => expect(result.current.videos).toHaveLength(20))

      act(() => result.current.loadMore())
      act(() => result.current.loadMore()) // queued
      await act(async () => second.reject(new Error("503")))

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(result.current.hasMore).toBe(true)
    })
  })
})
