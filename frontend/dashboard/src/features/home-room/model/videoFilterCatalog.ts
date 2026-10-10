import { t, type Locale } from "../../../shared/i18n/translations"
import { OTHER_TOPIC_ID, SHORT_VIDEO_FILTER, SPECIAL_VIDEO_FILTER_LABEL_KEYS } from "./specialVideoFilters"
import { topicLabel, type BackendVideoTopic } from "./videoTopicCatalog"

/** "topic" = one of the backend's video topics (GET /topics); "format" = a content-format filter that is NOT a topic (Short).
 * Consumers keep the two apart: a topic id is sent to the backend as a topic, Short as its own content-format field. */
export type VideoFilterKind = "topic" | "format"

export interface VideoFilterEntry {
  id: string
  kind: VideoFilterKind
  label: string
}

/** The ONE canonical, ordered list of category filters shared by Home's Oshi Videos tag bar and the push-notification
 * settings: the backend topics in the order GET /topics returns them, with Short (a content format) immediately before Other
 * (at the end when there is no Other topic). `topics` is null while GET /topics has not succeeded -- never a hardcoded topic
 * list -- in which case only Short is returned. ALL / 最新影片 / 最新直播 are browsing shortcuts, not categories, so they are
 * deliberately absent. */
export function buildVideoFilterEntries(topics: readonly BackendVideoTopic[] | null, locale: Locale): VideoFilterEntry[] {
  const short: VideoFilterEntry = { id: SHORT_VIDEO_FILTER, kind: "format", label: t(locale, SPECIAL_VIDEO_FILTER_LABEL_KEYS[SHORT_VIDEO_FILTER]) }
  if (topics === null) return [short]
  const entries: VideoFilterEntry[] = topics.map((topic) => ({ id: topic.id, kind: "topic", label: topicLabel(topic, locale) }))
  const otherIndex = entries.findIndex((entry) => entry.id === OTHER_TOPIC_ID)
  if (otherIndex === -1) return [...entries, short]
  return [...entries.slice(0, otherIndex), short, ...entries.slice(otherIndex)]
}
