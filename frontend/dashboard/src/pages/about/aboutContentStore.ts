import { createSharedState } from "../../shared/state/sharedState"
import { fetchAboutContent, validateAboutContent, type AboutContent } from "./api/aboutContentApi"
import { getGeneration, isFetchStarted, markFetchStarted } from "./aboutContentFetchState"

export interface AboutContentState {
  content: AboutContent | null
  isLoading: boolean
  error: string | null
}

const STORAGE_KEY = "yobi.aboutContent.cache"

const INITIAL_STATE: AboutContentState = { content: null, isLoading: true, error: null }

/** Reads the last successfully validated response so a reload shows it
 * immediately while a fresh fetch is in flight -- same reasoning as
 * liveStreamsStore.ts's own readCached. Re-validates the cached payload
 * too (not just parses it): a schema the frontend no longer/not-yet
 * supports should fall back to INITIAL_STATE here exactly as it would for
 * a live network response, never render a stale, unsanitized shape. */
function readCached(): AboutContentState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return INITIAL_STATE
    const parsed = JSON.parse(raw) as { content: unknown }
    const content = validateAboutContent(parsed.content)
    return content ? { content, isLoading: true, error: null } : INITIAL_STATE
  } catch {
    return INITIAL_STATE
  }
}

/** The one shared store every About consumer reads through -- same
 * createSharedState/useSyncExternalStore pattern this project already uses
 * for liveStreamsStore/useLocale (shared/state/sharedState.ts), so it
 * participates in the same resetAllSharedStateForTests()/afterEach
 * cleanup with no extra test wiring. */
export const aboutContentStore = createSharedState<AboutContentState>(STORAGE_KEY, readCached, (value) =>
  JSON.stringify({ content: value.content }),
)

/** Fetch-once per session (not polled -- this is near-static backend
 * content, not live data): a remote fetch success replaces the store's
 * content and persists it as the new last-known-good cache; a failure
 * leaves whatever content is already there (cached or null) untouched,
 * only isLoading/error change -- "remote fetch fails -> use last-known-good
 * cached payload if available" per this feature's own spec. The
 * generation guard discards a stale in-flight fetch's result if a test (or
 * a future reset path) calls resetAboutContentFetchForTests() while it was
 * still pending. */
async function load(): Promise<void> {
  const startedAtGeneration = getGeneration()
  try {
    const content = await fetchAboutContent()
    if (startedAtGeneration !== getGeneration()) return
    aboutContentStore.set({ content, isLoading: false, error: null })
  } catch (err) {
    if (startedAtGeneration !== getGeneration()) return
    aboutContentStore.set({ ...aboutContentStore.get(), isLoading: false, error: err instanceof Error ? err.message : "Unknown error" })
  }
}

export async function ensureAboutContentLoaded(): Promise<void> {
  if (isFetchStarted()) return
  markFetchStarted()
  await load()
}

/** Explicit user-initiated retry (ErrorState's own onRetry) -- deliberately
 * bypasses the fetch-once guard above, since "ensure loaded" and "the user
 * just asked to try again" are different intents. */
export async function retryAboutContentLoad(): Promise<void> {
  aboutContentStore.set({ ...aboutContentStore.get(), isLoading: true, error: null })
  await load()
}
