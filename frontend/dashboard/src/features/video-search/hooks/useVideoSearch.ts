import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { fetchVideoSearch, type VideoSearchQuery, type VideoSearchResult } from "../data/videoSearch"
import { isQueryActive, normalizeQuery } from "../model/queryNormalization"
import { SearchSessionCache, deriveVisibleResults, type SearchCacheIdentity } from "../model/searchSessionCache"
import { resolveTopicIds } from "../model/topicResolution"
import type { BackendVideoTopic } from "../../home-room/model/videoTopicCatalog"

/** A small debounce since Search calls the backend (spec: ~200-350ms) -- applies ONLY when a backend
 * request is actually needed. A query safely answerable from the Search-session cache (an exact repeat,
 * or a true extension of an already-complete cached base) is derived immediately instead, with no wait
 * at all -- see this hook's own resolve() for why that split exists. */
const SEARCH_DEBOUNCE_MS = 250

export interface VideoSearchState {
  /** Whether the (normalized) query meets the activation threshold -- false means Search is not
   * running at all (regardless of whether a query is mid-debounce), so a caller falls back to its
   * normal tag-filtered browsing view rather than showing a stale or false-empty Search result. */
  active: boolean
  videos: VideoSearchResult[]
  loading: boolean
  error: Error | null
  /** Enter / a mobile keyboard's search action: if a backend request is genuinely pending (debouncing),
   * fire it immediately instead of waiting out the rest of the debounce. A no-op when the current query
   * is already resolved (from cache or a completed request) or mid-IME-composition -- it must never
   * force a redundant request the cache already answered. */
  flush: () => void
}

/** The non-query parts of a search request: current creator + the existing Filter/Sort selection,
 * which stays active during a Search (spec: Video Tag is ignored, Filter/Sort is not) -- deliberately
 * has no `topic`/tag field at all, so a caller cannot accidentally narrow Search by the selected tag.
 * `topicIds` is excluded too: it is QUERY-derived (this hook resolves it locally from `rawQuery` via
 * ../model/topicResolution.ts), never something a caller supplies directly. */
export type VideoSearchBase = Omit<VideoSearchQuery, "rawQuery" | "topicIds">

export interface UseVideoSearchOptions {
  /** True while an IME composition is in progress (compositionstart fired, compositionend has not yet)
   * -- while true, this hook freezes at its last resolved query: no new backend request is scheduled,
   * no cache lookup is attempted against the unstable intermediate text, and no activation-threshold
   * transition is acted on. The moment it flips back to false, the current (now final) text is
   * evaluated exactly like any other query change. */
  isComposing?: boolean
  /** The SAME already-downloaded topic catalog (GET /topics, via the caller's own existing
   * useVideoTagOptions/useVideoTopicCatalog instance -- NEVER a second fetch started here) used for
   * local canonical-topic resolution (../model/topicResolution.ts) -- both for the `topicIds` sent
   * alongside every backend request and for local Search-session cache narrowing. Read via a ref at
   * call-time, not a dependency of the request-scheduling effect, so a caller re-rendering with a new
   * (but equal) array identity never itself triggers a redundant resolution/request. Defaults to `[]`
   * (no topics loaded yet) -- Search still works as plain title matching in that case. */
  topics?: readonly BackendVideoTopic[]
}

const emptyState: VideoSearchState = { active: false, videos: [], loading: false, error: null, flush: () => {} }

function identityOf(base: VideoSearchBase): SearchCacheIdentity {
  return { creatorId: base.creatorId, contentType: base.contentType, sort: base.sort, viewWindow: base.viewWindow }
}

interface ResolvedState {
  /** Identifies exactly which (identity, normalizedQuery) this result belongs to -- a response/derivation
   * for any other combination is stale and must never be shown (see the generation/key guards below). */
  key: string
  videos: VideoSearchResult[]
  loading: boolean
  error: Error | null
}

/** Drives Video Search end to end: activation-threshold gating, debounce, canonical-topic resolution
 * (model/topicResolution.ts, against the caller's already-downloaded /topics catalog), and the
 * Search-session cache (local narrowing of an already-complete backend response, see
 * model/searchSessionCache.ts) are this hook's own job. Direct title matching remains entirely the
 * backend's (src/search/video_search.py); this hook never computes that itself -- it only sends
 * `rawQuery` as-is and resolves topic ids LOCALLY to union alongside it (final architecture: the
 * frontend resolves query -> topic ids against the same backend-owned catalog Search display already
 * uses, rather than the backend re-deriving that mapping per request). */
export function useVideoSearch(rawQuery: string, base: VideoSearchBase | null, options: UseVideoSearchOptions = {}): VideoSearchState {
  const { isComposing = false, topics = [] } = options
  const cacheRef = useRef<SearchSessionCache>(undefined)
  if (!cacheRef.current) cacheRef.current = new SearchSessionCache()
  // Read at call-time by runBackendFetch/the resolution effect/flush -- never a dependency that would
  // retrigger request scheduling merely because the caller re-rendered with a new array identity.
  const topicsRef = useRef<readonly BackendVideoTopic[]>(topics)
  topicsRef.current = topics

  const normalized = useMemo(() => normalizeQuery(rawQuery).normalized, [rawQuery])
  const active = isQueryActive(normalized)

  // The empty query is the full Search-session reset (spec sections 9/46) -- distinct from merely
  // falling below the activation threshold (which keeps the cache for a later return to it, see
  // sections 7-8). This must never send a backend request: the cache is simply discarded.
  useEffect(() => {
    if (normalized.length === 0) cacheRef.current?.clear()
  }, [normalized])

  const identity = useMemo(() => (base ? identityOf(base) : null), [base?.creatorId, base?.contentType, base?.sort, base?.viewWindow]) // eslint-disable-line react-hooks/exhaustive-deps
  const identityKey = identity ? JSON.stringify(identity) : null
  const stateKey = active && identityKey ? `${identityKey}::${normalized}` : null

  const [state, setState] = useState<ResolvedState | null>(null)
  const generationRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const runBackendFetch = useCallback(
    (fetchBase: VideoSearchBase, fetchIdentity: SearchCacheIdentity, fetchNormalized: string, fetchKey: string, generation: number) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      setState((prev) => (prev && prev.key === fetchKey ? { ...prev, loading: true } : { key: fetchKey, videos: [], loading: true, error: null }))

      const topicIds = resolveTopicIds(fetchNormalized, topicsRef.current)
      fetchVideoSearch({ ...fetchBase, rawQuery: fetchNormalized, topicIds }, controller.signal).then(
        (videos) => {
          if (generation !== generationRef.current) return // superseded by a newer query/identity/request
          // The backend now always returns the query's COMPLETE matching set in one response (no
          // limit/offset/hasMore at all -- see src/api/read_api.py's get_creator_video_search), so every
          // successful response is, by construction, a safe local-narrowing base.
          cacheRef.current?.store(fetchIdentity, fetchNormalized, videos)
          setState({ key: fetchKey, videos, loading: false, error: null })
        },
        (err: unknown) => {
          if (controller.signal.aborted) return // an abort means a newer request already took over -- never surface this as an error
          if (generation !== generationRef.current) return
          setState({ key: fetchKey, videos: [], loading: false, error: err instanceof Error ? err : new Error(String(err)) })
        },
      )
    },
    [],
  )

  // The one place a query change (including the first time a new one becomes active) is resolved:
  // cache hit (exact or longest-prefix-narrowed) -> immediate, no request; otherwise a debounced backend
  // fetch. Composition freezes this entirely -- no lookup, no scheduling -- until it ends.
  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (!active) {
      // The search ended (query cleared, or it fell below the activation threshold): invalidate and abort anything still in flight, so a late
      // response can never be applied -- the caller is already showing something else (e.g. a Topic Tag's normal list).
      generationRef.current++
      abortRef.current?.abort()
      return
    }
    if (!identity || !identityKey || !base || isComposing) return
    const key = `${identityKey}::${normalized}`

    const reusable = cacheRef.current?.findReusableBase(identity, normalized)
    if (reusable) {
      // A safe local derivation always wins immediately: no debounce, and it supersedes whatever
      // backend request might already be in flight for a now-abandoned branch of typing.
      generationRef.current++
      abortRef.current?.abort()
      setState({ key, videos: deriveVisibleResults(reusable, normalized, topicsRef.current), loading: false, error: null })
      return
    }

    const generation = ++generationRef.current
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      runBackendFetch(base, identity, normalized, key, generation)
    }, SEARCH_DEBOUNCE_MS)

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
    // base's own identity fields are already captured in `identity`/`identityKey`; re-running only on
    // those (plus normalized/active/isComposing) avoids re-resolving on an equal-but-new `base` object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, identityKey, normalized, isComposing, runBackendFetch])

  const flush = useCallback(() => {
    if (isComposing || !timerRef.current || !base || !identity || !identityKey) return
    clearTimeout(timerRef.current)
    timerRef.current = null
    const generation = generationRef.current
    runBackendFetch(base, identity, normalized, `${identityKey}::${normalized}`, generation)
  }, [isComposing, base, identity, identityKey, normalized, runBackendFetch])

  if (!active) return emptyState
  const current = state && state.key === stateKey ? state : null
  return {
    active: true,
    videos: current ? current.videos : [],
    loading: current ? current.loading : true,
    error: current ? current.error : null,
    flush,
  }
}
