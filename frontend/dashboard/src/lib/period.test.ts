import { describe, expect, it } from "vitest"
import type { DailyVideoStat } from "../types/domain"
import { comparisonDateFor, scaleStatsForPeriod } from "./period"

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
    collectedAt: "2026-09-03T18:00:00+09:00",
    status: "ok",
    ...overrides,
  }
}

describe("comparisonDateFor", () => {
  it("subtracts the period's day count", () => {
    expect(comparisonDateFor("2026-09-03", "7d")).toBe("2026-08-27")
  })
})

describe("scaleStatsForPeriod", () => {
  it("returns the same values unchanged for 1d (the fixture's native period)", () => {
    const result = scaleStatsForPeriod([stat({ dailyIncrease: 100, growthPercent: 10 })], "1d")
    expect(result[0].dailyIncrease).toBe(100)
    expect(result[0].growthPercent).toBe(10)
  })

  it("scales dailyIncrease and growthPercent up for a longer period, so the selector visibly changes what's shown", () => {
    const oneDay = scaleStatsForPeriod([stat({ dailyIncrease: 100, growthPercent: 10 })], "1d")[0]
    const sevenDay = scaleStatsForPeriod([stat({ dailyIncrease: 100, growthPercent: 10 })], "7d")[0]
    const thirtyDay = scaleStatsForPeriod([stat({ dailyIncrease: 100, growthPercent: 10 })], "30d")[0]

    expect(sevenDay.dailyIncrease).toBeGreaterThan(oneDay.dailyIncrease)
    expect(thirtyDay.dailyIncrease).toBeGreaterThan(sevenDay.dailyIncrease)
  })

  it("leaves totalViews and status untouched — only growth figures are period-dependent", () => {
    const result = scaleStatsForPeriod([stat({ totalViews: 5000, status: "ok" })], "30d")
    expect(result[0].totalViews).toBe(5000)
    expect(result[0].status).toBe("ok")
  })

  it("does not fabricate a growthPercent for a zero-denominator (null) result", () => {
    const result = scaleStatsForPeriod([stat({ growthPercent: null })], "30d")
    expect(result[0].growthPercent).toBeNull()
  })

  it("leaves a non-ok (pending) entry entirely unscaled", () => {
    const pending = stat({ status: "pending", dailyIncrease: 0, growthPercent: null })
    const result = scaleStatsForPeriod([pending], "30d")
    expect(result[0]).toEqual(pending)
  })
})
