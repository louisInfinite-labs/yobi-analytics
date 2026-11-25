import { describe, expect, it } from "vitest"
import { buildOnThisDayFilters, clampMonthDay, daysInMonth, onThisDayQueryKey, shiftMonthDay, todayMonthDay } from "./onThisDay"

describe("todayMonthDay (Tokyo, whatever the browser zone is)", () => {
  it("rolls to the next Tokyo day at 15:00 UTC", () => {
    expect(todayMonthDay(new Date("2026-10-27T14:59:59Z"))).toEqual({ month: 10, day: 27 })
    expect(todayMonthDay(new Date("2026-10-27T15:00:00Z"))).toEqual({ month: 10, day: 28 })
  })

  it("crosses a year boundary in Tokyo before UTC does", () => {
    expect(todayMonthDay(new Date("2026-12-31T15:30:00Z"))).toEqual({ month: 1, day: 1 })
  })
})

describe("month/day arithmetic", () => {
  it("offers 29 days in February (the leap day is selectable) and the right length elsewhere", () => {
    expect(daysInMonth(2)).toBe(29)
    expect(daysInMonth(4)).toBe(30)
    expect(daysInMonth(12)).toBe(31)
  })

  it("steps across the year boundary in both directions", () => {
    expect(shiftMonthDay({ month: 12, day: 31 }, 1)).toEqual({ month: 1, day: 1 })
    expect(shiftMonthDay({ month: 1, day: 1 }, -1)).toEqual({ month: 12, day: 31 })
  })

  it("passes through February 29 instead of skipping it", () => {
    expect(shiftMonthDay({ month: 3, day: 1 }, -1)).toEqual({ month: 2, day: 29 })
    expect(shiftMonthDay({ month: 2, day: 29 }, 1)).toEqual({ month: 3, day: 1 })
    expect(shiftMonthDay({ month: 2, day: 28 }, 1)).toEqual({ month: 2, day: 29 })
  })

  it("keeps the day inside a shorter month when the month changes", () => {
    expect(clampMonthDay({ month: 2, day: 31 })).toEqual({ month: 2, day: 29 })
    expect(clampMonthDay({ month: 4, day: 31 })).toEqual({ month: 4, day: 30 })
    expect(clampMonthDay({ month: 5, day: 31 })).toEqual({ month: 5, day: 31 })
  })
})

describe("buildOnThisDayFilters (the Video List's own controls -> the memories filter)", () => {
  it("ALL is every topic, the dropdown narrows it, Shorts stay out like the shelf's ALL", () => {
    expect(buildOnThisDayFilters("all", "all")).toEqual({ topic: "all", contentType: "all", excludeShorts: true })
    expect(buildOnThisDayFilters("all", "live")).toEqual({ topic: "all", contentType: "live", excludeShorts: true })
  })

  it("a topic tag filters by that topic and respects the dropdown", () => {
    expect(buildOnThisDayFilters("minecraft", "upload")).toEqual({ topic: "minecraft", contentType: "upload", excludeShorts: true })
  })

  it("the quick filters and Short are fixed content types, whatever the dropdown says", () => {
    expect(buildOnThisDayFilters("latestVideos", "live")).toEqual({ topic: "all", contentType: "upload", excludeShorts: true })
    expect(buildOnThisDayFilters("latestLive", "upload")).toEqual({ topic: "all", contentType: "live", excludeShorts: true })
    expect(buildOnThisDayFilters("short", "all")).toEqual({ topic: "all", contentType: "short", excludeShorts: false })
  })

  it("the query key changes with every input that changes the request", () => {
    const base = onThisDayQueryKey("c1", { month: 3, day: 15 }, buildOnThisDayFilters("all", "all"))
    expect(onThisDayQueryKey("c1", { month: 3, day: 15 }, buildOnThisDayFilters("all", "all"))).toBe(base)
    expect(onThisDayQueryKey("c2", { month: 3, day: 15 }, buildOnThisDayFilters("all", "all"))).not.toBe(base)
    expect(onThisDayQueryKey("c1", { month: 3, day: 16 }, buildOnThisDayFilters("all", "all"))).not.toBe(base)
    expect(onThisDayQueryKey("c1", { month: 3, day: 15 }, buildOnThisDayFilters("mv", "all"))).not.toBe(base)
  })
})
