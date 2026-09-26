import { useEffect, useMemo, useState } from "react"
import { getMockWeeklySchedule } from "../data/mockWeeklySchedule"
import { SLOT_COUNT, getWeekDays, isSameDay, slotIndexForMs, startOfWeek } from "../model/scheduleGrid"
import type { ScheduledStream } from "../model/scheduledStream"

const TICK_MS = 30_000
// Mock-only assumption (no real stream-end event exists here) -- long enough
// that a stream reads as "live" for a plausible viewing session, short enough
// that it eventually reclassifies to "ended" instead of staying live forever.
const ASSUMED_DURATION_MINUTES = 120

function reclassifyByNow(stream: ScheduledStream, nowMs: number): ScheduledStream {
  const endMs = stream.scheduledStartMs + ASSUMED_DURATION_MINUTES * 60_000
  if (nowMs < stream.scheduledStartMs) return stream
  if (nowMs < endMs) return stream.status === "live" ? stream : { ...stream, status: "live" }
  return stream.status === "ended" ? stream : { ...stream, status: "ended" }
}

export interface ScheduleDay {
  date: Date
  isToday: boolean
  /** Index = grid row (see scheduleGrid.ts's SLOT_COUNT) -- each entry holds
   * every stream whose start time rounds down into that 30-minute row. */
  slots: ScheduledStream[][]
}

/** The Live Schedule page's own data source (spec: a full week of scheduled
 * streams per creator, not the single current-status model useCreatorStatuses
 * already exposes for Home/Live Status). Backed by mock data for now, same
 * "one hook, one swap point" shape as useCreatorStatuses. */
export function useWeeklySchedule() {
  const [weekOffset, setWeekOffset] = useState(0)
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), TICK_MS)
    return () => clearInterval(interval)
  }, [])

  const weekStart = useMemo(() => startOfWeek(new Date(), weekOffset), [weekOffset])
  const rawStreams = useMemo(() => getMockWeeklySchedule(weekStart), [weekStart])

  const days = useMemo<ScheduleDay[]>(() => {
    const today = new Date()
    return getWeekDays(weekStart).map((date) => {
      const slots: ScheduledStream[][] = Array.from({ length: SLOT_COUNT }, () => [])
      for (const raw of rawStreams) {
        const slotIndex = slotIndexForMs(raw.scheduledStartMs, date)
        if (slotIndex === null) continue
        slots[slotIndex].push(reclassifyByNow(raw, now.getTime()))
      }
      return { date, isToday: isSameDay(date, today), slots }
    })
  }, [weekStart, rawStreams, now])

  return {
    weekStart,
    days,
    now,
    goToPreviousWeek: () => setWeekOffset((week) => week - 1),
    goToNextWeek: () => setWeekOffset((week) => week + 1),
  }
}
