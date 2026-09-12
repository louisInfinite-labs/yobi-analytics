import { createSharedState, useSharedState } from "../lib/sharedState"
import type { UpcomingDisplayMode } from "../lib/creatorStatusFormat"

const STORAGE_KEY = "yobi.upcomingDisplayMode"

function readMode(): UpcomingDisplayMode {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw === "countdown" ? "countdown" : "absolute"
  } catch {
    return "absolute"
  }
}

// Module-scoped singleton (see lib/sharedState.ts) — every
// useUpcomingDisplayMode() call in this tab shares this one store, so a mode
// change from one mounted consumer (Home, Dock) updates every other
// already-mounted consumer immediately (CodeRabbit: per-instance useState
// left other consumers on the old mode after a change elsewhere).
const upcomingDisplayModeStore = createSharedState<UpcomingDisplayMode>(STORAGE_KEY, readMode, (value) => value)

/** The one global "upcoming time display" setting (spec: "Do not create
 * separate Home and Dock status logic; use one formatter/view model") —
 * every consumer of creator status shares this same preference. */
export function useUpcomingDisplayMode() {
  return useSharedState(upcomingDisplayModeStore)
}
