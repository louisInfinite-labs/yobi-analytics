import { createSharedState, useSharedState } from "../lib/sharedState"

const STORAGE_KEY = "yobi.confirmOshiSwitch"

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

// Module-scoped singleton (see lib/sharedState.ts) — so checking "Don't ask
// again" and confirming in one mounted Oshi-switch entry point (e.g. the
// Dock) immediately silences every other mounted one (e.g. Home's panel) in
// the same tab, without a reload/remount.
const confirmOshiSwitchStore = createSharedState<boolean>(STORAGE_KEY, readPreference, (value) => String(value))

/** Global "ask before switching Oshi" preference — not tied to any specific
 * creator (spec: "It applies globally to future Oshi switches"), shared
 * app-wide (see confirmOshiSwitchStore above). Defaults to true; only ever
 * flips to false via the confirmation dialog's own "Don't ask again" +
 * Switch path, never by merely checking the box. */
export function useConfirmOshiSwitchPreference() {
  return useSharedState(confirmOshiSwitchStore)
}
