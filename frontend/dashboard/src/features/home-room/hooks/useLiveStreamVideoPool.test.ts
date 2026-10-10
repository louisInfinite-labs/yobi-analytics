import { act, renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useLiveStreamVideoPool } from "./useRecentVideos"
import * as useLiveStreamsModule from "../../../shared/api/hooks/useLiveStreams"
import * as recentArchivedLivestreamsModule from "../data/recentArchivedLivestreams"
import type { LiveStreamDto } from "../../../shared/api/liveStreams"
import type { ArchivedLivestreamPage } from "../data/recentArchivedLivestreams"
import { getCreators } from "../../../entities/creator/data/creatorRegistry"

vi.mock("../../../shared/api/hooks/useLiveStreams", () => ({ useLiveStreams: vi.fn() }))
vi.mock("../data/recentArchivedLivestreams", () => ({ fetchArchivedLivestreams: vi.fn() }))

function mockStreams(streams: LiveStreamDto[], overrides: { isLoading?: boolean; error?: string | null } = {}) {
  vi.mocked(useLiveStreamsModule.useLiveStreams).mockReturnValue({
    streams,
    isLoading: overrides.isLoading ?? false,
    error: overrides.error ?? null,
  })
}

function mockArchivePage(page: ArchivedLivestreamPage) {
  vi.mocked(recentArchivedLivestreamsModule.fetchArchivedLivestreams).mockResolvedValue(page)
}

function mockArchiveFailure(err: Error) {
  vi.mocked(recentArchivedLivestreamsModule.fetchArchivedLivestreams).mockRejectedValue(err)
}

function emptyArchivePage(): ArchivedLivestreamPage {
  return { videos: [], nextOffset: 0, hasMore: false }
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

describe("useLiveStreamVideoPool (player pool: Holodex current + AWS archives)", () => {
  it("maps a live stream for the current creator to a live_now RecentVideo with the real videoId/title", async () => {
    mockStreams([LIVE])
    mockArchivePage(emptyArchivePage())

    const { result } = renderHook(() => useLiveStreamVideoPool("ch_aizawa_ema"))

    await waitFor(() =>
      expect(result.current.videos).toEqual([
        { videoId: "v1", title: "Ranked grind", publishedAt: "2026-09-29T10:00:00Z", eventAt: "2026-09-29T10:00:00Z", contentFormat: "live_now" },
      ]),
    )
  })

  it("maps an upcoming stream to live_upcoming", async () => {
    mockStreams([UPCOMING])
    mockArchivePage(emptyArchivePage())

    const { result } = renderHook(() => useLiveStreamVideoPool("ch_aizawa_ema"))

    await waitFor(() =>
      expect(result.current.videos).toEqual([
        { videoId: "v2", title: "Anniversary goods", publishedAt: "2026-10-02T14:45:00Z", eventAt: "2026-10-02T14:45:00Z", contentFormat: "live_upcoming" },
      ]),
    )
  })

  it("filters out another creator's streams", async () => {
    mockStreams([{ ...LIVE, creatorId: "shirakami_fubuki" }])
    mockArchivePage(emptyArchivePage())

    const { result } = renderHook(() => useLiveStreamVideoPool("ch_aizawa_ema"))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.videos).toEqual([])
  })

  it("appends AWS completed archives (newest first, as the backend already ordered them) after the current stream", async () => {
    mockStreams([LIVE])
    mockArchivePage({
      videos: [
        { videoId: "a1", title: "Archive newest", publishedAt: "2026-09-20T00:00:00Z", contentFormat: "live_archive", viewCount: 100 },
        { videoId: "a2", title: "Archive older", publishedAt: "2026-09-10T00:00:00Z", contentFormat: "live_archive", viewCount: 50 },
      ],
      nextOffset: 2,
      hasMore: false,
    })

    const { result } = renderHook(() => useLiveStreamVideoPool("ch_aizawa_ema"))

    await waitFor(() => expect(result.current.videos).toHaveLength(3))
    expect(result.current.videos.map((v) => v.videoId)).toEqual(["v1", "a1", "a2"])
  })

  it("offline creator (no live/upcoming) shows AWS archives starting at slot 0", async () => {
    mockStreams([])
    mockArchivePage({
      videos: [{ videoId: "a1", title: "Archive", publishedAt: "2026-09-20T00:00:00Z", contentFormat: "live_archive", viewCount: 100 }],
      nextOffset: 1,
      hasMore: false,
    })

    const { result } = renderHook(() => useLiveStreamVideoPool("ch_aizawa_ema"))

    await waitFor(() => expect(result.current.videos).toEqual([
      { videoId: "a1", title: "Archive", publishedAt: "2026-09-20T00:00:00Z", contentFormat: "live_archive", viewCount: 100 },
    ]))
  })

  it("deduplicates by videoId -- the current Holodex stream wins over an AWS archive row with the same videoId", async () => {
    mockStreams([LIVE])
    mockArchivePage({
      videos: [
        { videoId: "v1", title: "Stale archive copy", publishedAt: "2026-09-29T10:00:00Z", contentFormat: "live_archive", viewCount: 1 },
        { videoId: "a2", title: "Older archive", publishedAt: "2026-09-10T00:00:00Z", contentFormat: "live_archive", viewCount: 50 },
      ],
      nextOffset: 2,
      hasMore: false,
    })

    const { result } = renderHook(() => useLiveStreamVideoPool("ch_aizawa_ema"))

    await waitFor(() => expect(result.current.videos.map((v) => v.videoId)).toEqual(["v1", "a2"]))
    const v1 = result.current.videos.find((v) => v.videoId === "v1")
    expect(v1?.contentFormat).toBe("live_now")
    expect(v1?.title).toBe("Ranked grind")
  })

  it("a failed AWS archive request still leaves the current live stream visible", async () => {
    mockStreams([LIVE])
    mockArchiveFailure(new Error("network down"))

    const { result } = renderHook(() => useLiveStreamVideoPool("ch_aizawa_ema"))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.videos).toEqual([
      { videoId: "v1", title: "Ranked grind", publishedAt: "2026-09-29T10:00:00Z", eventAt: "2026-09-29T10:00:00Z", contentFormat: "live_now" },
    ])
  })

  it("requests the archive endpoint with contentType=live and liveStatus=completed", async () => {
    mockStreams([LIVE])
    mockArchivePage(emptyArchivePage())

    renderHook(() => useLiveStreamVideoPool("ch_aizawa_ema"))

    await waitFor(() => expect(recentArchivedLivestreamsModule.fetchArchivedLivestreams).toHaveBeenCalled())
    // The query string itself (contentType=live&liveStatus=completed) is
    // asserted directly against fetchArchivedLivestreams's own implementation
    // in recentArchivedLivestreams.test.ts -- this only proves the hook calls
    // it at all, with this creator's canonical id.
    expect(recentArchivedLivestreamsModule.fetchArchivedLivestreams).toHaveBeenCalledWith("aizawa_ema", { offset: 0 })
  })

  it("reflects the shared live-streams store's error alongside the archive pool", async () => {
    mockStreams([], { isLoading: true, error: "network down" })
    mockArchivePage(emptyArchivePage())

    const { result } = renderHook(() => useLiveStreamVideoPool("ch_aizawa_ema"))

    expect(result.current.loading).toBe(true)
    expect(result.current.error?.message).toBe("network down")
  })
})


const [CREATOR_A, CREATOR_B] = getCreators()

function archivePage(ids: string[], hasMore: boolean): ArchivedLivestreamPage {
  return {
    videos: ids.map((videoId) => ({ videoId, title: videoId, publishedAt: "2026-09-01T00:00:00Z", contentFormat: "live_archive" as const })),
    nextOffset: ids.length,
    hasMore,
  }
}

function deferredPage() {
  let resolve!: (page: ArchivedLivestreamPage) => void
  const promise = new Promise<ArchivedLivestreamPage>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe("useLiveStreamVideoPool archive pool: creator switching and pagination guards", () => {
  const fetchMock = () => vi.mocked(recentArchivedLivestreamsModule.fetchArchivedLivestreams)

  it("drops the previous creator's archives and hasMore as soon as the creator changes, before the new request resolves", async () => {
    mockStreams([])
    const b = deferredPage()
    fetchMock().mockReset()
    fetchMock().mockResolvedValueOnce(archivePage(["a1"], true)).mockReturnValueOnce(b.promise)
    const { result, rerender } = renderHook(({ id }) => useLiveStreamVideoPool(id), { initialProps: { id: CREATOR_A.creatorId } })
    await waitFor(() => expect(result.current.videos.map((v) => v.videoId)).toEqual(["a1"]))
    expect(result.current.hasMore).toBe(true)

    rerender({ id: CREATOR_B.creatorId })

    await waitFor(() => expect(fetchMock()).toHaveBeenCalledWith(CREATOR_B.creatorId, { offset: 0 }))
    expect(result.current.videos).toEqual([]) // A's archive never shows under B while B loads
    expect(result.current.hasMore).toBe(false)
    await act(async () => b.resolve(archivePage(["b1"], false)))
    expect(result.current.videos.map((v) => v.videoId)).toEqual(["b1"])
  })

  it("loadMore() is ignored while the initial request is still loading", async () => {
    mockStreams([])
    const initial = deferredPage()
    fetchMock().mockReset()
    fetchMock().mockReturnValueOnce(initial.promise)
    const { result } = renderHook(() => useLiveStreamVideoPool(CREATOR_A.creatorId))
    await waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(1))

    act(() => result.current.loadMore())
    await act(async () => initial.resolve(archivePage(["a1", "a2"], true)))

    expect(fetchMock()).toHaveBeenCalledTimes(1) // no second offset-0 request that would append a duplicate page
    expect(result.current.videos.map((v) => v.videoId)).toEqual(["a1", "a2"])
  })

  it("loadMore() is a no-op once hasMore is false", async () => {
    mockStreams([])
    fetchMock().mockReset()
    fetchMock().mockResolvedValue(archivePage(["a1"], false))
    const { result } = renderHook(() => useLiveStreamVideoPool(CREATOR_A.creatorId))
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => result.current.loadMore())
    act(() => result.current.loadMore())

    expect(fetchMock()).toHaveBeenCalledTimes(1)
  })

  it("loadMore() still fetches the next page from the server's offset when more exist, and ignores an overlapping call", async () => {
    mockStreams([])
    const more = deferredPage()
    fetchMock().mockReset()
    fetchMock().mockResolvedValueOnce(archivePage(["a1", "a2"], true)).mockReturnValueOnce(more.promise)
    const { result } = renderHook(() => useLiveStreamVideoPool(CREATOR_A.creatorId))
    await waitFor(() => expect(result.current.hasMore).toBe(true))

    act(() => result.current.loadMore())
    act(() => result.current.loadMore()) // overlapping -- ignored
    await act(async () => more.resolve(archivePage(["a3"], false)))

    expect(fetchMock()).toHaveBeenCalledTimes(2)
    expect(fetchMock()).toHaveBeenLastCalledWith(CREATOR_A.creatorId, { offset: 2 })
    expect(result.current.videos.map((v) => v.videoId)).toEqual(["a1", "a2", "a3"])
    expect(result.current.hasMore).toBe(false)
  })
})
