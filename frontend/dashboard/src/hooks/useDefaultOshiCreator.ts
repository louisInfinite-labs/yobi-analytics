import { mockCreators } from "../data/mockCreators"
import { createSharedState, useSharedState } from "../lib/sharedState"
import { isEligibleForMyOshi } from "../lib/myOshiEligibility"

const STORAGE_KEY = "yobi.defaultOshiCreatorId"

function isKnownEligibleCreator(channelId: string): boolean {
  return mockCreators.some((creator) => creator.channelId === channelId && isEligibleForMyOshi(creator))
}

/** Exported (not just used internally) so useSelectedCreator.ts can seed its
 * own in-session value from this same persisted pick at its own module
 * load -- see that file's own comment. */
export function readDefaultOshiCreatorId(): string {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw && isKnownEligibleCreator(raw)) return raw
  } catch {
    // Fall through to the default below.
  }
  return mockCreators[0].channelId
}

// Module-scoped singleton (see lib/sharedState.ts).
const defaultOshiStore = createSharedState(STORAGE_KEY, readDefaultOshiCreatorId, (value) => value)

/** Settings > 我推設定's own persistent single-Oshi pick -- confirmed with
 * the user, this is "defaultOshi": the creator Home shows on a fresh app
 * startup, kept entirely separate from useSelectedCreator's own
 * "currentOshi" (the creator the user happens to be viewing THIS session,
 * which changes freely while navigating around the app). Only picking a
 * creator on the 我推設定 page itself ever updates this store -- switching
 * creator anywhere else in the app never touches it. */
export function useDefaultOshiCreator() {
  return useSharedState(defaultOshiStore)
}
