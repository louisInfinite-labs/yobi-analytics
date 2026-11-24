import type { VideoContentType } from "./oshiVideosQuery"
import { SHORT_VIDEO_FILTER, type VideoSectionSelection } from "./specialVideoFilters"

/** F37 "On this day": every date here is a calendar date in the app's own Tokyo rule (the same canonical zone the backend dates the memories in). */
export const ON_THIS_DAY_TIME_ZONE = "Asia/Tokyo"

/** A month/day with no year: the thing the control selects. February 29 is a valid value (it simply has results only in leap years). */
export interface MonthDay {
  month: number
  day: number
}

/** 2024 is a leap year, so it is the calendar every month/day computation walks (Feb has 29 days, Dec 31 -> Jan 1 wraps). */
const CALENDAR_YEAR = 2024

/** Today's month/day in Tokyo, whatever the browser's own zone is. */
export function todayMonthDay(now: Date = new Date()): MonthDay {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: ON_THIS_DAY_TIME_ZONE, month: "numeric", day: "numeric" }).formatToParts(now)
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  return { month: pick("month"), day: pick("day") }
}

/** How many days a month can have (February is 29: the leap day is selectable). */
export function daysInMonth(month: number): number {
  return new Date(Date.UTC(CALENDAR_YEAR, month, 0)).getUTCDate()
}

/** Keeps a day inside its month (switching from Jan 31 to February lands on Feb 29, never an invalid date). */
export function clampMonthDay({ month, day }: MonthDay): MonthDay {
  return { month, day: Math.min(Math.max(1, day), daysInMonth(month)) }
}

/** The month/day `delta` days away, wrapping across the year boundary (Dec 31 + 1 = Jan 1) and passing through Feb 29. */
export function shiftMonthDay({ month, day }: MonthDay, delta: number): MonthDay {
  const shifted = new Date(Date.UTC(CALENDAR_YEAR, month - 1, day + delta))
  return { month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() }
}

/** What the backend filters by, derived from the tag bar's selection and the content-type dropdown the Video List already has. */
export interface OnThisDayFilters {
  topic: string
  contentType: VideoContentType | "short"
  excludeShorts: boolean
}

/** The ONE place the Video List's existing controls become an On-this-day filter: ALL = every topic, a topic tag = that topic, the two
 * quick filters = their fixed content type, Short = the Short content format; the content-type dropdown narrows ALL / a topic exactly
 * as it does for the shelf. Like the shelf, ALL and topics leave Shorts out (Short is its own category). */
export function buildOnThisDayFilters(selection: VideoSectionSelection, contentType: VideoContentType): OnThisDayFilters {
  if (selection === SHORT_VIDEO_FILTER) return { topic: "all", contentType: "short", excludeShorts: false }
  if (selection === "latestVideos") return { topic: "all", contentType: "upload", excludeShorts: true }
  if (selection === "latestLive") return { topic: "all", contentType: "live", excludeShorts: true }
  return { topic: selection, contentType, excludeShorts: true }
}

/** Stable identity of one On-this-day request: the same key asks for the same data. */
export function onThisDayQueryKey(creatorId: string, monthDay: MonthDay, filters: OnThisDayFilters): string {
  return JSON.stringify([creatorId, monthDay.month, monthDay.day, filters.topic, filters.contentType, filters.excludeShorts])
}
