import type { ReminderSettingsSnapshot } from "../../notifications/api/liveReminderApi"

export type StreamNotificationOverrideCache = ReminderSettingsSnapshot

function emptyCache(): StreamNotificationOverrideCache {
  return { creatorAll: {}, creatorTopics: {}, streamOverrides: {} }
}

/** Module-scoped singleton cache of the REAL backend-persisted reminder settings
 * (creator 全部, creator + topic, single-stream overrides --
 * src/notifications/live_reminder.py) --
 * not localStorage: the backend notification dispatcher is the actual
 * source of truth this must reflect, and a browser-only store it can't see
 * is explicitly insufficient for this feature. Same reactive module-level-
 * singleton SHAPE as shared/state/sharedState.ts (one in-memory value, every
 * mounted subscriber notified on change), deliberately without that
 * module's localStorage persistence half, which doesn't apply to data whose
 * authoritative copy lives on the backend.
 *
 * Deliberately its OWN file, importing nothing from liveReminderApi.ts
 * (only its types): src/test/setup.ts imports this module's reset function
 * directly (the same pattern every other module-level-singleton reset
 * already uses there) so every test starts fresh -- if that reset lived in
 * useStreamNotificationOverride.ts instead, setup.ts's own import would
 * resolve liveReminderApi.ts for real before any individual test file's own
 * vi.mock of it ever gets a chance to apply, since a module already
 * evaluated once for a real dependency isn't retroactively swapped for a
 * later-registered mock of the same path. */
let cache: StreamNotificationOverrideCache = emptyCache()
let fetchStarted = false
// Bumped on every test reset so a fetch kicked off by an earlier test (still
// in flight when that test ended) can tell, once its promise finally
// settles, that it's been superseded -- without this, a slow/leftover
// resolution would overwrite a later test's freshly-fetched cache with
// stale data race-style, since a reset can't cancel an in-flight fetch,
// only the fetch it starts afterward.
let generation = 0
const listeners = new Set<() => void>()

export function getCache(): StreamNotificationOverrideCache {
  return cache
}

export function getGeneration(): number {
  return generation
}

export function isFetchStarted(): boolean {
  return fetchStarted
}

export function markFetchStarted(): void {
  fetchStarted = true
}

export function resetFetchStarted(): void {
  fetchStarted = false
}

export function setCache(next: StreamNotificationOverrideCache): void {
  cache = next
  listeners.forEach((listener) => listener())
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Test-only: resets this module-level cache so each test starts fresh
 * instead of carrying over another test's fetched/saved data (same
 * reasoning as sharedState.ts's resetAllSharedStateForTests -- a singleton
 * doesn't get recreated per test the way a component-local useState would). */
export function resetStreamNotificationOverrideCacheForTests(): void {
  generation += 1
  cache = emptyCache()
  fetchStarted = false
}
