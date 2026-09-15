import { createSharedState, useSharedState } from "../lib/sharedState"
import { readDefaultOshiCreatorId } from "./useDefaultOshiCreator"

const STORAGE_KEY = "yobi.home.selectedCreatorId"

// This is "currentOshi" -- confirmed with the user, deliberately kept
// separate from Settings > 我推設定's own "defaultOshi" (useDefaultOshiCreator.ts):
// in-session runtime state only, always re-seeded from defaultOshi's own
// persisted pick at the start of EVERY fresh page load (module load), never
// from whichever creator this tab last had selected in a PRIOR session --
// this hook's own STORAGE_KEY below is still written on every switch (see
// createSharedState's own set()), but deliberately never read back here, so
// reopening the app never resumes a previous session's in-app switch.
// Switching creator within one already-open session (Dock, CreatorStatusList,
// ...) still works exactly as before -- read() only ever runs once, at this
// module's own load, never again for the rest of that session.
function readSelectedCreator(): string {
  return readDefaultOshiCreatorId()
}

// Module-scoped singleton (see lib/sharedState.ts) — every useSelectedCreator()
// call in this tab shares this one store, so switching Oshi from any mounted
// component (Dock, Home, ...) updates every other mounted consumer
// immediately instead of only agreeing at each component's own mount time.
const selectedCreatorStore = createSharedState(STORAGE_KEY, readSelectedCreator, (value) => value)

/** The Home page's single "which creator's room is this" selection — shared
 * app-wide (see selectedCreatorStore above), in-session runtime state (see
 * readSelectedCreator's own comment above for why this no longer persists
 * across a full app reopen the way it used to). */
export function useSelectedCreator() {
  return useSharedState(selectedCreatorStore)
}
