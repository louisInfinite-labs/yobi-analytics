/** The fetch-once guard/generation counter, split out of aboutContentStore.ts
 * into this dependency-free sibling module on purpose: src/test/setup.ts
 * must import a reset hook for this state globally, but importing it
 * straight from aboutContentStore.ts would also eagerly import that
 * module's own `fetchAboutContent` -- binding every test file's module
 * graph to the REAL implementation before that test file's own
 * `vi.mock("./api/aboutContentApi", ...)` call gets a chance to intercept
 * it (the same gotcha useStreamNotificationOverride's own cache module
 * documents). This module imports nothing, so setup.ts importing it has no
 * such side effect. */

let fetchStarted = false
let generation = 0

export function isFetchStarted(): boolean {
  return fetchStarted
}

export function markFetchStarted(): void {
  fetchStarted = true
}

export function getGeneration(): number {
  return generation
}

/** Test-only: lets a focused test exercise a second ensureAboutContentLoaded()
 * call without needing a full module re-import -- same reset-hook shape
 * src/test/setup.ts already wires up for useLiveDockExpanded/
 * useHomeSelectedVideo/liveStreamsPollState. */
export function resetAboutContentFetchForTests(): void {
  fetchStarted = false
  generation += 1
}
