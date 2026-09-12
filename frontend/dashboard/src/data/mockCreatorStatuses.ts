import { mockCreators } from "./mockCreators"
import type { CreatorStatus } from "../types/creatorStatus"

/** Same deterministic-hash approach as theme/memberAccent.ts's getMemberAccent. */
function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  }
  return hash
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
        title: `【配信】${creator.channelName}`,
      }
    } else if (bucket === 1) {
      // Staggered offsets (15m, 45m, 75m, ...) so the Dock shows a mix of
      // "soon" and "later" upcoming rows instead of every mock creator
      // going live at once.
      const offsetMinutes = 15 + (index % 4) * 30
      statuses[creator.channelId] = {
        kind: "upcoming",
        videoId: `mock_upcoming_${creator.channelId}`,
        title: `【予定】${creator.channelName}`,
        scheduledStart: new Date(now.getTime() + offsetMinutes * 60000).toISOString(),
      }
    } else {
      statuses[creator.channelId] = { kind: "offline" }
    }
  })
  return statuses
}
