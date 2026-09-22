import { mockCreators } from "../../../entities/creator/data/mockCreators"
import type { CreatorStatus } from "../model/creatorStatus"

/** Same deterministic-hash approach as theme/memberAccent.ts's getMemberAccent. */
function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  }
  return hash
}

/** Mock stream topics, deliberately never the creator's own name — the
 * secondary line under a Live Status row is this title, and a name-shaped
 * title (e.g. "【配信】<channelName>") reads as the row just repeating the
 * name above it. Matches the app's own existing game/topic vocabulary
 * (features/home-room/model/videoCategories.ts's VideoCategory tags)
 * instead of inventing unrelated flavor text. */
const MOCK_LIVE_TOPICS = [
  "VALORANT ranked",
  "Apex ranked grind",
  "Minecraft building",
  "Street Fighter 6 ranked",
  "Karaoke stream",
  "Zatsudan / free talk",
  "New game first playthrough",
]

const MOCK_UPCOMING_TOPICS = [
  "VALORANT custom match",
  "Apex ranked",
  "Minecraft build stream",
  "Street Fighter 6 practice",
  "Karaoke",
  "Zatsudan / free talk",
  "Collab announcement",
]

function pickMockTopic(topics: string[], channelId: string, salt: string): string {
  return topics[hashString(`${channelId}:${salt}`) % topics.length]
}

/** Stand-in for the real shared Holodex store (Roadmap Phase 9 — not built
 * yet, see this session's own scoping discussion). Deterministic per
 * creator so the Dock/status UI has a stable, varied mix of live/upcoming/
 * offline to develop and test against; swap this module's export for the
 * real fetched-and-cached Holodex result once that integration exists —
 * every consumer already reads through useCreatorStatuses, not this file
 * directly, so that swap touches one place. */
export function getMockCreatorStatuses(now: Date = new Date()): Record<string, CreatorStatus> {
  const statuses: Record<string, CreatorStatus> = {}
  mockCreators.forEach((creator, index) => {
    const bucket = hashString(creator.channelId) % 3
    if (bucket === 0) {
      statuses[creator.channelId] = {
        kind: "live",
        videoId: `mock_live_${creator.channelId}`,
        title: pickMockTopic(MOCK_LIVE_TOPICS, creator.channelId, "live"),
      }
    } else if (bucket === 1) {
      // Staggered offsets (15m, 45m, 75m, ...) so the Dock shows a mix of
      // "soon" and "later" upcoming rows instead of every mock creator
      // going live at once.
      const offsetMinutes = 15 + (index % 4) * 30
      statuses[creator.channelId] = {
        kind: "upcoming",
        videoId: `mock_upcoming_${creator.channelId}`,
        title: pickMockTopic(MOCK_UPCOMING_TOPICS, creator.channelId, "upcoming"),
        scheduledStart: new Date(now.getTime() + offsetMinutes * 60000).toISOString(),
      }
    } else {
      statuses[creator.channelId] = { kind: "offline" }
    }
  })
  return statuses
}
