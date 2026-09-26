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

/** Stand-in for the real per-week Holodex schedule (not built yet -- see
 * mockCreatorStatuses.ts's own docstring for the same "swap this module"
 * note; useWeeklySchedule is the one place every consumer already reads
 * through). Deterministic per creator+week (keyed off `weekStart`'s own
 * timestamp) so paging Prev/Next week doesn't reshuffle an already-viewed
 * week's streams, while still varying week to week. */
export function getMockWeeklySchedule(weekStart: Date): ScheduledStream[] {
  const streams: ScheduledStream[] = []
  const weekKey = weekStart.getTime()

  mockCreators.forEach((creator) => {
    const weekSalt = `${creator.channelId}:${weekKey}`
    // 0-2 streams this creator has this week.
    const streamCount = hashString(weekSalt) % 3
    for (let n = 0; n < streamCount; n++) {
      const slotHash = hashString(`${weekSalt}:${n}`)
      const dayOffset = slotHash % 7
      const hourOffset = Math.floor(slotHash / 7) % DAY_HOURS
      const isHalfHour = Math.floor(slotHash / (7 * DAY_HOURS)) % 2 === 1

      const start = new Date(weekStart)
      start.setDate(start.getDate() + dayOffset)
      start.setHours(TIME_START_HOUR + hourOffset, isHalfHour ? 30 : 0, 0, 0)

      const topic = pickTopic(creator.channelId, `stream-${n}`)
      streams.push({
        id: `${creator.channelId}-${weekKey}-${n}`,
        channelId: creator.channelId,
        videoId: `mock_schedule_${creator.channelId}_${weekKey}_${n}`,
        title: topic,
        description: `${creator.channelName} -- ${topic}. Come hang out!`,
        status: "upcoming",
        scheduledStartMs: start.getTime(),
        topics: [topic],
      })
    }
  })

  return streams
}
