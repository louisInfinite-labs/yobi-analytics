import { useEffect, useMemo, useState } from "react"
import { getMockCreatorStatuses } from "../data/mockCreatorStatuses"
import { reclassifyIfPastSchedule } from "../lib/creatorStatusFormat"
import type { CreatorStatus } from "../types/creatorStatus"

const TICK_MS = 30_000 // spec: countdown "updates at least once per minute" — twice that margin

/** The shared Holodex-status read every consumer (Home, Dock) goes through
 * (spec: "Holodex data is shared rather than fetched independently by Home,
 * Dock, and Dashboard"). Computed once per tick, not re-fetched on every
 * render or every time the Dock opens. Backed by mock data for now — see
 * mockCreatorStatuses.ts's own docstring for the real-integration swap
 * point; this hook is the one place every consumer already goes through,
 * so only this file's internals need to change later, not its callers. */
export function useCreatorStatuses(): { statuses: Record<string, CreatorStatus>; now: Date } {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), TICK_MS)
    return () => clearInterval(interval)
  }, [])

  const statuses = useMemo(() => {
    const raw = getMockCreatorStatuses(now)
    const reclassified: Record<string, CreatorStatus> = {}
    for (const [channelId, status] of Object.entries(raw)) {
      reclassified[channelId] = reclassifyIfPastSchedule(status, now)
    }
    return reclassified
  }, [now])

  return { statuses, now }
}
