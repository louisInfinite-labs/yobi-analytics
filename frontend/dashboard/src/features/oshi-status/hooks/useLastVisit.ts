import { createSharedState, useSharedState } from "../../../shared/state/sharedState"

const STORAGE_KEY = "yobi.home.lastVisitAt"

/** How far back a DEV reset rewinds the stored visit -- far enough that the
 * mock unseen video entries (see mockRecentVideos.ts's 5/20-minutes-ago
 * entries) always land after it again, however long this tab has been open. */
const RESET_LOOKBACK_MS = 24 * 60 * 60 * 1000

/** Null on a first visit, an unparseable stored value, or a storage read
 * failure (private browsing, quota) -- every case just means "nothing to
 * compare against yet", not an error worth surfacing. */
function readPreviousVisit(): Date | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = new Date(raw)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  } catch {
    return null
  }
}

function serializePreviousVisit(value: Date | null): string {
  return value ? value.toISOString() : ""
}

// Captured once at module load, BEFORE the stamp below overwrites it -- the
// whole point of "since your last visit" is the previous session's
// timestamp, which reading lazily (per mount/render) would have already
// clobbered. Wrapped in createSharedState (same pattern as
// useSelectedCreator/useFavoriteCreators/useLocale) rather than a plain
// module-level constant, so the DEV-only reset below can update every
// mounted OshiStatusPanel in this tab without a full page reload.
function readAndStampPreviousVisit(): Date | null {
  const previous = readPreviousVisit()
  try {
    window.localStorage.setItem(STORAGE_KEY, new Date().toISOString())
  } catch {
    // Best-effort, matching every other localStorage writer in this app: a
    // failed stamp only means the next session sees an older window.
  }
  return previous
}

const previousVisitStore = createSharedState<Date | null>(STORAGE_KEY, readAndStampPreviousVisit, serializePreviousVisit)

/** When this browser last had the app open, or null on a first visit. */
export function usePreviousVisit(): Date | null {
  return useSharedState(previousVisitStore)[0]
}

/** DEV-only: rewinds the stored visit so the existing mock unseen video
 * entries register as unseen again -- see DataSourceToggle.tsx for this
 * codebase's own established import.meta.env.DEV gating pattern. No-op
 * outside dev, matching that same precedent. */
export function resetPreviousVisit(): void {
  if (!import.meta.env.DEV) return
  previousVisitStore.set(new Date(Date.now() - RESET_LOOKBACK_MS))
}
