import { describe, expect, it } from "vitest"
import type { DailyVideoStat } from "../types/domain"
import { rankVideos } from "./rankVideos"

function stat(overrides: Partial<DailyVideoStat> = {}): DailyVideoStat {
  return {
    date: "2026-09-03",
    channelId: "ch_a",
    channelName: "Channel A",
    organization: "vspo",
    branch: "vspo_jp",
    groupKey: ["1期生"],
    channelType: "member",
    lifecycleStage: "active",
    videoId: "v1",
    videoTitle: "Video",
    contentFormat: "normal_video",
    contentTags: [],
    totalViews: 1000,
    dailyIncrease: 100,
    growthPercent: 10,
    collectedAt: "2026-09-03T18:00:00+09:00",
    status: "ok",
    ...overrides,
  }
}

describe("rankVideos", () => {
  it("most_viewed sorts by totalViews descending and numbers ranks from 1", () => {
    const ranked = rankVideos(
      [stat({ videoId: "a", totalViews: 100 }), stat({ videoId: "b", totalViews: 300 }), stat({ videoId: "c", totalViews: 200 })],
      "most_viewed",
    )
    expect(ranked.map((r) => r.video.videoId)).toEqual(["b", "c", "a"])
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3])
  })

  it("excludes a pending video from any ranking rather than treating it as zero", () => {
    const ranked = rankVideos([stat({ videoId: "a", totalViews: 100 }), stat({ videoId: "b", status: "pending" })], "most_viewed")
    expect(ranked.map((r) => r.video.videoId)).toEqual(["a"])
  })

  it("fastest_growing excludes a null (zero-denominator) growthPercent", () => {
    const ranked = rankVideos([stat({ videoId: "a", growthPercent: 20 }), stat({ videoId: "b", growthPercent: null })], "fastest_growing")
    expect(ranked.map((r) => r.video.videoId)).toEqual(["a"])
  })

  it("trending sorts by dailyIncrease and matches the Roadmap worked example ordering", () => {
    const ranked = rankVideos(
      [
        stat({ videoId: "video_c", dailyIncrease: 61_000 }),
        stat({ videoId: "video_a", dailyIncrease: 180_000 }),
        stat({ videoId: "video_b", dailyIncrease: 92_000 }),
      ],
      "trending",
    )
    expect(ranked.map((r) => r.video.videoId)).toEqual(["video_a", "video_b", "video_c"])
  })

  it("respects an optional limit", () => {
    const ranked = rankVideos([stat({ videoId: "a", totalViews: 1 }), stat({ videoId: "b", totalViews: 2 }), stat({ videoId: "c", totalViews: 3 })], "most_viewed", 2)
    expect(ranked).toHaveLength(2)
  })

  it.each([-1, 1.5, NaN])("rejects an invalid limit (%s) rather than passing it through to slice", (limit) => {
    expect(() => rankVideos([stat()], "most_viewed", limit)).toThrow(RangeError)
  })

  it("returns [] for an empty input", () => {
    expect(rankVideos([], "most_viewed")).toEqual([])
  })
})
