import { normalizeQuery } from "./queryNormalization"
import { resolveTopicIds } from "./topicResolution"
import type { VideoSearchResult } from "../data/videoSearch"
import type { BackendVideoTopic } from "../../home-room/model/videoTopicCatalog"

/** One COMPLETE backend Search response for one normalized query, under one cache identity (creator +
 * applicable Filter/Sort -- never the selected Video Tag, which Search always ignores). The backend
 * itself has no pagination on this path at all (src/api/read_api.py's get_creator_video_search always
 * returns every matching video in one response), so every successful response is, by construction, a
 * complete snapshot -- there is no per-response completeness flag to check before calling
 * SearchSessionCache.store. `videos` is never mutated after being stored (every narrower view is a
 * freshly filtered COPY derived from it, never a destructive filter of the array itself -- see
 * deriveVisibleResults). */
export interface SearchSnapshot {
  baseQuery: string
  videos: readonly VideoSearchResult[]
}

/** Creator + the Filter/Sort fields the backend actually applies during Search (read_api.py's
 * get_creator_video_search: contentType/sort/viewWindow -- viewWindow only matters when sort is
 * "mostViews", but it's included unconditionally rather than special-cased, since an unused field
 * simply never differs between two otherwise-identical identities). Video Tag/Topic is deliberately
 * absent: Search ignores the selected Tag, so it must never be part of what makes two snapshots
 * "the same Search context" either. */
export interface SearchCacheIdentity {
  creatorId: string
  contentType: string
  sort: string
  viewWindow: string
}

function identityKey(identity: SearchCacheIdentity): string {
  return JSON.stringify([identity.creatorId, identity.contentType, identity.sort, identity.viewWindow])
}

/** Bounded so this never grows into an unbounded per-session memory leak over a long Search session --
 * see this module's own docstring in the final report for why 8 (within the suggested 5-10 range). */
const MAX_SNAPSHOTS = 8

/** A small, session-only, in-memory cache of COMPLETE Video Search results, keyed by normalized query,
 * namespaced by creator+Filter/Sort identity. Never persisted anywhere (no localStorage/IndexedDB/
 * backend) -- it exists only to avoid re-querying the backend while the user keeps safely narrowing
 * within an already-fetched complete result universe (see useVideoSearch.ts, which is the only caller).
 *
 * A Creator or Filter/Sort change clears everything (simplest safe choice per spec -- no cross-identity
 * reuse is ever attempted); an identical identity keeps every snapshot until evicted by size or an
 * explicit clear() (the empty-query session reset). */
export class SearchSessionCache {
  private currentIdentityKey: string | null = null
  // Map iteration order is insertion order; re-inserting a key (delete then set) moves it to the end,
  // which is what makes "oldest key = keys().next().value" a correct, trivial LRU without a separate
  // linked-list/counter structure.
  private snapshots = new Map<string, SearchSnapshot>()

  private resetIfIdentityChanged(identity: SearchCacheIdentity): void {
    const key = identityKey(identity)
    if (this.currentIdentityKey !== key) {
      this.currentIdentityKey = key
      this.snapshots.clear()
    }
  }

  /** The empty-query session reset (spec: an empty query destroys the Search-session cache entirely,
   * not just the currently visible results) -- also what a Creator switch should call if the caller
   * prefers an explicit clear over relying on resetIfIdentityChanged's own lazy identity check. */
  clear(): void {
    this.snapshots.clear()
  }

  /** Stores `videos` as the COMPLETE result set for `baseQuery` under `identity` -- every backend Search
   * response IS the complete result set (the endpoint has no pagination), so every successful response
   * is safe to store here unconditionally; see useVideoSearch.ts's own call site. Evicts the
   * least-recently-used snapshot once MAX_SNAPSHOTS is exceeded. */
  store(identity: SearchCacheIdentity, baseQuery: string, videos: readonly VideoSearchResult[]): void {
    this.resetIfIdentityChanged(identity)
    this.snapshots.delete(baseQuery)
    this.snapshots.set(baseQuery, { baseQuery, videos })
    while (this.snapshots.size > MAX_SNAPSHOTS) {
      const oldest = this.snapshots.keys().next().value
      if (oldest === undefined) break
      this.snapshots.delete(oldest)
    }
  }

  /** The best reusable base for `normalizedQuery` under `identity`, touching (LRU-refreshing) it if
   * found: an exact match first, else the LONGEST cached query that `normalizedQuery` is a true
   * extension of (a cached "" base is never reusable -- an empty query is never a valid Search base,
   * see spec sections 9/46). Returns null when no safe base exists -- the caller must then go to the
   * backend; a different (non-matching) identity also always returns null, without touching anything. */
  findReusableBase(identity: SearchCacheIdentity, normalizedQuery: string): SearchSnapshot | null {
    if (this.currentIdentityKey !== identityKey(identity)) return null
    const exact = this.snapshots.get(normalizedQuery)
    if (exact) {
      this.touch(normalizedQuery)
      return exact
    }
    let best: SearchSnapshot | null = null
    for (const snapshot of this.snapshots.values()) {
      if (snapshot.baseQuery.length === 0) continue
      if (normalizedQuery.startsWith(snapshot.baseQuery) && (!best || snapshot.baseQuery.length > best.baseQuery.length)) {
        best = snapshot
      }
    }
    if (best) this.touch(best.baseQuery)
    return best
  }

  private touch(key: string): void {
    const value = this.snapshots.get(key)
    if (!value) return
    this.snapshots.delete(key)
    this.snapshots.set(key, value)
  }
}

/** Whether `video` still matches `normalizedQuery`, re-derived from this one result's own already-
 * returned `title` + `topic` fields and the frontend's OWN already-downloaded topic catalog (never a
 * second backend round-trip, never backend-computed per-row evidence -- see this module's own top
 * docstring for why that is no longer needed). Correct, not an approximation, because BOTH mechanisms
 * are monotonically shrinking under query extension: a title that contained the base query only
 * continues to contain a strictly longer extension of it if the longer text is still literally present,
 * and `resolveTopicIds` is monotonic for the same reason src/search/video_search.py's own (now removed)
 * resolve_canonical_ids_with_evidence was -- plain prefix-matching over a static catalog, which can only
 * ever shrink the matching id set as the query lengthens (see topicResolution.ts's own docstring). */
function stillMatches(video: VideoSearchResult, normalizedQuery: string, topics: readonly BackendVideoTopic[]): boolean {
  const titleMatch = normalizeQuery(video.title).normalized.includes(normalizedQuery)
  if (titleMatch) return true
  if (!video.topic) return false
  return resolveTopicIds(normalizedQuery, topics).includes(video.topic)
}

/** The visible result list for `normalizedQuery`, derived from `snapshot` -- ALWAYS computed fresh from
 * the snapshot's own preserved, never-mutated `videos`, never by filtering an already-narrowed previous
 * view (spec: backspacing from a 3-result narrowed view back toward the base must restore the original
 * 10, not try to reconstruct 10 from 3). Preserves the snapshot's own relative ordering -- Search has no
 * relevance ranking of its own, so a filter here must never reorder (Array.prototype.filter already
 * preserves order, which is all this needs). `topics` is the SAME already-downloaded catalog the caller
 * used to resolve the backend request's own `topicIds` -- passed in rather than fetched here, since this
 * module must never issue its own network request. */
export function deriveVisibleResults(snapshot: SearchSnapshot, normalizedQuery: string, topics: readonly BackendVideoTopic[]): VideoSearchResult[] {
  if (snapshot.baseQuery === normalizedQuery) return [...snapshot.videos]
  return snapshot.videos.filter((video) => stillMatches(video, normalizedQuery, topics))
}
