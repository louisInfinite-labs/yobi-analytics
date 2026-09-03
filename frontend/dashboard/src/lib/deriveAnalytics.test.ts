import { describe, expect, it } from "vitest"
import type { DailyVideoStat } from "../types/domain"
import { deriveChannelContribution, deriveKpis } from "./deriveAnalytics"

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

describe("deriveKpis", () => {
  it("sums totalViews across every entry regardless of status", () => {
    const kpis = deriveKpis([stat({ totalViews: 100 }), stat({ videoId: "v2", totalViews: 200, status: "pending" })])
    expect(kpis.totalViews).toBe(300)
  })

  it("excludes pending/not_available entries from totalDailyIncrease, not treating them as zero", () => {
    const kpis = deriveKpis([
      stat({ dailyIncrease: 100, status: "ok" }),
      stat({ videoId: "v2", dailyIncrease: 500, status: "pending" }),
    ])
    expect(kpis.totalDailyIncrease).toBe(100)
  })

  it("returns null averageGrowthPercent when no entry has a defined percent (all zero-denominator)", () => {
    const kpis = deriveKpis([stat({ growthPercent: null }), stat({ videoId: "v2", growthPercent: null })])
    expect(kpis.averageGrowthPercent).toBeNull()
  })

  it("computes the average growth percent across ok entries with a defined percent", () => {
    const kpis = deriveKpis([stat({ growthPercent: 10 }), stat({ videoId: "v2", growthPercent: 30 })])
    expect(kpis.averageGrowthPercent).toBe(20)
  })

  it("picks the highest dailyIncrease among ok entries as topPerformer", () => {
    const kpis = deriveKpis([
      stat({ videoId: "v1", dailyIncrease: 50 }),
      stat({ videoId: "v2", dailyIncrease: 500 }),
      stat({ videoId: "v3", dailyIncrease: 200, status: "pending" }),
    ])
    expect(kpis.topPerformer?.videoId).toBe("v2")
  })

  it("returns an all-null/zero shape for an empty list rather than throwing", () => {
    const kpis = deriveKpis([])
    expect(kpis).toEqual({ totalViews: 0, totalDailyIncrease: 0, averageGrowthPercent: null, topPerformer: null })
  })
})

describe("deriveChannelContribution", () => {
  it("returns [] when total growth is zero rather than dividing by zero", () => {
    expect(deriveChannelContribution([stat({ dailyIncrease: 0 })])).toEqual([])
  })

  it("sums multiple videos from the same channel into one contribution row", () => {
    const result = deriveChannelContribution([
      stat({ videoId: "v1", channelId: "ch_a", dailyIncrease: 100 }),
      stat({ videoId: "v2", channelId: "ch_a", dailyIncrease: 50 }),
    ])
    expect(result).toHaveLength(1)
    expect(result[0].dailyIncrease).toBe(150)
    expect(result[0].percent).toBe(100)
  })

  it("nets a channel's own positive and negative videos before including it, not just its positive ones", () => {
    const result = deriveChannelContribution([
      stat({ videoId: "v1", channelId: "ch_a", dailyIncrease: 100 }),
      stat({ videoId: "v2", channelId: "ch_a", dailyIncrease: -30 }),
    ])
    expect(result).toHaveLength(1)
    expect(result[0].dailyIncrease).toBe(70) // net, not the 100 an ignore-negatives-then-sum bug would report
  })

  it("excludes a channel whose net across all its videos is not positive", () => {
    const result = deriveChannelContribution([
      stat({ videoId: "v1", channelId: "ch_a", dailyIncrease: 30 }),
      stat({ videoId: "v2", channelId: "ch_a", dailyIncrease: -30 }),
    ])
    expect(result).toEqual([])
  })

  it("percentages across channels sum to 100", () => {
    const result = deriveChannelContribution([
      stat({ videoId: "v1", channelId: "ch_a", dailyIncrease: 300 }),
      stat({ videoId: "v2", channelId: "ch_b", dailyIncrease: 100 }),
    ])
    const total = result.reduce((sum, r) => sum + r.percent, 0)
    expect(total).toBeCloseTo(100)
  })

  it("excludes a negative-growth channel from contribution (it did not contribute positively)", () => {
    const result = deriveChannelContribution([
      stat({ videoId: "v1", channelId: "ch_a", dailyIncrease: 100 }),
      stat({ videoId: "v2", channelId: "ch_b", dailyIncrease: -50 }),
    ])
    expect(result.map((r) => r.channelId)).toEqual(["ch_a"])
  })
})
