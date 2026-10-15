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

/** The topics Home's Oshi Videos tag bar shows, in its fixed order (canonical GLOBAL topic ids): 雑談, 歌回, MV, Apex, Minecraft, SF6, VALO.
 * Together with the browsing shortcuts before them (ALL, 最新影片, 最新直播) and Short and Other after them, this is the WHOLE bar: twelve
 * options, always. The Topic Catalog (GET /topics) is the single source of truth for topic data -- ids, labels, aliases -- but it does NOT decide
 * what the Home header shows: a topic added to the catalog later, or any of the ~45 not listed here (Phasmophobia, Among Us, PEAK, ...),
 * never appears in this bar. The complete catalog belongs to the future Video Filter Dialog. This is Home's OWN list: the push-notification
 * settings have a separate one (notifications/model/notificationTopicCatalog.ts), because Home's bar also holds the browsing shortcuts
 * 最新影片 / 最新直播, which are not notification topics. */
export const HOME_TAG_TOPIC_IDS: readonly string[] = ["chatting", "singing", "mv", "apex", "minecraft", "sf6", "valorant"]

/** The category part of Home's tag bar: the fixed topics above (only those the catalog really has -- a missing one is left out, never replaced
 * by another), then Short (a content format), then Other (when the catalog has it). Labels come from the catalog in the selected language.
 * `topics` is null while GET /topics has not succeeded -- never a hardcoded topic list -- in which case only Short is returned. Unlike
 * buildVideoFilterEntries it never appends the rest of the catalog. */
export function buildHomeVideoTagEntries(topics: readonly BackendVideoTopic[] | null, locale: Locale): VideoFilterEntry[] {
  const short: VideoFilterEntry = { id: SHORT_VIDEO_FILTER, kind: "format", label: t(locale, SPECIAL_VIDEO_FILTER_LABEL_KEYS[SHORT_VIDEO_FILTER]) }
  if (topics === null) return [short]
  const byId = new Map(topics.map((topic) => [topic.id, topic]))
  const entry = (id: string): VideoFilterEntry[] => {
    const topic = byId.get(id)
    return topic ? [{ id: topic.id, kind: "topic", label: topicLabel(topic, locale) }] : []
  }
  return [...HOME_TAG_TOPIC_IDS.flatMap(entry), short, ...entry(OTHER_TOPIC_ID)]
}
