import { readSessionCreatorId } from "../../../app/navigation/sessionCreator"
import { createSharedState, useSharedState } from "../../../shared/state/sharedState"
import { readDefaultOshiCreatorId } from "./useDefaultOshiCreator"

// This is "currentOshi" -- the creator Home is showing right now, deliberately kept separate from Settings > 我推設定's own "defaultOshi"
// (useDefaultOshiCreator.ts). It is in-memory runtime state, seeded at page load from the creator this browser session last switched to
// (sessionCreator.ts), else the Oshi/default. A new browser session therefore always starts from the Oshi, and nothing here is ever a permanent
// preference. It is never part of the URL: Home is always "/".
function readSelectedCreator(): string {
  return readSessionCreatorId() ?? readDefaultOshiCreatorId()
}

// Module-scoped singleton (see lib/sharedState.ts) — every useSelectedCreator() call in this tab shares this one store, so a switch from any
// mounted component updates every other mounted consumer immediately. Purely in memory (null storage): the session creator is what persists.
export const selectedCreatorStore = createSharedState("yobi.selectedCreator", readSelectedCreator, (value) => value, null)

/** The Home page's single "which creator's room is this" selection — shared app-wide (see selectedCreatorStore above). To CHANGE the creator,
 * use selectCreator (app/navigation). */
export function useSelectedCreator() {
  return useSharedState(selectedCreatorStore)
}
