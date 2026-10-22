import { useEffect, useState } from "react"
import { getCachedAllCreatorMilestones, hasUsableMilestoneDate, loadAllCreatorMilestones } from "../data/allCreatorMilestones"

/** Whether this creator has at least one usable birthday or debut date, so the calendar icon is worth showing. It reads the ONE shared bulk milestones read the
 * Live Status list already uses (held in memory, shared by every component, no request of its own per creator and no polling). False while that read is
 * loading or unreadable and for any creator the read does not list or lists without a usable date -- decided only by the data, never by a name or a type. */
export function useHasMilestoneDates(creatorId: string | undefined): boolean {
  const [held, setHeld] = useState(() => getCachedAllCreatorMilestones())

  useEffect(() => {
    let cancelled = false
    loadAllCreatorMilestones()
      .then((result) => {
        if (!cancelled) setHeld((previous) => (previous === result ? previous : result))
      })
      .catch(() => {
        // Nothing held and unreadable: no icon (never a guess). The loader holds off retrying for a while.
      })
    return () => {
      cancelled = true
    }
  }, [])

  return creatorId !== undefined && held !== null && hasUsableMilestoneDate(held[creatorId])
}
