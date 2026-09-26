import { describe, expect, it } from "vitest"
import { SLOT_COUNT, TIME_START_HOUR, getWeekDays, initialScrollSlotIndex, isSameDay, slotIndexForMs, slotLabel, startOfWeek } from "./scheduleGrid"
import type { ScheduledStream, ScheduledStreamStatus } from "./scheduledStream"

describe("startOfWeek", () => {
  it("returns the Sunday of the given date's week for weekOffset 0", () => {
    // 2026-09-26 is a Saturday.
    const start = startOfWeek(new Date(2026, 8, 26), 0)
    expect(start.getDay()).toBe(0)
    expect(start.getDate()).toBe(20)
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
    expect(days[6].getDate()).toBe(26)
  })
})

describe("slotIndexForMs", () => {
  const day = new Date(2026, 8, 21)

  it("returns the correct row for a time inside the local day", () => {
    const ms = new Date(2026, 8, 21, TIME_START_HOUR, 30).getTime()
    expect(slotIndexForMs(ms, day)).toBe(1)
  })

  it("returns a valid row for the small hours (00:00-07:59), now that the grid covers the full day", () => {
    const ms = new Date(2026, 8, 21, 3, 30).getTime()
    expect(slotIndexForMs(ms, day)).toBe(7)
  })

  it("returns null for a timestamp that actually belongs to the previous calendar day", () => {
    const ms = new Date(2026, 8, 20, 23, 30).getTime()
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

describe("initialScrollSlotIndex", () => {
  const stream = (status: ScheduledStreamStatus, startMs = 0): ScheduledStream => ({
    id: status,
    channelId: "ch",
    videoId: "v",
    title: "t",
    description: "d",
    status,
    scheduledStartMs: startMs,
    topics: [],
  })
  const emptySlots = () => Array.from({ length: SLOT_COUNT }, () => [] as ScheduledStream[])
  const now = new Date(2026, 8, 21, 22, 10)
  const at = (day: number, hour: number, minute: number) => new Date(2026, 8, day, hour, minute).getTime()

  it("uses the live stream's row when one is live", () => {
    const slots = emptySlots()
    slots[41] = [stream("live", at(21, 20, 30))]
    expect(initialScrollSlotIndex([{ slots }], now)).toBe(41)
  })

  it("uses the earliest row when several streams are live", () => {
    const slots = emptySlots()
    slots[41] = [stream("live", at(21, 20, 30))]
    slots[43] = [stream("live", at(21, 21, 30))]
    expect(initialScrollSlotIndex([{ slots }], now)).toBe(41)
  })

  it("falls back to the current local 30-minute slot when nothing is live", () => {
    expect(initialScrollSlotIndex([{ slots: emptySlots() }], now)).toBe(44) // 22:00
  })

  it("does not treat upcoming or ended streams as live", () => {
    const slots = emptySlots()
    slots[10] = [stream("upcoming", at(21, 5, 0))]
    slots[12] = [stream("ended", at(21, 6, 0))]
    expect(initialScrollSlotIndex([{ slots }], now)).toBe(44)
  })

  it("falls back to the current slot when there are no day columns", () => {
    expect(initialScrollSlotIndex([], new Date(2026, 8, 21, 0, 10))).toBe(0)
  })

  it("lets an overnight live stream from the previous day win over a later live stream today", () => {
    // Local time Sunday 01:10: Saturday 23:30 (row 47) is still live and started
    // before Sunday 00:30 (row 1), so 23:30 is the initial top row.
    const saturday = emptySlots()
    saturday[47] = [stream("live", at(19, 23, 30))]
    const sunday = emptySlots()
    sunday[1] = [stream("live", at(20, 0, 30))]
    const sundayNow = new Date(2026, 8, 20, 1, 10)
    expect(initialScrollSlotIndex([{ slots: saturday }, { slots: sunday }], sundayNow)).toBe(47)
    expect(initialScrollSlotIndex([{ slots: sunday }, { slots: saturday }], sundayNow)).toBe(47)
  })
})
