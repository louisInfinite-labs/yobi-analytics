import { useMemo } from "react"
import { useMinuteClock } from "../../../shared/time/minuteClock"
import { getCreatorById, toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"
import { useLiveStreams } from "../../../shared/api/hooks/useLiveStreams"
import type { LiveStreamDto } from "../../../shared/api/liveStreams"
import { SLOT_COUNT, getWeekDays, isSameDay, slotIndexForMs } from "../model/scheduleGrid"
import type { ScheduledStream } from "../model/scheduledStream"
import { filterStreamsByCreators, filterStreamsByOrganization, type ScheduleOrganizationFilter } from "../model/scheduleCreatorFilter"
import { useOvernightHold } from "./useOvernightHold"

const NO_CREATOR_FILTER: ReadonlySet<string> = new Set()

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
  const actualStartMs = dto.actualStart ? new Date(dto.actualStart).getTime() : Number.NaN

  return {
    id: dto.videoId,
    channelId: toLegacyRosterId(creator),
    videoId: dto.videoId,
    title: dto.title,
    description: "",
    status: dto.status,
    scheduledStartMs,
    ...(Number.isNaN(actualStartMs) ? {} : { actualStartMs }),
    ...(dto.thumbnailUrl ? { thumbnailUrl: dto.thumbnailUrl } : {}),
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
export function useWeeklySchedule(selectedChannelIds: ReadonlySet<string> = NO_CREATOR_FILTER, organization: ScheduleOrganizationFilter = "all") {
  // The one shared minute clock (also used by Home): the same stream reads the same countdown on both pages.
  const now = useMinuteClock()
  const { streams, recentlyEnded } = useLiveStreams()

  // Local calendar parts (not a UTC/ISO string) so a tick that crosses local
  // midnight yields a new `today`, and with it a new displayed window.
  const year = now.getFullYear()
  const month = now.getMonth()
  const dayOfMonth = now.getDate()
  const today = useMemo(() => new Date(year, month, dayOfMonth), [year, month, dayOfMonth])
  // Normally the window starts today. While an overnight stream is unresolved (still live, or dropped from the live list but not yet CONFIRMED ended by the backend -- never waiting on an archive)
  // it starts on that stream's ORIGINAL local start day instead, however many midnights ago that was, and stays there until the stream is resolved --
  // never moved forward to keep today in view. Always exactly seven calendar days from that start (so today can fall outside them after six days).
  const heldStart = useOvernightHold({ streams, recentlyEnded, today, now })
  const weekStart = heldStart ?? today
  const holdPreviousDay = weekStart.getTime() < today.getTime()

  const rawStreams = useMemo(
    () => streams.map(toScheduledStream).filter((stream): stream is ScheduledStream => stream !== null),
    [streams],
  )

  const weekDays = useMemo(() => getWeekDays(weekStart), [weekStart])

  // The streams that actually land on the displayed grid: the same days, the same local timezone and the same slot rule the grid places by
  // (slotIndexForMs), so a stream outside the displayed range is in neither the grid nor the creator filter's choices.
  const scheduleStreams = useMemo(
    () => rawStreams.filter((stream) => weekDays.some((date) => slotIndexForMs(stream.scheduledStartMs, date) !== null)),
    [rawStreams, weekDays],
  )

  // The creator and organization filters both apply to what is PLACED on the grid (AND-ed, client-side on the already-loaded streams, so
  // changing either never refetches); `scheduleStreams` stays unfiltered by either so the filter's own choices never shrink to the current selection.
  const visibleStreams = useMemo(
    () => filterStreamsByOrganization(filterStreamsByCreators(scheduleStreams, selectedChannelIds), organization),
    [scheduleStreams, selectedChannelIds, organization],
  )

  const days = useMemo<ScheduleDay[]>(() => {
    return weekDays.map((date) => {
      const slots: ScheduledStream[][] = Array.from({ length: SLOT_COUNT }, () => [])
      for (const raw of visibleStreams) {
        const slotIndex = slotIndexForMs(raw.scheduledStartMs, date)
        if (slotIndex === null) continue
        slots[slotIndex].push(raw)
      }
      return { date, isToday: isSameDay(date, today), slots }
    })
  }, [weekDays, visibleStreams, today])

  return { weekStart, days, now, scheduleStreams, holdPreviousDay }
}
