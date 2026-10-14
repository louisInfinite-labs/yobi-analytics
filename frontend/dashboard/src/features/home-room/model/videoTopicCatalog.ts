import type { Locale } from "../../../shared/i18n/translations"

/** One topic exactly as `GET /topics` (src/api/dashboard_catalog_api.py's
 * get_topics, backed by src/tracking/video_topics.py's TOPICS) returns it --
 * the frontend's only source for which backend topics exist, their count,
 * their order, and their display text in every locale. Adding a topic on the
 * backend needs no frontend code change: it simply appears here. See
 * data/videoTopics.ts for the fetcher and hooks/useVideoTopicCatalog.ts for
 * the load/cache/retry wiring.
 *
 * `searchAliases` (Video Search's final architecture) is this SAME backend-owned topic's real literal
 * search synonyms beyond its own id/labels (tracking.video_topics.Topic.search_aliases) -- the frontend
 * Video Search feature resolves a free-text query to canonical topic ids locally against id + labels +
 * searchAliases of this one shared, downloaded catalog (see features/video-search/model/
 * topicResolution.ts), rather than maintaining any taxonomy of its own or asking the backend to
 * re-resolve it per request. Always present (possibly empty), never the classification regex itself. */
export interface BackendVideoTopic {
  id: string
  labels: Partial<Record<Locale, string>>
  /** Optional (not every existing fixture/consumer of this shared type cares about Search resolution --
   * see features/video-search/model/topicResolution.ts, the only reader that needs it) -- absent is
   * treated identically to an empty array, never a reason to throw. */
  searchAliases?: string[]
}

/** `topic.labels[locale]`, falling back to the raw id when this topic has no
 * label for the current locale -- never a blank control, and never a reason
 * to throw, for a topic whose locale labels aren't all filled in yet. */
export function topicLabel(topic: BackendVideoTopic, locale: Locale): string {
  return topic.labels[locale] ?? topic.id
}
