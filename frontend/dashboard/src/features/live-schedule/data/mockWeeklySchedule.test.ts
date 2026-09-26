import { describe, expect, it } from "vitest"
import { getMockWeeklySchedule } from "./mockWeeklySchedule"

describe("getMockWeeklySchedule", () => {
  it("stores a real absolute timestamp whose local weekday/hour genuinely differs by viewer timezone", () => {
    // Regression: the previous generator built each stream's time directly
    // from local Date getters/setters, so it always landed on the same
    // visual slot no matter who was viewing -- there was no real absolute
    // instant to re-localize. scheduledStartMs must be a true instant: the
    // SAME value read out in two different IANA zones should be able to
    // land on a different local calendar day/hour, exactly like a real
    // Holodex/YouTube scheduled-time timestamp would.
    const weekStart = new Date(2026, 8, 20) // Sunday 2026-09-20
    const streams = getMockWeeklySchedule(weekStart)
    const withTimezoneSpread = streams.find((stream) => {
      const date = new Date(stream.scheduledStartMs)
      const inTokyo = date.toLocaleString("en-US", { timeZone: "Asia/Tokyo", weekday: "short", hour: "2-digit", hour12: false })
      const inLosAngeles = date.toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "2-digit", hour12: false })
      return inTokyo !== inLosAngeles
    })
    expect(withTimezoneSpread).toBeDefined()
  })

  it("is deterministic for the same calendar week regardless of the exact time-of-day passed in", () => {
    const morning = new Date(2026, 8, 20, 1, 0, 0)
    const evening = new Date(2026, 8, 20, 23, 0, 0)
    expect(getMockWeeklySchedule(morning)).toEqual(getMockWeeklySchedule(evening))
  })

  it("varies from week to week", () => {
    const thisWeek = getMockWeeklySchedule(new Date(2026, 8, 20))
    const nextWeek = getMockWeeklySchedule(new Date(2026, 8, 27))
    expect(thisWeek).not.toEqual(nextWeek)
  })
})
