import { mockCreators } from "../../../entities/creator/data/mockCreators"
import { TIME_START_HOUR } from "../model/scheduleGrid"
import type { ScheduledStream } from "../model/scheduledStream"

/** Same deterministic-hash approach as live-status/data/mockCreatorStatuses.ts. */
function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  }
  return hash
}

const MOCK_TOPICS = [
  "VALORANT ranked",
  "Apex ranked grind",
  "Minecraft building",
  "Street Fighter 6 ranked",
  "Karaoke stream",
  "Zatsudan / free talk",
  "New game first playthrough",
]

function pickTopic(channelId: string, salt: string): string {
  return MOCK_TOPICS[hashString(`${channelId}:${salt}`) % MOCK_TOPICS.length]
}

const DAY_HOURS = 24 - TIME_START_HOUR
// This roster's schedules are conventionally authored/announced in JST
// (fixed UTC+9, no DST) -- generating mock streams against that fixed
// anchor, then letting useWeeklySchedule/scheduleGrid re-localize them via
// ordinary local Date math, is what actually exercises "does this stream
// land on the correct LOCAL day/slot for the viewer's own timezone" rather
// than always landing on the same visual slot no matter who's viewing.
const JST_UTC_OFFSET_HOURS = 9
// weekStart is generated from the viewer's own local calendar (see
// useWeeklySchedule), so the same real JST instant can land a calendar day
// earlier or later depending on the viewer's timezone. Seeding across
// [-1, +7] JST calendar days (not just the visible 0-6) means a stream
// that shifts across midnight into or out of the viewer's visible week
// still gets generated -- scheduleGrid's own per-day slot filtering
// discards whichever candidates don't actually land in a rendered slot.
const CANDIDATE_DAY_OFFSETS = 9

function jstWallClockToUtcMs(year: number, month: number, date: number, hour: number, minute: number): number {
  return Date.UTC(year, month, date, hour - JST_UTC_OFFSET_HOURS, minute)
}

/** Stand-in for the real per-week Holodex schedule (not built yet -- see
 * mockCreatorStatuses.ts's own docstring for the same "swap this module"
 * note; useWeeklySchedule is the one place every consumer already reads
 * through). Deterministic per creator+week, keyed off `weekStart`'s own
 * calendar date (not its absolute timestamp, which would vary by the
 * viewer's own timezone for "the same" calendar week) so paging Prev/Next
 * week doesn't reshuffle an already-viewed week's streams. */
export function getMockWeeklySchedule(weekStart: Date): ScheduledStream[] {
  const streams: ScheduledStream[] = []
  const weekKey = `${weekStart.getFullYear()}-${weekStart.getMonth()}-${weekStart.getDate()}`

  mockCreators.forEach((creator) => {
    const weekSalt = `${creator.channelId}:${weekKey}`
    // 0-2 streams this creator has this week.
    const streamCount = hashString(weekSalt) % 3
    for (let n = 0; n < streamCount; n++) {
      const slotHash = hashString(`${weekSalt}:${n}`)
      const dayOffset = (slotHash % CANDIDATE_DAY_OFFSETS) - 1
      const hourOffset = Math.floor(slotHash / CANDIDATE_DAY_OFFSETS) % DAY_HOURS
      const isHalfHour = Math.floor(slotHash / (CANDIDATE_DAY_OFFSETS * DAY_HOURS)) % 2 === 1

      const scheduledStartMs = jstWallClockToUtcMs(
        weekStart.getFullYear(),
        weekStart.getMonth(),
        weekStart.getDate() + dayOffset,
        TIME_START_HOUR + hourOffset,
        isHalfHour ? 30 : 0,
      )

      const topic = pickTopic(creator.channelId, `stream-${n}`)
      streams.push({
        id: `${creator.channelId}-${weekKey}-${n}`,
        channelId: creator.channelId,
        videoId: `mock_schedule_${creator.channelId}_${weekKey}_${n}`,
        title: topic,
        description: `${creator.channelName} -- ${topic}. Come hang out!`,
        status: "upcoming",
        scheduledStartMs,
        topics: [topic],
      })
    }
  })

  return streams
}
