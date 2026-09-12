import { useSyncExternalStore } from "react"

let expanded = false
const listeners = new Set<() => void>()

function getSnapshot(): boolean {
  return expanded
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** LiveScheduleDock is the only writer (it mirrors its own internal
 * `expanded` state here via a useEffect) -- this lets other, unrelated
 * components (Home's own home-scene width, see useLiveDockExpanded below)
 * react to "is the dock panel currently open" without a shared ancestor to
 * lift that state into. Deliberately NOT built on lib/sharedState.ts's
 * createSharedState: this is transient UI state, not a saved preference, so
 * it must NOT persist to localStorage -- every fresh page load starts with
 * the dock closed regardless of what it was before a refresh. */
export function setLiveDockExpanded(next: boolean): void {
  if (next === expanded) return
  expanded = next
  listeners.forEach((listener) => listener())
}

/** Whether the global Live Schedule Dock panel is currently expanded -- the
 * dock floats as a fixed-position overlay with no layout space reserved
 * for it, so Home's own scene frame needs to know when to shrink itself
 * (staying flush against the dock's edges, never overlapped by it) rather
 * than sit underneath it. Read-only for every consumer except
 * LiveScheduleDock itself. */
export function useLiveDockExpanded(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** Test-only: resets the module-level singleton between tests (see
 * lib/sharedState.ts's own resetAllSharedStateForTests for the same
 * singleton-leaks-across-tests problem this solves). */
export function resetLiveDockExpandedForTests(): void {
  expanded = false
}
