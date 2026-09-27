import type { CreatorStatus } from "./creatorStatus"
import { formatClockTime, type TimeFormat } from "../../../shared/i18n/model/timeFormat"
import type { Locale } from "../../../shared/i18n/translations"

export type UpcomingDisplayMode = "absolute" | "countdown"

/** Clock time (24-hour HH:mm by default) in the viewer's own local time zone. */
export function formatAbsoluteTime(iso: string, timeFormat: TimeFormat = "24h"): string {
  return formatClockTime(new Date(iso), timeFormat)
}

/** Floors elapsed partial minutes, never negative (spec: "never shows a
 * negative value"). Once the scheduled time is reached this returns the
 * zero form (0 hours/0 minutes, localized per language, e.g. "In 0h:0m" for
 * English); callers reclassify status at that point rather than keep
 * showing a countdown (see isScheduledTimeReached). */
export function formatCountdown(iso: string, now: Date = new Date(), locale: Locale = "ja"): string {
  const totalMinutes = Math.max(0, Math.floor((new Date(iso).getTime() - now.getTime()) / 60000))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (locale === "zh-TW") return `${hours}小時${minutes}分後`
  if (locale === "en") return `In ${hours}h:${minutes}m`
  return `${hours}時間${minutes}分後`
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
    const label = mode === "absolute" ? formatAbsoluteTime(status.scheduledStart, timeFormat) : formatCountdown(status.scheduledStart, now, locale)
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
