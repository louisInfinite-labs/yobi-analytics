import { normalizeQuery } from "./queryNormalization"
import type { VideoSearchResult } from "../data/videoSearch"

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
  /** The normalized expanded title terms this response was fetched WITH (besides the raw `baseQuery`, which is always searched). A
   * snapshot can only stand in for a query whose own terms are a subset of these -- see findReusableBase. */
  terms: readonly string[]
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
  store(identity: SearchCacheIdentity, baseQuery: string, videos: readonly VideoSearchResult[], terms: readonly string[] = []): void {
    this.resetIfIdentityChanged(identity)
    this.snapshots.delete(baseQuery)
    this.snapshots.set(baseQuery, { baseQuery, videos, terms })
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
   * backend; a different (non-matching) identity also always returns null, without touching anything.
   *
   * `terms` are the expanded title terms of `normalizedQuery` itself. A snapshot is only a safe (complete) base when every one of those
   * terms was already part of what it was fetched with: matching is "title contains the query OR any term", so a base fetched with FEWER
   * terms could be missing rows the longer query still matches. For a fixed catalog this always holds (the terms of a longer query are a
   * subset of its prefix's -- see topicResolution.ts), and it keeps local narrowing correct if the catalog changed between the two
   * requests, e.g. a first search sent before GET /topics had loaded. */
  findReusableBase(identity: SearchCacheIdentity, normalizedQuery: string, terms: readonly string[] = []): SearchSnapshot | null {
    if (this.currentIdentityKey !== identityKey(identity)) return null
    const covers = (snapshot: SearchSnapshot) => terms.every((term) => snapshot.terms.includes(term))
    const exact = this.snapshots.get(normalizedQuery)
    if (exact && covers(exact)) {
      this.touch(normalizedQuery)
      return exact
    }
    let best: SearchSnapshot | null = null
    for (const snapshot of this.snapshots.values()) {
      if (snapshot.baseQuery.length === 0 || !covers(snapshot)) continue
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

/** Whether `video` still matches `normalizedQuery`, re-derived from this one result's own already-returned `title` and the query's expanded
 * `terms` (never a second backend round-trip, and never the video's `topic`: SearchView matches on titles only). It mirrors the backend rule
 * exactly -- the normalized title contains the normalized query OR any normalized term -- and is a correct narrowing, not an approximation,
 * because the matching set only shrinks as the query is extended: a title that contains a longer query also contains its prefix, and the
 * terms of a longer query are a subset of its prefix's (see findReusableBase, which also enforces that for the snapshot actually used). */
function stillMatches(video: VideoSearchResult, normalizedQuery: string, terms: readonly string[]): boolean {
  const title = normalizeQuery(video.title).normalized
  return title.includes(normalizedQuery) || terms.some((term) => title.includes(term))
}

/** The visible result list for `normalizedQuery`, derived from `snapshot` -- ALWAYS computed fresh from the snapshot's own preserved,
 * never-mutated `videos`, never by filtering an already-narrowed previous view (backspacing from a 3-result narrowed view back toward the
 * base must restore the original 10, not try to reconstruct 10 from 3). Preserves the snapshot's own relative ordering -- Search has no
 * relevance ranking of its own, so a filter here must never reorder (Array.prototype.filter already preserves order). `terms` is the SAME
 * expansion the caller sent (or would send) to the backend for `normalizedQuery` -- passed in rather than computed here, since this module
 * must never issue its own network request or read the catalog. */
export function deriveVisibleResults(snapshot: SearchSnapshot, normalizedQuery: string, terms: readonly string[] = []): VideoSearchResult[] {
  if (snapshot.baseQuery === normalizedQuery) return [...snapshot.videos]
  return snapshot.videos.filter((video) => stillMatches(video, normalizedQuery, terms))
}
