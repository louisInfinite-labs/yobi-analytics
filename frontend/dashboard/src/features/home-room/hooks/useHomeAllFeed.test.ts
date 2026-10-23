import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useHomeAllFeed } from "./useHomeAllFeed"
import * as useLiveStreamsModule from "../../../shared/api/hooks/useLiveStreams"
import * as useOshiVideosModule from "./useOshiVideos"
import * as newContentTrackingModule from "../../../shared/newContent/newContentTracking"
import type { LiveStreamDto, RecentlyEndedStreamDto } from "../../../shared/api/liveStreams"
import { getCreators } from "../../../entities/creator/data/creatorRegistry"

vi.mock("../../../shared/api/hooks/useLiveStreams", () => ({ useLiveStreams: vi.fn() }))
vi.mock("./useOshiVideos", () => ({ useOshiVideos: vi.fn() }))
vi.mock("../../../shared/newContent/newContentTracking", () => ({ useNewContent: vi.fn() }))

const [CREATOR] = getCreators()

function mockStreams(streams: LiveStreamDto[], recentlyEnded?: RecentlyEndedStreamDto[]) {
  vi.mocked(useLiveStreamsModule.useLiveStreams).mockReturnValue({ streams, recentlyEnded, isLoading: false, error: null })
}

function emptyPage(overrides: Partial<ReturnType<typeof useOshiVideosModule.useOshiVideos>> = {}) {
  vi.mocked(useOshiVideosModule.useOshiVideos).mockReturnValue({
    videos: [],
    loading: false,
    error: null,
    loadMore: () => {},
    hasMore: false,
    ...overrides,
  })
}

function ended(videoId: string, status: string, overrides: Partial<RecentlyEndedStreamDto> = {}): RecentlyEndedStreamDto {
  return {
    videoId,
    creatorId: CREATOR.creatorId,
    title: `Ended ${videoId}`,
    scheduledStart: null,
    actualStart: "2026-10-15T18:00:00Z",
    confirmedEndedAt: "2026-10-15T19:00:00Z",
    archive: { status },
    ...overrides,
  }
}

const at = (hour: number) => new Date(Date.UTC(2026, 9, 9, hour, 0)).toISOString()

const UPCOMING: LiveStreamDto = {
  videoId: "v-upcoming",
  creatorId: CREATOR.creatorId,
  channelName: CREATOR.displayName,
  title: "Anniversary goods",
  status: "upcoming",
  scheduledStart: "2026-10-02T14:45:00Z",
  actualStart: null,
  thumbnailUrl: "https://img.youtube.com/vi/v-upcoming/hqdefault.jpg",
}

describe("useHomeAllFeed (Home's shared ALL dataset)", () => {
  beforeEach(() => {
    vi.mocked(newContentTrackingModule.useNewContent).mockReturnValue({
      isNew: () => false,
      isUnseen: () => false,
      markSeen: () => {},
      baseline: "2026-01-01T00:00:00.000Z",
    })
  })

  it("leads with the creator's current upcoming stream ahead of the archive page", () => {
    mockStreams([UPCOMING])
    emptyPage()

    const { result } = renderHook(() => useHomeAllFeed(CREATOR.creatorId))

    expect(result.current.videos.map((v) => v.videoId)).toEqual(["v-upcoming"])
  })

  it("includes an upcoming Premiere, sorted by its own scheduled start -- never the eventual upload's publish time", () => {
    mockStreams([{ ...UPCOMING, videoId: "v-premiere", status: "premiere", scheduledStart: "2026-10-25T10:00:00Z" }])
    emptyPage()

    const { result } = renderHook(() => useHomeAllFeed(CREATOR.creatorId))

    expect(result.current.videos.map((v) => v.videoId)).toEqual(["v-premiere"])
    expect(result.current.videos[0].eventAt).toBe("2026-10-25T10:00:00Z")
  })

  it("a still-upcoming Premiere sorts ahead of an older archived upload (future start beats past publish)", () => {
    mockStreams([{ ...UPCOMING, videoId: "v-premiere", status: "premiere", scheduledStart: "2026-10-25T10:00:00Z" }])
    vi.mocked(useOshiVideosModule.useOshiVideos).mockReturnValue({
      videos: [{ videoId: "v-old-upload", title: "An older upload", publishedAt: "2026-09-01T00:00:00Z", contentFormat: "normal_video" }],
      loading: false,
      error: null,
      loadMore: () => {},
      hasMore: false,
    })

    const { result } = renderHook(() => useHomeAllFeed(CREATOR.creatorId))

    expect(result.current.videos.map((v) => v.videoId)).toEqual(["v-premiere", "v-old-upload"])
  })

  it("a completed Premiere (now an ordinary archived row) keeps sorting by its own publishedAt, newest first among archives", () => {
    // Once a Premiere airs and completes, it leaves the Holodex-sourced "current" pool entirely and is represented
    // here exactly like any other archived upload -- read_api.py/Video Master sets its publishedAt to the actual
    // Premiere start time (collection.youtube_client.py's own audited publish window), never a separate "announcement"
    // timestamp, so no special Premiere handling is needed on this side at all.
    mockStreams([])
    vi.mocked(useOshiVideosModule.useOshiVideos).mockReturnValue({
      videos: [
        { videoId: "v-newer-upload", title: "A newer plain upload", publishedAt: "2026-10-20T00:00:00Z", contentFormat: "normal_video" },
        { videoId: "v-completed-premiere", title: "A completed Premiere", publishedAt: "2026-10-18T10:00:00Z", contentFormat: "normal_video" },
      ],
      loading: false,
      error: null,
      loadMore: () => {},
      hasMore: false,
    })

    const { result } = renderHook(() => useHomeAllFeed(CREATOR.creatorId))

    expect(result.current.videos.map((v) => v.videoId)).toEqual(["v-newer-upload", "v-completed-premiere"])
  })

  it("does not duplicate a Premiere that briefly appears in both the current pool and the archive on the same videoId", () => {
    mockStreams([{ ...UPCOMING, videoId: "v-premiere", status: "premiere" }])
    vi.mocked(useOshiVideosModule.useOshiVideos).mockReturnValue({
      videos: [{ videoId: "v-premiere", title: "Stale archive copy", publishedAt: "2026-10-18T10:00:00Z", contentFormat: "normal_video" }],
      loading: false,
      error: null,
      loadMore: () => {},
      hasMore: false,
    })

    const { result } = renderHook(() => useHomeAllFeed(CREATOR.creatorId))

    expect(result.current.videos.map((v) => v.videoId)).toEqual(["v-premiere"])
    expect(result.current.videos).toHaveLength(1)
  })
})

describe("useHomeAllFeed: the archive-pending gap (ended, not yet verified available)", () => {
  beforeEach(() => {
    vi.mocked(newContentTrackingModule.useNewContent).mockReturnValue({
      isNew: () => false,
      isUnseen: () => false,
      markSeen: () => {},
      baseline: "2026-01-01T00:00:00.000Z",
    })
  })

  it("a confirmed-ended, not-yet-available video stays visible as a transitional placeholder, never as LIVE", () => {
    mockStreams([], [ended("e1", "pending")])
    emptyPage()

    const { result } = renderHook(() => useHomeAllFeed(CREATOR.creatorId))

    expect(result.current.videos.map((v) => v.videoId)).toEqual(["e1"])
    expect(result.current.videos[0].contentFormat).toBe("archive_pending")
  })

  it("a video handed off to the daily task (lookup window elapsed) also stays visible", () => {
    mockStreams([], [ended("e1", "handed_off_to_daily_task")])
    emptyPage()

    const { result } = renderHook(() => useHomeAllFeed(CREATOR.creatorId))

    expect(result.current.videos.map((v) => v.videoId)).toEqual(["e1"])
  })

  it("a confirmed-unavailable video (deleted/private, never returned by YouTube) is not shown as a placeholder", () => {
    mockStreams([], [ended("e1", "unavailable")])
    emptyPage()

    const { result } = renderHook(() => useHomeAllFeed(CREATOR.creatorId))

    expect(result.current.videos).toEqual([])
  })

  it("the placeholder sorts by the stream's own actualStart, exactly where it sorted while LIVE -- no jump in position", () => {
    mockStreams(
      [],
      [ended("e1", "pending", { actualStart: "2026-10-15T18:00:00Z" })],
    )
    vi.mocked(useOshiVideosModule.useOshiVideos).mockReturnValue({
      videos: [{ videoId: "r1", title: "Older upload", publishedAt: "2026-10-10T00:00:00Z", contentFormat: "normal_video" }],
      loading: false,
      error: null,
      loadMore: () => {},
      hasMore: false,
    })

    const { result } = renderHook(() => useHomeAllFeed(CREATOR.creatorId))

    expect(result.current.videos.map((v) => v.videoId)).toEqual(["e1", "r1"])
  })

  it("once the real archive row appears for the same videoId, the placeholder never duplicates it", () => {
    mockStreams([], [ended("e1", "pending")])
    vi.mocked(useOshiVideosModule.useOshiVideos).mockReturnValue({
      videos: [{ videoId: "e1", title: "Now archived", publishedAt: "2026-10-15T18:00:05Z", contentFormat: "normal_video" }],
      loading: false,
      error: null,
      loadMore: () => {},
      hasMore: false,
    })

    const { result } = renderHook(() => useHomeAllFeed(CREATOR.creatorId))

    expect(result.current.videos).toHaveLength(1)
    expect(result.current.videos[0]).toMatchObject({ videoId: "e1", contentFormat: "normal_video", title: "Now archived" })
  })

  it("a live stream for the same videoId always wins over its own stale pending placeholder", () => {
    mockStreams([{ ...UPCOMING, videoId: "e1", status: "live", actualStart: "2026-10-15T20:00:00Z" }], [ended("e1", "pending")])
    emptyPage()

    const { result } = renderHook(() => useHomeAllFeed(CREATOR.creatorId))

    expect(result.current.videos).toHaveLength(1)
    expect(result.current.videos[0].contentFormat).toBe("live_now")
  })

  it("refetches the catalog once a pending videoId resolves, so the placeholder does not wait for an unrelated remount", () => {
    const refresh = vi.fn()
    mockStreams([], [ended("e1", "pending")])
    emptyPage({ refresh })

    const { rerender } = renderHook(({ id }) => useHomeAllFeed(id), { initialProps: { id: CREATOR.creatorId } })
    expect(refresh).not.toHaveBeenCalled()

    mockStreams([], []) // e1 resolved: no longer in recentlyEnded's pending set
    rerender({ id: CREATOR.creatorId })

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("also refetches when a LIVE video leaves `current` straight to archive-available within one cycle -- never observed as pending", () => {
    const refresh = vi.fn()
    mockStreams([{ ...UPCOMING, videoId: "e1", status: "live", actualStart: at(14) }], []) // on air, no recentlyEnded entry at all yet
    emptyPage({ refresh })

    const { rerender } = renderHook(({ id }) => useHomeAllFeed(id), { initialProps: { id: CREATOR.creatorId } })
    expect(refresh).not.toHaveBeenCalled()

    // Confirmed ended AND archive-verified in the SAME completion cycle: gone from `streams`, and recentlyEnded never showed it as
    // pending/handed-off at all (its archive was already available by the time this poll ran).
    mockStreams([], [])
    rerender({ id: CREATOR.creatorId })

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("does not refetch merely because a NEW pending entry appeared (nothing new to fetch yet)", () => {
    const refresh = vi.fn()
    mockStreams([], [])
    emptyPage({ refresh })

    const { rerender } = renderHook(({ id }) => useHomeAllFeed(id), { initialProps: { id: CREATOR.creatorId } })

    mockStreams([], [ended("e1", "pending")])
    rerender({ id: CREATOR.creatorId })

    expect(refresh).not.toHaveBeenCalled()
  })

  it("does not refetch merely because the creator switched", () => {
    const refresh = vi.fn()
    mockStreams([], [ended("e1", "pending")])
    emptyPage({ refresh })
    const [, OTHER] = getCreators()

    const { rerender } = renderHook(({ id }) => useHomeAllFeed(id), { initialProps: { id: CREATOR.creatorId } })

    mockStreams([], [])
    rerender({ id: OTHER.creatorId })

    expect(refresh).not.toHaveBeenCalled()
  })

  it("mixes an ongoing stream, an upload, a future Premiere, a completed Premiere and a pending archive into one chronological order", () => {
    mockStreams(
      [
        { ...UPCOMING, videoId: "future-premiere", status: "premiere", scheduledStart: at(20) },
        { ...UPCOMING, videoId: "ongoing-stream", status: "live", actualStart: at(14) },
      ],
      [ended("just-ended", "pending", { actualStart: at(12) })],
    )
    vi.mocked(useOshiVideosModule.useOshiVideos).mockReturnValue({
      videos: [
        { videoId: "newer-upload", title: "newer-upload", publishedAt: at(16), contentFormat: "normal_video" },
        { videoId: "completed-premiere", title: "completed-premiere", publishedAt: at(10), contentFormat: "normal_video" },
        { videoId: "old-upload", title: "old-upload", publishedAt: at(8), contentFormat: "normal_video" },
      ],
      loading: false,
      error: null,
      loadMore: () => {},
      hasMore: false,
    })

    const { result } = renderHook(() => useHomeAllFeed(CREATOR.creatorId))

    expect(result.current.videos.map((v) => v.videoId)).toEqual([
      "future-premiere",
      "newer-upload",
      "ongoing-stream",
      "just-ended",
      "completed-premiere",
      "old-upload",
    ])
  })
})

describe("useHomeAllFeed: one row per videoId when the sources collide", () => {
  beforeEach(() => {
    vi.mocked(newContentTrackingModule.useNewContent).mockReturnValue({ isNew: () => false, isUnseen: () => false, markSeen: () => {}, baseline: "2026-01-01T00:00:00.000Z" })
  })

  /** The row the API builds from an ANNOUNCEMENT event: a not-watchable premiere ordered by its scheduled start (never its creation date). */
  const announced = (videoId: string, start = "2026-10-23T10:00:00Z") => ({
    videoId,
    title: "Announced Premiere (provisional)",
    publishedAt: start,
    eventAt: start,
    contentFormat: "premiere" as const,
    discoveredAt: "2026-10-23T04:00:00Z",
    announcedPremiere: true,
  })
  /** An ordinary newly discovered video's provisional row: no scheduled start, mapped as a normal video. */
  const ordinaryProvisional = (videoId: string, overrides: Record<string, unknown> = {}) => ({
    videoId,
    title: "Fresh upload",
    publishedAt: "2026-10-23T03:00:00Z",
    contentFormat: "normal_video" as const,
    discoveredAt: "2026-10-23T04:00:00Z",
    ...overrides,
  })

  it("an archive-pending placeholder replaces the announced Premiere's row and keeps the Premiere's real start as its time", () => {
    mockStreams([], [ended("p1", "pending", { actualStart: "2026-10-23T10:00:00Z", scheduledStart: "2026-10-23T10:00:00Z" })])
    emptyPage({ videos: [announced("p1"), { videoId: "other", title: "Other", publishedAt: "2026-10-22T10:00:00Z", contentFormat: "normal_video" as const }] })

    const { result } = renderHook(() => useHomeAllFeed(CREATOR.creatorId))

    const rows = result.current.videos
    expect(rows.map((v) => v.videoId)).toEqual(["p1", "other"]) // one p1, ordered by its real start
    expect(rows[0]).toMatchObject({ contentFormat: "archive_pending", eventAt: "2026-10-23T10:00:00Z" })
    expect(rows[0].announcedPremiere).toBeUndefined()
  })

  it("the same holds for a handed-off archive", () => {
    mockStreams([], [ended("p1", "handed_off_to_daily_task", { actualStart: "2026-10-23T10:00:00Z" })])
    emptyPage({ videos: [announced("p1")] })

    const { result } = renderHook(() => useHomeAllFeed(CREATOR.creatorId))

    expect(result.current.videos).toHaveLength(1)
    expect(result.current.videos[0].contentFormat).toBe("archive_pending")
  })

  it("an upcoming Premiere stream row wins over the announced row and sorts by its scheduled start", () => {
    mockStreams([{ ...UPCOMING, videoId: "p1", status: "premiere", scheduledStart: "2026-10-25T10:00:00Z" }])
    emptyPage({ videos: [announced("p1"), { videoId: "other", title: "Other", publishedAt: "2026-10-22T10:00:00Z", contentFormat: "normal_video" as const }] })

    const { result } = renderHook(() => useHomeAllFeed(CREATOR.creatorId))

    expect(result.current.videos.map((v) => [v.videoId, v.contentFormat])).toEqual([["p1", "premiere"], ["other", "normal_video"]])
  })

  it("while the Premiere is airing (no stream row, no ended record yet) the announced row is the one visible, not-watchable row, ordered by its start", () => {
    mockStreams([], [])
    emptyPage({ videos: [{ videoId: "other", title: "Other", publishedAt: "2026-10-22T10:00:00Z", contentFormat: "normal_video" as const }, announced("p1", "2026-10-23T09:00:00Z")] })

    const { result } = renderHook(() => useHomeAllFeed(CREATOR.creatorId))

    expect(result.current.videos.map((v) => [v.videoId, v.contentFormat])).toEqual([["p1", "premiere"], ["other", "normal_video"]])
  })

  it("a confirmed archive row wins over a stale placeholder", () => {
    mockStreams([], [ended("p1", "pending")])
    const confirmed = { videoId: "p1", title: "Replay", publishedAt: "2026-10-23T10:00:00Z", contentFormat: "normal_video" as const, archiveAvailableAt: "2026-10-23T12:00:00Z" }
    emptyPage({ videos: [confirmed] })

    const { result } = renderHook(() => useHomeAllFeed(CREATOR.creatorId))

    expect(result.current.videos).toHaveLength(1)
    expect(result.current.videos[0]).toMatchObject({ title: "Replay", contentFormat: "normal_video", archiveAvailableAt: "2026-10-23T12:00:00Z" })
  })

  it("ordinary livestream behavior is unchanged: an ordinary provisional row keeps beating a pending placeholder exactly as before, and a live-now stream is one row", () => {
    mockStreams([{ ...UPCOMING, videoId: "now", status: "live", actualStart: "2026-10-23T09:00:00Z", scheduledStart: "2026-10-23T09:00:00Z" }], [ended("done", "pending")])
    emptyPage({ videos: [ordinaryProvisional("done", { title: "Done stream" })] })

    const { result } = renderHook(() => useHomeAllFeed(CREATOR.creatorId))

    expect(result.current.videos.map((v) => [v.videoId, v.contentFormat, v.title])).toEqual([["now", "live_now", "Anniversary goods"], ["done", "normal_video", "Done stream"]])
  })

  it("a provisional row with no other source is shown exactly as before", () => {
    mockStreams([])
    emptyPage({ videos: [ordinaryProvisional("fresh")] })

    const { result } = renderHook(() => useHomeAllFeed(CREATOR.creatorId))

    expect(result.current.videos).toEqual([expect.objectContaining({ videoId: "fresh", title: "Fresh upload", publishedAt: "2026-10-23T03:00:00Z" })])
  })
})
