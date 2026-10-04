import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useOshiVideos } from "./useOshiVideos"
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
})
