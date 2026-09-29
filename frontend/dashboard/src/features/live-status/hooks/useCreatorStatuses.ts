import { useEffect, useMemo, useState } from "react"
import { getCreatorById, getCreators, toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"
import { useLiveStreams } from "../../../shared/api/hooks/useLiveStreams"
import type { LiveStreamDto } from "../../../shared/api/liveStreams"
import { reclassifyIfPastSchedule } from "../model/creatorStatusFormat"
import type { CreatorStatus } from "../model/creatorStatus"

const TICK_MS = 30_000 // spec: countdown "updates at least once per minute" — twice that margin

/** kind priority per creator: live first, otherwise the nearest upcoming
 * stream, otherwise offline (spec, same rule creatorStatus.ts documents). */
function pickStatus(streams: LiveStreamDto[] | undefined): CreatorStatus {
  if (!streams || streams.length === 0) return { kind: "offline" }

  const live = streams.find((stream) => stream.status === "live")
  if (live) return { kind: "live", videoId: live.videoId, title: live.title }

  const nearestUpcoming = streams
    .filter((stream): stream is LiveStreamDto & { scheduledStart: string } => stream.status === "upcoming" && stream.scheduledStart !== null)
    .sort((a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime())[0]
  if (nearestUpcoming) {
    return { kind: "upcoming", videoId: nearestUpcoming.videoId, title: nearestUpcoming.title, scheduledStart: nearestUpcoming.scheduledStart }
  }

  return { kind: "offline" }
}

/** Every canonical creator gets an entry (offline by default) so consumers
 * that iterate the whole roster (CreatorStatusList) always find a status --
 * getCreatorById(dto.creatorId) skips a stream whose creatorId isn't in the
 * generated registry rather than fabricating an entry for it. Keyed by the
 * legacy "ch_"-prefixed id: every existing consumer (CreatorStatusList, Home's
 * useSelectedCreator) already reads this map by that id, not the canonical
 * creatorId (see toLegacyRosterId's own docstring). */
function statusesFromStreams(streams: LiveStreamDto[]): Record<string, CreatorStatus> {
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
    statuses[toLegacyRosterId(creator)] = pickStatus(streamsByCreatorId.get(creator.creatorId))
  }
  return statuses
}

/** The shared Holodex-status read every consumer (Home, Dock) goes through
 * (spec: "Holodex data is shared rather than fetched independently by Home,
 * Dock, and Dashboard"). Sourced from Yobi's own GET /live-streams via the
 * shared useLiveStreams poll -- never holodex.net directly, never a Holodex
 * API key in the browser. */
export function useCreatorStatuses(): { statuses: Record<string, CreatorStatus>; now: Date } {
  const [now, setNow] = useState(() => new Date())
  const { streams } = useLiveStreams()

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), TICK_MS)
    return () => clearInterval(interval)
  }, [])

  const statuses = useMemo(() => {
    const raw = statusesFromStreams(streams)
    const reclassified: Record<string, CreatorStatus> = {}
    for (const [channelId, status] of Object.entries(raw)) {
      reclassified[channelId] = reclassifyIfPastSchedule(status, now)
    }
    return reclassified
  }, [streams, now])

  return { statuses, now }
}
