import { useMemo } from "react"
import { useMinuteClock } from "../../../shared/time/minuteClock"
import { getCreatorById, getCreators, toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"
import { useLiveStreams } from "../../../shared/api/hooks/useLiveStreams"
import type { LiveStreamDto } from "../../../shared/api/liveStreams"
import { reclassifyIfPastSchedule } from "../model/creatorStatusFormat"
import { pickStatus } from "../model/creatorStatusSelection"
import type { CreatorStatus } from "../model/creatorStatus"


/** Every canonical creator gets an entry (offline by default) so consumers
 * that iterate the whole roster (CreatorStatusList) always find a status --
 * getCreatorById(dto.creatorId) skips a stream whose creatorId isn't in the
 * generated registry rather than fabricating an entry for it. Keyed by the
 * legacy "ch_"-prefixed id: every existing consumer (CreatorStatusList, Home's
 * useSelectedCreator) already reads this map by that id, not the canonical
 * creatorId (see toLegacyRosterId's own docstring). */
export function statusesFromStreams(streams: LiveStreamDto[], now: Date): Record<string, CreatorStatus> {
  const streamsByCreatorId = new Map<string, LiveStreamDto[]>()
  for (const stream of streams) {
    const creator = getCreatorById(stream.creatorId)
    if (!creator) continue
    const existing = streamsByCreatorId.get(creator.creatorId)
    if (existing) existing.push(stream)
    else streamsByCreatorId.set(creator.creatorId, [stream])
  }

  const statuses: Record<string, CreatorStatus> = {}
  for (const creator of getCreators()) {
    statuses[toLegacyRosterId(creator)] = pickStatus(streamsByCreatorId.get(creator.creatorId), now)
  }
  return statuses
}

/** The shared Holodex-status read every consumer (Home, Dock) goes through
 * (spec: "Holodex data is shared rather than fetched independently by Home,
 * Dock, and Dashboard"). Sourced from Yobi's own GET /live-streams via the
 * shared useLiveStreams poll -- never holodex.net directly, never a Holodex
 * API key in the browser. */
export function useCreatorStatuses(): { statuses: Record<string, CreatorStatus>; now: Date } {
  // The one shared minute clock (also used by the Schedule page): every countdown changes at the same wall-clock instant.
  const now = useMinuteClock()
  const { streams } = useLiveStreams()

  const statuses = useMemo(() => {
    // One `now` for the whole selection: the 24h Live Status window (see
    // creatorStatusSelection.ts) is evaluated against this same instant for every creator.
    const raw = statusesFromStreams(streams, now)
    const reclassified: Record<string, CreatorStatus> = {}
    for (const [channelId, status] of Object.entries(raw)) {
      reclassified[channelId] = reclassifyIfPastSchedule(status, now)
    }
    return reclassified
  }, [streams, now])

  return { statuses, now }
}
