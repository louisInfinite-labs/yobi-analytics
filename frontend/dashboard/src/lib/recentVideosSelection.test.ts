import { describe, expect, it } from "vitest"
import { selectAllVideos, selectLatestVideos, selectLivestreamSlots, selectVideosByCategory } from "./recentVideosSelection"
import type { RecentVideo } from "../data/mockRecentVideos"

const videos: RecentVideo[] = [
  { videoId: "v1", title: "video 1", publishedAt: "2026-09-01T00:00:00Z", contentFormat: "normal_video" },
  { videoId: "v2", title: "video 2", publishedAt: "2026-09-03T00:00:00Z", contentFormat: "normal_video" },
  { videoId: "v3", title: "video 3", publishedAt: "2026-08-25T00:00:00Z", contentFormat: "normal_video" },
  { videoId: "a1", title: "archive 1", publishedAt: "2026-09-02T00:00:00Z", contentFormat: "live_archive" },
  { videoId: "a2", title: "archive 2", publishedAt: "2026-08-30T00:00:00Z", contentFormat: "live_archive" },
  { videoId: "a3", title: "archive 3", publishedAt: "2026-08-20T00:00:00Z", contentFormat: "live_archive" },
  { videoId: "s1", title: "shorts", publishedAt: "2026-09-04T00:00:00Z", contentFormat: "shorts" },
]

describe("selectLatestVideos", () => {
  it("returns only normal_video entries, newest first, capped at 2", () => {
    expect(selectLatestVideos(videos, 2).map((v) => v.videoId)).toEqual(["v2", "v1"])
  })

  it("excludes shorts/live formats even if they're newer", () => {
    const result = selectLatestVideos(videos, 2)
    expect(result.some((v) => v.videoId === "s1")).toBe(false)
  })
})

describe("selectLivestreamSlots", () => {
  it("without a live-now entry, returns the 2 most recent archives", () => {
    expect(selectLivestreamSlots(videos, 2).map((v) => v.videoId)).toEqual(["a1", "a2"])
  })

  it("with a live-now entry, returns [live now, most recent archive] — not the 2nd archive", () => {
    const withLive: RecentVideo[] = [...videos, { videoId: "live1", title: "live", publishedAt: "2026-09-05T00:00:00Z", contentFormat: "live_now" }]
    expect(selectLivestreamSlots(withLive, 2).map((v) => v.videoId)).toEqual(["live1", "a1"])
  })

  it("returns fewer than 2 entries when there isn't enough data, rather than fabricating one", () => {
    const sparse: RecentVideo[] = [{ videoId: "only-archive", title: "t", publishedAt: "2026-09-01T00:00:00Z", contentFormat: "live_archive" }]
    expect(selectLivestreamSlots(sparse, 2).map((v) => v.videoId)).toEqual(["only-archive"])
  })
})

describe("selectAllVideos", () => {
  it("merges both pools, newest first, regardless of contentFormat", () => {
    expect(selectAllVideos(videos, [], 10).map((v) => v.videoId)).toEqual(["s1", "v2", "a1", "v1", "a2", "v3", "a3"])
  })

  it("dedupes a videoId present in both pools", () => {
    const shared: RecentVideo = { videoId: "dup", title: "dup", publishedAt: "2026-09-10T00:00:00Z", contentFormat: "normal_video" }
    const result = selectAllVideos([shared], [shared], 10)
    expect(result.filter((v) => v.videoId === "dup")).toHaveLength(1)
  })

  it("caps at count", () => {
    expect(selectAllVideos(videos, [], 2)).toHaveLength(2)
  })

  it("sorts oldest-first when sort is 'oldest'", () => {
    expect(selectAllVideos(videos, [], 10, "oldest").map((v) => v.videoId)).toEqual(["a3", "v3", "a2", "v1", "a1", "v2", "s1"])
  })

  it("sorts by viewCount desc when sort is 'mostViews', treating a missing viewCount as 0", () => {
    const withViews: RecentVideo[] = [
      { videoId: "low", title: "low", publishedAt: "2026-09-01T00:00:00Z", contentFormat: "normal_video", viewCount: 10 },
      { videoId: "high", title: "high", publishedAt: "2026-08-01T00:00:00Z", contentFormat: "normal_video", viewCount: 1000 },
      { videoId: "none", title: "none", publishedAt: "2026-09-05T00:00:00Z", contentFormat: "normal_video" },
    ]
    expect(selectAllVideos(withViews, [], 10, "mostViews").map((v) => v.videoId)).toEqual(["high", "low", "none"])
  })
})

describe("selectVideosByCategory", () => {
  const categorized: RecentVideo[] = [
    { videoId: "c1", title: "valo 1", publishedAt: "2026-09-05T00:00:00Z", contentFormat: "normal_video", category: "valo" },
    { videoId: "c2", title: "sf6 1", publishedAt: "2026-09-04T00:00:00Z", contentFormat: "live_archive", category: "sf6" },
    { videoId: "c3", title: "valo 2", publishedAt: "2026-09-03T00:00:00Z", contentFormat: "normal_video", category: "valo" },
    { videoId: "c4", title: "no category", publishedAt: "2026-09-02T00:00:00Z", contentFormat: "normal_video" },
  ]

  it("filters to just the requested category across both pools, newest first", () => {
    expect(selectVideosByCategory(categorized, [], "valo", 10).map((v) => v.videoId)).toEqual(["c1", "c3"])
  })

  it("treats a video with no category as 'other'", () => {
    expect(selectVideosByCategory(categorized, [], "other", 10).map((v) => v.videoId)).toEqual(["c4"])
  })

  it("returns an empty array when nothing matches", () => {
    expect(selectVideosByCategory(categorized, [], "minecraft", 10)).toEqual([])
  })

  it("applies the requested sort within the filtered category", () => {
    expect(selectVideosByCategory(categorized, [], "valo", 10, "oldest").map((v) => v.videoId)).toEqual(["c3", "c1"])
  })
})
