export const DAYS_PER_WEEK = 7
/** Streams are only ever scheduled 08:00-24:00 JST (this roster's actual
 * streaming hours) -- a 24h/48-slot grid would spend two thirds of its
 * vertical space on a dead overnight block nothing ever occupies. */
export const TIME_START_HOUR = 8
export const SLOT_MINUTES = 30
export const SLOT_COUNT = ((24 - TIME_START_HOUR) * 60) / SLOT_MINUTES

/** Monday 00:00 (local) of `date`'s week, shifted by `weekOffset` whole
 * weeks. `getDay()` is 0 (Sun) - 6 (Sat); treating Sunday as day 6 of the
 * *previous* Monday-start week is what makes the Mon-start math a single
 * formula instead of a special case. */
export function startOfWeek(date: Date, weekOffset: number): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const mondayIndex = (start.getDay() + 6) % 7
  start.setDate(start.getDate() - mondayIndex + weekOffset * DAYS_PER_WEEK)
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

/** The grid row (0-indexed) `ms` falls into within `day`'s own 08:00-24:00
 * window, or null when it falls outside that window (before 08:00, or the
 * timestamp isn't actually on this calendar day). */
export function slotIndexForMs(ms: number, day: Date): number | null {
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), TIME_START_HOUR, 0, 0, 0)
  const minutesFromStart = (ms - dayStart.getTime()) / 60_000
  if (minutesFromStart < 0) return null
  const index = Math.floor(minutesFromStart / SLOT_MINUTES)
  return index < SLOT_COUNT ? index : null
}

export function slotLabel(slotIndex: number): { hour: string; minute: "00" | "30" } {
  const totalMinutes = TIME_START_HOUR * 60 + slotIndex * SLOT_MINUTES
  const hour = Math.floor(totalMinutes / 60) % 24
  const minute = totalMinutes % 60 === 0 ? "00" : "30"
  return { hour: String(hour).padStart(2, "0"), minute }
}
