const STORAGE_KEY = "yobi.home.lastVisitAt"

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

// Captured once at module load, BEFORE the stamp below overwrites it — the
// whole point of "since your last visit" is the previous session's
// timestamp, which reading lazily (per mount/render) would have already
// clobbered.
const previousVisit = readPreviousVisit()

try {
  window.localStorage.setItem(STORAGE_KEY, new Date().toISOString())
} catch {
  // Best-effort, matching every other localStorage writer in this app: a
  // failed stamp only means the next session sees an older window.
}

/** When this browser last had the app open, or null on a first visit. */
export function usePreviousVisit(): Date | null {
  return previousVisit
}
