import { describe, expect, it } from "vitest"
import { SLOT_COUNT, TIME_START_HOUR, getWeekDays, isSameDay, slotIndexForMs, slotLabel, startOfWeek } from "./scheduleGrid"

describe("startOfWeek", () => {
  it("returns the Monday of the given date's week for weekOffset 0", () => {
    // 2026-09-26 is a Saturday.
    const start = startOfWeek(new Date(2026, 8, 26), 0)
    expect(start.getDay()).toBe(1)
    expect(start.getDate()).toBe(21)
  })

  it("shifts by whole weeks for a non-zero weekOffset", () => {
    const thisWeek = startOfWeek(new Date(2026, 8, 26), 0)
    const nextWeek = startOfWeek(new Date(2026, 8, 26), 1)
    expect(nextWeek.getTime() - thisWeek.getTime()).toBe(7 * 24 * 60 * 60 * 1000)
  })
})

describe("getWeekDays", () => {
  it("returns 7 consecutive calendar days starting from weekStart", () => {
    const start = startOfWeek(new Date(2026, 8, 26), 0)
    const days = getWeekDays(start)
    expect(days).toHaveLength(7)
    expect(isSameDay(days[0], start)).toBe(true)
    expect(days[6].getDate()).toBe(27)
  })
})

describe("slotIndexForMs", () => {
  const day = new Date(2026, 8, 21)

  it("returns the correct row for a time inside the 08:00-24:00 window", () => {
    const ms = new Date(2026, 8, 21, TIME_START_HOUR, 30).getTime()
    expect(slotIndexForMs(ms, day)).toBe(1)
  })

  it("returns null before the window opens", () => {
    const ms = new Date(2026, 8, 21, TIME_START_HOUR - 1).getTime()
    expect(slotIndexForMs(ms, day)).toBeNull()
  })

  it("returns null for a timestamp on a different calendar day", () => {
    const ms = new Date(2026, 8, 22, TIME_START_HOUR).getTime()
    expect(slotIndexForMs(ms, day)).toBeNull()
  })

  it("returns the last valid row just before midnight", () => {
    const ms = new Date(2026, 8, 21, 23, 30).getTime()
    expect(slotIndexForMs(ms, day)).toBe(SLOT_COUNT - 1)
  })
})

describe("slotLabel", () => {
  it("labels the first row as the grid's start hour, on the hour", () => {
    expect(slotLabel(0)).toEqual({ hour: String(TIME_START_HOUR).padStart(2, "0"), minute: "00" })
  })

  it("labels an odd row as the half-hour mark", () => {
    expect(slotLabel(1).minute).toBe("30")
  })
})
