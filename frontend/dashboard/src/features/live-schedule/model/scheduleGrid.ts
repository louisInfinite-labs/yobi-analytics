import type { ScheduledStream } from "./scheduledStream"

export const DAYS_PER_WEEK = 7
/** The grid covers the full local calendar day (00:00-23:30, 48 slots) --
 * an 08:00 start was only ever a leftover of the original concept mock's
 * demo range. Once placement is local-timezone-based (see slotIndexForMs),
 * a stream scheduled late JST evening can convert to the small hours in a
 * viewer further west/east, and starting the grid at 08:00 would leave it
 * with nowhere to render. */
export const TIME_START_HOUR = 0
export const SLOT_MINUTES = 30
export const SLOT_COUNT = ((24 - TIME_START_HOUR) * 60) / SLOT_MINUTES

/** Sunday 00:00 (local) of `date`'s week, shifted by `weekOffset` whole
 * weeks. `getDay()` is already 0 (Sun) - 6 (Sat), so a Sunday-start week
 * needs no reindexing the way a Monday-start week would. */
export function startOfWeek(date: Date, weekOffset: number): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  start.setDate(start.getDate() - start.getDay() + weekOffset * DAYS_PER_WEEK)
  return start
}

export function getWeekDays(weekStart: Date): Date[] {
  return Array.from({ length: DAYS_PER_WEEK }, (_, i) => {
    const day = new Date(weekStart)
    day.setDate(day.getDate() + i)
    return day
  })
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** The grid row (0-indexed) `ms` falls into within `day`'s own local
 * calendar day, or null when the timestamp isn't actually on this day. Uses
 * the local wall-clock hour/minute (what slotLabel shows), not elapsed time
 * since midnight, so a 23- or 25-hour DST day still lines up with its labels. */
export function slotIndexForMs(ms: number, day: Date): number | null {
  const at = new Date(ms)
  if (!isSameDay(at, day)) return null
  const minutesFromStart = at.getHours() * 60 + at.getMinutes() - TIME_START_HOUR * 60
  if (minutesFromStart < 0) return null
  const index = Math.floor(minutesFromStart / SLOT_MINUTES)
  return index < SLOT_COUNT ? index : null
}

/** Row to bring to the top of the grid on entry: the row of the earliest-
 * started stream that is live right now, in any displayed day column (an
 * overnight stream that began before midnight is still "live" and counts),
 * else the row `now` falls in. */
export function initialScrollSlotIndex(days: { slots: ScheduledStream[][] }[], now: Date): number {
  let earliestStartMs = Infinity
  let liveIndex = -1
  for (const day of days) {
    day.slots.forEach((streams, slotIndex) => {
      for (const stream of streams) {
        if (stream.status === "live" && stream.scheduledStartMs < earliestStartMs) {
          earliestStartMs = stream.scheduledStartMs
          liveIndex = slotIndex
        }
      }
    })
  }
  if (liveIndex >= 0) return liveIndex
  const minutesFromStart = now.getHours() * 60 + now.getMinutes() - TIME_START_HOUR * 60
  return Math.min(Math.max(Math.floor(minutesFromStart / SLOT_MINUTES), 0), SLOT_COUNT - 1)
}

export function slotLabel(slotIndex: number): { hour: string; minute: "00" | "30" } {
  const totalMinutes = TIME_START_HOUR * 60 + slotIndex * SLOT_MINUTES
  const hour = Math.floor(totalMinutes / 60) % 24
  const minute = totalMinutes % 60 === 0 ? "00" : "30"
  return { hour: String(hour).padStart(2, "0"), minute }
}
