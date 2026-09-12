import { describe, expect, it } from "vitest"
import { selectLatestVideos, selectLivestreamSlots } from "./recentVideosSelection"
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
