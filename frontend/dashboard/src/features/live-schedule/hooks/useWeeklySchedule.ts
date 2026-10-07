import { useEffect, useMemo, useState } from "react"
import { getCreatorById, toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"
import { useLiveStreams } from "../../../shared/api/hooks/useLiveStreams"
import type { LiveStreamDto } from "../../../shared/api/liveStreams"
import { SLOT_COUNT, getWeekDays, isSameDay, slotIndexForMs } from "../model/scheduleGrid"
import type { ScheduledStream } from "../model/scheduledStream"

const TICK_MS = 30_000

/** A stream this project can't place on the grid (creatorId not in the
 * canonical registry, or neither scheduledStart nor actualStart parses) is
 * dropped rather than guessed -- same "never fabricate" posture the backend
 * normalization already takes. A "live" stream always has actualStart; a
 * genuinely malformed/missing timestamp on either field is the only case
 * this returns null for. */
function toScheduledStream(dto: LiveStreamDto): ScheduledStream | null {
  const creator = getCreatorById(dto.creatorId)
  if (!creator) return null

  const startIso = dto.scheduledStart ?? dto.actualStart
  if (!startIso) return null
  const scheduledStartMs = new Date(startIso).getTime()
  if (Number.isNaN(scheduledStartMs)) return null

  return {
    id: dto.videoId,
    channelId: toLegacyRosterId(creator),
    videoId: dto.videoId,
    title: dto.title,
    description: "",
    status: dto.status,
    scheduledStartMs,
    topics: dto.topic ? [dto.topic] : [],
  }
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
 * already exposes for Home/Live Status). Sourced from Yobi's own GET
 * /live-streams via the shared useLiveStreams poll -- live + upcoming only,
 * windowed to the backend's own 168-hour/7-day lookahead, so the displayed
 * range is always today through the next 6 days with no page-back/forward
 * navigation (there is no historical or further-out data to page into in
 * this phase). */
export function useWeeklySchedule() {
  const [now, setNow] = useState(() => new Date())
  const { streams } = useLiveStreams()

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), TICK_MS)
    return () => clearInterval(interval)
  }, [])

  // Local calendar parts (not a UTC/ISO string) so a tick that crosses local
  // midnight yields a new `today`, and with it a new displayed window.
  const year = now.getFullYear()
  const month = now.getMonth()
  const dayOfMonth = now.getDate()
  const today = useMemo(() => new Date(year, month, dayOfMonth), [year, month, dayOfMonth])
  const weekStart = today

  const rawStreams = useMemo(
    () => streams.map(toScheduledStream).filter((stream): stream is ScheduledStream => stream !== null),
    [streams],
  )

  const days = useMemo<ScheduleDay[]>(() => {
    return getWeekDays(weekStart).map((date) => {
      const slots: ScheduledStream[][] = Array.from({ length: SLOT_COUNT }, () => [])
      for (const raw of rawStreams) {
        const slotIndex = slotIndexForMs(raw.scheduledStartMs, date)
        if (slotIndex === null) continue
        slots[slotIndex].push(raw)
      }
      return { date, isToday: isSameDay(date, today), slots }
    })
  }, [weekStart, rawStreams, today])

  return { weekStart, days, now }
}
