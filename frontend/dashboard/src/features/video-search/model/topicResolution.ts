import { normalizeQuery } from "./queryNormalization"
import type { BackendVideoTopic } from "../../home-room/model/videoTopicCatalog"

/** The final Video Search architecture: canonical multilingual topic resolution ("does this query refer
 * to a topic, and which one") is done HERE, on the frontend, against the SAME authoritative catalog
 * GET /topics returns (id + every locale label + search_aliases -- tracking.video_topics.Topic on the
 * backend) -- never a second, frontend-maintained taxonomy, and never re-derived by the backend per
 * request (see src/search/video_search.py's own module docstring for the backend side of this).
 *
 * The matching rule mirrors the backend's own (now-removed) resolve_canonical_ids_with_evidence exactly:
 * a query resolves to a topic when the normalized query is a PREFIX of one of that topic's own
 * searchable forms (id, any locale label, or any search alias). This is monotonic for ANY catalog
 * content -- if `form.startsWith(Q2)` and `Q` is a prefix of `Q2`, then `form.startsWith(Q)` necessarily
 * holds too -- which is exactly the property the Search-session cache's local narrowing depends on (see
 * searchSessionCache.ts). No fuzzy matching, no typo correction: a query that is not a literal prefix of
 * a stored form never resolves. */

/** Every normalized, searchable literal form for one topic: its own id, every locale label (regardless
 * of the CURRENT UI locale -- display language and Search-match language are deliberately independent,
 * see this module's own tests), and every backend-owned search alias. Computed fresh per call rather
 * than memoized per topic: the catalog is small (today 8 topics) and loaded once per session, so this
 * is cheap even run once per keystroke-triggered resolution. */
function searchableFormsFor(topic: BackendVideoTopic): string[] {
  const forms = new Set<string>()
  const add = (value: string | undefined | null) => {
    const normalized = normalizeQuery(value ?? "").normalized
    if (normalized) forms.add(normalized)
  }
  add(topic.id)
  for (const label of Object.values(topic.labels)) add(label)
  for (const alias of topic.searchAliases ?? []) add(alias)
  return [...forms]
}

/** Resolves a raw Search query to every canonical topic id it is a prefix of, against `topics` (the
 * frontend's own already-downloaded copy of GET /topics -- never fetched again here). An empty/blank
 * query always resolves to zero topics -- NOT "every topic", despite every string being a trivial
 * prefix-match target for "": this mirrors the backend's own former defensive guard (resolve_canonical_
 * ids_with_evidence returned {} for an empty query) and is required for the same reason -- an empty
 * Search query must never behave like "match everything" through the topic path either. Returns ids in
 * `topics`' own catalog order (display order), not insertion/match order. */
export function resolveTopicIds(rawQuery: string, topics: readonly BackendVideoTopic[]): string[] {
  const normalized = normalizeQuery(rawQuery).normalized
  if (!normalized) return []
  const ids: string[] = []
  for (const topic of topics) {
    if (searchableFormsFor(topic).some((form) => form.startsWith(normalized))) ids.push(topic.id)
  }
  return ids
}
