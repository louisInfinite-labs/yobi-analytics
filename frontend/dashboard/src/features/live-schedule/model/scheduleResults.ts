import type { ScheduledStream } from "./scheduledStream"
import { dayKey } from "./scheduleGrid"

interface ResultDay {
  date: Date
  isToday: boolean
  slots: ScheduledStream[][]
}

export interface ScheduleResultItem {
  stream: ScheduledStream
  slotIndex: number
}

export interface ScheduleResultGroup {
  dayKey: string
  dayIndex: number
  date: Date
  isToday: boolean
  items: ScheduleResultItem[]
}

/** Every placed event of the displayed days, grouped by date (days in window order, days with no event left out) and sorted
 * chronologically inside each day: by time slot, then the stream's own start, then id so ties stay stable. A creator with several events
 * on one day or across days simply gets one item per event. */
export function buildScheduleResults(days: readonly ResultDay[]): ScheduleResultGroup[] {
  const groups: ScheduleResultGroup[] = []
  days.forEach((day, dayIndex) => {
    const items: ScheduleResultItem[] = []
    day.slots.forEach((streams, slotIndex) => {
      for (const stream of streams) items.push({ stream, slotIndex })
    })
    if (items.length === 0) return
    items.sort((a, b) => a.slotIndex - b.slotIndex || a.stream.scheduledStartMs - b.stream.scheduledStartMs || a.stream.id.localeCompare(b.stream.id))
    groups.push({ dayKey: dayKey(day.date), dayIndex, date: day.date, isToday: day.isToday, items })
  })
  return groups
}

/** The grid rows (slot indexes, ascending) that hold at least one event in ANY of the displayed days -- the rows that stay when empty rows
 * are collapsed. One list for every day column, so the seven columns and the time labels keep the same rows and stay aligned. */
export function occupiedSlotIndexes(days: readonly { slots: readonly (readonly ScheduledStream[])[] }[]): number[] {
  const occupied = new Set<number>()
  for (const day of days) {
    day.slots.forEach((streams, slotIndex) => {
      if (streams.length > 0) occupied.add(slotIndex)
    })
  }
  return [...occupied].sort((a, b) => a - b)
}
