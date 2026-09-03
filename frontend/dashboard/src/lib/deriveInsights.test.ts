import { describe, expect, it } from "vitest"
import type { DailyVideoStat } from "../types/domain"
import { deriveInsights } from "./deriveInsights"

/** Build a minimal DailyVideoStat for a test, overriding only the given fields. */
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
    sevenDayAverage: 50,
    collectedAt: "2026-09-03T18:00:00+09:00",
    status: "ok",
    ...overrides,
  }
}

describe("deriveInsights", () => {
  it("compares against the 7-day average only for period=1d", () => {
    const insights = deriveInsights([stat({ dailyIncrease: 100, sevenDayAverage: 50 })], "1d")
    expect(insights[0]).toContain("above its 7-day average")
  })

  it("does not compare against the 7-day average for period=7d or 30d, since sevenDayAverage isn't period-scaled", () => {
    // scaleStatsForPeriod would inflate dailyIncrease ~5.5x for 7d while
    // leaving sevenDayAverage untouched — comparing them would be misleading.
    const scaled = stat({ dailyIncrease: 550, sevenDayAverage: 50 })
    const insights = deriveInsights([scaled], "7d")
    expect(insights[0]).not.toContain("7-day average")
    expect(insights[0]).toContain("over this 7-day period")
  })

  it("uses period-appropriate phrasing for the contribution insight", () => {
    const insights = deriveInsights([stat({ dailyIncrease: 100 })], "30d")
    const contributionInsight = insights.find((i) => i.includes("contributed"))
    expect(contributionInsight).toContain("this 30-day period's total growth")
  })

  it("uses period-appropriate phrasing for the fastest-growing insight", () => {
    const insights = deriveInsights([stat({ growthPercent: 20 })], "7d")
    const fastestInsight = insights.find((i) => i.includes("fastest-growing"))
    expect(fastestInsight).toContain("over this 7-day period")
  })

  it("returns an empty array for an empty input rather than throwing", () => {
    expect(deriveInsights([], "1d")).toEqual([])
  })
})
