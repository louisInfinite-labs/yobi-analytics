import { normalizeQuery } from "./queryNormalization"
import type { BackendVideoTopic } from "../../home-room/model/videoTopicCatalog"

/** The Topic Catalog (GET /topics: id + every locale label + searchAliases) as a MULTILINGUAL THESAURUS for the Home SearchView -- nothing
 * more. SearchView is a title search: this module only decides which extra LITERAL strings to look for in titles besides the typed
 * query (typing "birth" also looks for "birthday", "誕生日", ...). It never produces topic ids for matching: a video's persisted topic plays
 * no part in SearchView (Topic Filter, a separate operation, owns that), and the backend applies no topic regex.
 *
 * A query resolves to a concept when the normalized query is a PREFIX of one of that topic's own searchable forms (id, any locale
 * label, or any search alias) -- the existing prefix-resolution rule, unchanged. This is monotonic for ANY catalog content: if
 * `form.startsWith(Q2)` and Q is a prefix of Q2, then `form.startsWith(Q)` necessarily holds too, so the concepts (and therefore the
 * expanded terms) a longer query resolves to are always a subset of what its prefix resolved to -- which is what the Search-session cache's
 * local narrowing depends on (see searchSessionCache.ts). No fuzzy matching, no typo correction. */

/** The one normalization every term goes through (the same NFKC / trim / whitespace / lowercase rules as the query itself). */
function normalizeTerm(value: string | undefined | null): string {
  return normalizeQuery(value ?? "").normalized
}

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

/** The literal title-search terms a raw query expands to: for every concept the query resolves to (see resolveTopicIds), that topic's
 * localized labels (every locale, regardless of the current UI locale) and its search aliases -- normalized, blanks dropped, and
 * de-duplicated (two spellings that normalize identically are one term), in catalog order. The topic ID is NOT a term (ids are machine
 * names), and the raw query itself is always searched separately by the backend, so "no concept resolved" simply yields []. Empty or
 * blank queries expand to nothing.
 *
 * The result is monotonic under query extension -- expandSearchTerms(Q2) is a subset of expandSearchTerms(Q1) whenever Q1 is a prefix of
 * Q2 -- for a fixed catalog; searchSessionCache.ts still records the terms each cached result was fetched with, so a catalog that changed
 * in between (for example GET /topics finishing after the first search) can never make local narrowing incomplete. */
export function expandSearchTerms(rawQuery: string, topics: readonly BackendVideoTopic[]): string[] {
  const normalized = normalizeQuery(rawQuery).normalized
  if (!normalized) return []
  const terms = new Set<string>()
  for (const topic of topics) {
    if (!searchableFormsFor(topic).some((form) => form.startsWith(normalized))) continue
    for (const label of Object.values(topic.labels)) {
      const term = normalizeTerm(label)
      if (term) terms.add(term)
    }
    for (const alias of topic.searchAliases ?? []) {
      const term = normalizeTerm(alias)
      if (term) terms.add(term)
    }
  }
  return [...terms]
}
