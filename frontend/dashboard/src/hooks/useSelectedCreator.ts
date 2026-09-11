import { mockCreators } from "../data/mockCreators"
import { createSharedState, useSharedState } from "../lib/sharedState"

const STORAGE_KEY = "yobi.home.selectedCreatorId"

function isKnownCreator(creatorId: string): boolean {
  return mockCreators.some((creator) => creator.channelId === creatorId)
}

function readSelectedCreator(): string {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw && isKnownCreator(raw)) return raw
  } catch {
    // Fall through to the default below.
  }
  return mockCreators[0].channelId
}

// Module-scoped singleton (see lib/sharedState.ts) — every useSelectedCreator()
// call in this tab shares this one store, so switching Oshi from any mounted
// component (Dock, Home, ...) updates every other mounted consumer
// immediately instead of only agreeing at each component's own mount time.
const selectedCreatorStore = createSharedState(STORAGE_KEY, readSelectedCreator, (value) => value)

/** The Home page's single "which creator's room is this" selection — shared
 * app-wide (see selectedCreatorStore above) and persisted like every other
 * lightweight Home setting (localStorage; spec's own state-boundary table
 * keeps "selected creator" in localStorage, separate from the shared cache
 * other views read). */
export function useSelectedCreator() {
  return useSharedState(selectedCreatorStore)
}
