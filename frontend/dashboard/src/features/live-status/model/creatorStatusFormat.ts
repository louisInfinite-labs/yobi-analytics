import type { CreatorStatus } from "./creatorStatus"
import { formatClockTime, type TimeFormat } from "../../../shared/i18n/model/timeFormat"
import type { Locale } from "../../../shared/i18n/translations"

export type UpcomingDisplayMode = "absolute" | "countdown"

/** Clock time (24-hour HH:mm by default) in the viewer's own local time zone. */
export function formatAbsoluteTime(iso: string, timeFormat: TimeFormat = "24h"): string {
  return formatClockTime(new Date(iso), timeFormat)
}

/** Whole minutes between two instants (floored, never negative -- spec: "never shows a negative value"). */
function wholeMinutes(fromMs: number, toMs: number): number {
  return Math.max(0, Math.floor((toMs - fromMs) / 60000))
}

/** The ONE hours+minutes duration wording shared by every relative stream-time display (Home's dock and Oshi Status, the Schedule page,
 * the stream detail popup): the hour part is omitted entirely while it is 0 ("5分鐘後", never "0小時5分鐘後"), and an hour or more reads
 * "1小時5分鐘後" -- never a minute-only "65分鐘後". `direction` picks "in ..." (an upcoming start) or "... ago" (a stream that started). */
function formatRelativeDuration(totalMinutes: number, direction: "later" | "ago", locale: Locale): string {
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (locale === "zh-TW") {
    const span = hours > 0 ? `${hours}小時${minutes}分鐘` : `${minutes}分鐘`
    return direction === "later" ? `${span}後` : `${span}前開始`
  }
  if (locale === "en") {
    const span = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
    return direction === "later" ? `In ${span}` : `Started ${span} ago`
  }
  const span = hours > 0 ? `${hours}時間${minutes}分` : `${minutes}分`
  return direction === "later" ? `${span}後` : `${span}前に開始`
}

/** An upcoming stream's countdown ("5分鐘後" / "1小時5分鐘後"): whole minutes until `iso`, floored, never negative. Once the scheduled
 * time is reached this returns the zero form ("0分鐘後"); callers reclassify status at that point rather than keep showing a countdown
 * (see isScheduledTimeReached). */
export function formatCountdown(iso: string, now: Date = new Date(), locale: Locale = "ja"): string {
  return formatRelativeDuration(wholeMinutes(now.getTime(), new Date(iso).getTime()), "later", locale)
}

/** How long a currently-live stream has been running ("5分鐘前開始" / "5小時49分鐘前開始"): whole minutes since `iso` (the stream's ACTUAL
 * start), floored, never negative, in the same hours+minutes wording as formatCountdown. */
export function formatStartedAgo(iso: string, now: Date = new Date(), locale: Locale = "ja"): string {
  return formatRelativeDuration(wholeMinutes(new Date(iso).getTime(), now.getTime()), "ago", locale)
}

/** The ONE formatter for an upcoming stream's start, shared by Home (Live Status dock, Oshi Status) and the Schedule page: the user's
 * "upcoming time display" setting picks between the clock time (12h/24h per the global time format) and the countdown. */
export function formatUpcomingStart(
  iso: string,
  mode: UpcomingDisplayMode,
  now: Date = new Date(),
  locale: Locale = "ja",
  timeFormat: TimeFormat = "24h",
): string {
  return mode === "absolute" ? formatAbsoluteTime(iso, timeFormat) : formatCountdown(iso, now, locale)
}

/** The ONE formatter for a currently-live stream's start, the counterpart of formatUpcomingStart and driven by the same "upcoming time
 * display" setting: the clock time the stream actually started at (12h/24h per the global time format), or how long ago it started.
 * `iso` must be the stream's actual start time, never its published/scheduled one. */
export function formatLiveStart(
  iso: string,
  mode: UpcomingDisplayMode,
  now: Date = new Date(),
  locale: Locale = "ja",
  timeFormat: TimeFormat = "24h",
): string {
  return mode === "absolute" ? formatAbsoluteTime(iso, timeFormat) : formatStartedAgo(iso, now, locale)
}

export function isScheduledTimeReached(iso: string, now: Date = new Date()): boolean {
  return new Date(iso).getTime() <= now.getTime()
}

export interface CreatorStatusDisplay {
  label: string
  dotColor: "red" | "grey"
  clickable: boolean
}

/** The status table's four display forms (spec's "Shared Holodex Status Model"). */
export function formatCreatorStatus(
  status: CreatorStatus,
  mode: UpcomingDisplayMode,
  now: Date = new Date(),
  locale: Locale = "ja",
  timeFormat: TimeFormat = "24h",
): CreatorStatusDisplay {
  if (status.kind === "live") {
    return { label: "LIVE", dotColor: "red", clickable: true }
  }
  if (status.kind === "upcoming") {
    const label = formatUpcomingStart(status.scheduledStart, mode, now, locale, timeFormat)
    return { label, dotColor: "red", clickable: true }
  }
  return { label: "OFFLINE", dotColor: "grey", clickable: false }
}

/** Reclassifies an "upcoming" status to "offline" once its scheduled time
 * has passed without ever having been observed to go live — this hook's
 * mock data source has no live-transition mechanism, so a stale upcoming
 * entry would otherwise sit past its own start time forever (spec: "Refresh/
 * reclassify status when the scheduled time is reached"). A real Holodex
 * source instead re-fetches and gets the server's own updated status. */
export function reclassifyIfPastSchedule(status: CreatorStatus, now: Date = new Date()): CreatorStatus {
  if (status.kind === "upcoming" && isScheduledTimeReached(status.scheduledStart, now)) {
    return { kind: "offline" }
  }
  return status
}
