import { describe, expect, it } from "vitest"
import { SLOT_COUNT } from "./scheduleGrid"
import { buildScheduleResults, occupiedSlotIndexes } from "./scheduleResults"
import type { ScheduledStream } from "./scheduledStream"

/** A minimal upcoming stream. */
function stream(id: string, channelId: string, scheduledStartMs = 0): ScheduledStream {
  return { id, channelId, videoId: id, title: id, description: "", status: "upcoming", scheduledStartMs, topics: [] }
}

/** One schedule day whose rows hold the given streams. */
function day(date: Date, placements: Record<number, ScheduledStream[]>, isToday = false) {
  const slots: ScheduledStream[][] = Array.from({ length: SLOT_COUNT }, () => [])
  for (const [slot, streams] of Object.entries(placements)) slots[Number(slot)] = streams
  return { date, isToday, slots }
}

describe("buildScheduleResults", () => {
  it("groups by date in window order, leaves out empty days and sorts each day by time", () => {
    const days = [
      day(new Date(2026, 8, 21), { 30: [stream("late", "a")], 4: [stream("early", "b")] }, true),
      day(new Date(2026, 8, 22), {}),
      day(new Date(2026, 8, 23), { 10: [stream("wed", "a")] }),
    ]

    const groups = buildScheduleResults(days)

    expect(groups.map((group) => [group.dayKey, group.dayIndex, group.isToday])).toEqual([
      ["2026-09-21", 0, true],
      ["2026-09-23", 2, false],
    ])
    expect(groups[0].items.map((item) => [item.stream.id, item.slotIndex])).toEqual([
      ["early", 4],
      ["late", 30],
    ])
  })

  it("orders events sharing a slot by their own start, then id, and keeps one item per event for a creator with several", () => {
    const days = [
      day(new Date(2026, 8, 21), { 12: [stream("z", "a", 200), stream("y", "a", 100), stream("x", "b", 100)] }),
      day(new Date(2026, 8, 22), { 12: [stream("again", "a", 50)] }),
    ]

    const groups = buildScheduleResults(days)

    expect(groups[0].items.map((item) => item.stream.id)).toEqual(["x", "y", "z"])
    expect(groups.flatMap((group) => group.items).filter((item) => item.stream.channelId === "a")).toHaveLength(3)
  })

  it("is empty when no day has an event", () => {
    expect(buildScheduleResults([day(new Date(2026, 8, 21), {})])).toEqual([])
  })
})

describe("occupiedSlotIndexes", () => {
  it("lists each row that any day uses once, ascending", () => {
    const days = [day(new Date(2026, 8, 21), { 30: [stream("a", "a")], 4: [stream("b", "a")] }), day(new Date(2026, 8, 22), { 4: [stream("c", "a")], 12: [stream("d", "a")] })]

    expect(occupiedSlotIndexes(days)).toEqual([4, 12, 30])
  })

  it("is empty for an empty schedule", () => {
    expect(occupiedSlotIndexes([day(new Date(2026, 8, 21), {})])).toEqual([])
  })
})
