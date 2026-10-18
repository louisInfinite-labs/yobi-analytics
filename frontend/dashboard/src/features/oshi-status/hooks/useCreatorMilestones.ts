import { useEffect, useState } from "react"
import { getCachedCreatorMilestones, loadCreatorMilestones, type CreatorMilestones } from "../data/creatorMilestones"

export type CreatorMilestonesState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; milestones: CreatorMilestones }
  | { status: "not_found" }
  | { status: "error" }

interface Settled {
  /** The creator this outcome belongs to -- an outcome is only ever shown for ITS OWN creator. */
  creatorId: string
  state: Exclude<CreatorMilestonesState, { status: "idle" } | { status: "loading" }>
}

/** The fixed milestone dates of the CURRENT creator, requested only while `enabled` (the dialog is open) and at most once per creator per page
 * session (see loadCreatorMilestones). Like useOshiStatus, an outcome is keyed by its creator and only returned for the current one, so a
 * previous creator dates never show after a switch, and a response that arrives after a switch is ignored. */
export function useCreatorMilestones(creatorId: string | undefined, enabled: boolean): CreatorMilestonesState {
  const [outcome, setOutcome] = useState<Settled | null>(null)

  useEffect(() => {
    if (!enabled || !creatorId) return
    if (getCachedCreatorMilestones(creatorId)) return
    let cancelled = false
    loadCreatorMilestones(creatorId)
      .then((result) => {
        if (cancelled) return
        setOutcome({ creatorId, state: result.kind === "found" ? { status: "ready", milestones: result.milestones } : { status: "not_found" } })
      })
      .catch(() => {
        if (!cancelled) setOutcome({ creatorId, state: { status: "error" } })
      })
    return () => {
      cancelled = true
      // Closing the dialog (or switching creator) forgets a failure, so the next open shows loading and retries instead of the old error.
      setOutcome((previous) => (previous && previous.state.status === "error" ? null : previous))
    }
  }, [creatorId, enabled])

  if (!enabled || !creatorId) return { status: "idle" }
  const cached = getCachedCreatorMilestones(creatorId)
  if (cached) return cached.kind === "found" ? { status: "ready", milestones: cached.milestones } : { status: "not_found" }
  if (outcome && outcome.creatorId === creatorId) return outcome.state
  return { status: "loading" }
}