import { toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"
import { parseCreatorRoute } from "../../../app/navigation/creatorRoutes"
import { readSessionHomePath } from "../../../app/navigation/sessionHomePath"
import { createSharedState, useSharedState } from "../../../shared/state/sharedState"
import { readDefaultOshiCreatorId } from "./useDefaultOshiCreator"

// This is "currentOshi" -- the creator Home is showing right now, deliberately kept separate from Settings > 我推設定's own "defaultOshi"
// (useDefaultOshiCreator.ts). It is in-memory runtime state, seeded at page load from the Home route the user last had in THIS browser session
// (sessionHomePath.ts): an explicit /creator/:slug means that creator; the root "/" (or no session yet) means the Oshi/default. A new browser
// session therefore always starts from the Oshi, and nothing here is ever a permanent preference. The router (app/navigation/useCurrentPage.ts)
// keeps it in step with the URL.
function readSelectedCreator(): string {
  const route = parseCreatorRoute(readSessionHomePath())
  if (route?.kind === "creator") return toLegacyRosterId(route.creator)
  return readDefaultOshiCreatorId()
}

// Module-scoped singleton (see lib/sharedState.ts) — every useSelectedCreator() call in this tab shares this one store, so a switch from any
// mounted component updates every other mounted consumer immediately. Purely in memory (null storage): the session Home route is what persists.
export const selectedCreatorStore = createSharedState("yobi.selectedCreator", readSelectedCreator, (value) => value, null)

/** The Home page's single "which creator's room is this" selection — shared app-wide (see selectedCreatorStore above). To CHANGE the creator
 * with the URL following, use selectCreator (app/navigation). */
export function useSelectedCreator() {
  return useSharedState(selectedCreatorStore)
}
