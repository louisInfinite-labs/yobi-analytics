import { createSharedState, useSharedState } from "../../../shared/state/sharedState"

const STORAGE_KEY = "yobi.confirmMarkAllWatched"

function readPreference(): boolean {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === "false") return false
    if (raw === "true") return true
  } catch {
    // Fall through to the default below.
  }
  return true
}

const confirmMarkAllWatchedStore = createSharedState<boolean>(STORAGE_KEY, readPreference, (value) => String(value))

/** Whether the Mark all watched button asks before marking. Its own key, separate from the Oshi-switch confirmation: opting out of one never silences the other. Defaults to
 * true; only the dialog's "Don't ask again" + confirm path ever sets it to false (Cancel never persists it). */
export function useConfirmMarkAllWatchedPreference() {
  return useSharedState(confirmMarkAllWatchedStore)
}
