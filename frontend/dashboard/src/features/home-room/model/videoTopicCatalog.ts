import type { Locale } from "../../../shared/i18n/translations"

/** One topic exactly as `GET /topics` (src/api/dashboard_catalog_api.py's
 * get_topics, backed by src/tracking/video_topics.py's TOPICS) returns it --
 * the frontend's only source for which backend topics exist, their count,
 * their order, and their display text in every locale. Adding a topic on the
 * backend needs no frontend code change: it simply appears here. See
 * data/videoTopics.ts for the fetcher and hooks/useVideoTopicCatalog.ts for
 * the load/cache/retry wiring. */
export interface BackendVideoTopic {
  id: string
  labels: Partial<Record<Locale, string>>
}

/** `topic.labels[locale]`, falling back to the raw id when this topic has no
 * label for the current locale -- never a blank control, and never a reason
 * to throw, for a topic whose locale labels aren't all filled in yet. */
export function topicLabel(topic: BackendVideoTopic, locale: Locale): string {
  return topic.labels[locale] ?? topic.id
}
