import { formatLiveStart, formatUpcomingStart, type UpcomingDisplayMode } from "../../live-status/model/creatorStatusFormat"
import type { TimeFormat } from "../../../shared/i18n/model/timeFormat"
import type { Locale } from "../../../shared/i18n/translations"
import type { ScheduledStream } from "./scheduledStream"

/** A scheduled stream's start text, from creatorStatusFormat's shared formatters (the same ones Home's dock and Oshi Status and the Schedule
 * page use), so the user's "upcoming time display" setting (clock time vs relative) and 12h/24h format apply exactly as on Home: an upcoming
 * stream uses its scheduled start, a live stream its ACTUAL start (the scheduled start only when the backend reported no actual one). An
 * ended stream has no start text. Used by the stream detail popup and the Schedule grid's "+N" hidden-streams popover, so they always agree. */
export function streamStartText(
  stream: ScheduledStream,
  locale: Locale,
  nowMs: number,
  mode: UpcomingDisplayMode,
  timeFormat: TimeFormat,
): string | null {
  if (stream.status === "ended") return null
  const now = new Date(nowMs)
  if (stream.status === "live") {
    return formatLiveStart(new Date(stream.actualStartMs ?? stream.scheduledStartMs).toISOString(), mode, now, locale, timeFormat)
  }
  return formatUpcomingStart(new Date(stream.scheduledStartMs).toISOString(), mode, now, locale, timeFormat)
}
