import { describe, expect, it } from "vitest"
import { dayKey, resolveSelectedDayIndex } from "./scheduleGrid"

const day = (offset: number, isToday = false) => ({ date: new Date(2026, 8, 21 + offset), isToday })
const week = (todayIndex: number | null) => Array.from({ length: 7 }, (_, index) => day(index, index === todayIndex))

describe("dayKey", () => {
  it("is the local calendar date, zero-padded, whatever the time of day", () => {
    expect(dayKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05")
    expect(dayKey(new Date(2026, 11, 31, 0, 0))).toBe("2026-12-31")
  })
})

describe("resolveSelectedDayIndex (which loaded day the phone shows)", () => {
  it("defaults to today when today is inside the loaded range", () => {
    expect(resolveSelectedDayIndex(week(0), null)).toBe(0)
    expect(resolveSelectedDayIndex(week(3), null)).toBe(3)
  })

  it("falls back to the first loaded day when today is not in the range", () => {
    expect(resolveSelectedDayIndex(week(null), null)).toBe(0)
  })

  it("follows an explicit selection by DATE, so it survives the window shifting (midnight)", () => {
    const selected = dayKey(new Date(2026, 8, 24))
    expect(resolveSelectedDayIndex(week(0), selected)).toBe(3)
    const shifted = Array.from({ length: 7 }, (_, index) => day(index + 1, index === 0)) // one day later: 09-22 .. 09-28
    expect(resolveSelectedDayIndex(shifted, selected)).toBe(2)
  })

  it("a selection the window has rolled past falls back to today instead of pointing nowhere", () => {
    const gone = dayKey(new Date(2026, 8, 21))
    const shifted = Array.from({ length: 7 }, (_, index) => day(index + 1, index === 0))
    expect(resolveSelectedDayIndex(shifted, gone)).toBe(0)
  })
})
