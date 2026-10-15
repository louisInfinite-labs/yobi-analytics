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

/** The display order of the backend topics (ids only -- keys and classification are the backend's): 雑談, 歌回, MV, Apex, Minecraft, SF6, VALO.
 * A topic the backend adds later is not listed here: it follows these in the backend's own order, before Short and Other. */
export const TOPIC_DISPLAY_ORDER: readonly string[] = ["chatting", "singing", "mv", "apex", "minecraft", "sf6", "valorant"]

/** Position of a canonical filter id in the shared display order (ALL is first and is not a topic); unknown ids sort after the known topics. */
export function filterDisplayRank(id: string): number {
  if (id === "all") return -1
  const known = TOPIC_DISPLAY_ORDER.indexOf(id)
  if (known !== -1) return known
  if (id === SHORT_VIDEO_FILTER) return TOPIC_DISPLAY_ORDER.length + 1000
  if (id === OTHER_TOPIC_ID) return TOPIC_DISPLAY_ORDER.length + 2000
  return TOPIC_DISPLAY_ORDER.length
}

/** The topics Home's Oshi Videos tag bar shows, in its fixed order (canonical GLOBAL topic ids): 雑談, 歌回, MV, Apex, Minecraft, SF6, VALO.
 * Together with the browsing shortcuts before them (ALL, 最新影片, 最新直播) and Short and Other after them, this is the WHOLE bar: twelve
 * options, always. The Topic Catalog (GET /topics) is the single source of truth for topic data -- ids, labels, aliases -- but it does NOT decide
 * what the Home header shows: a topic added to the catalog later, or any of the ~45 not listed here (Phasmophobia, Among Us, PEAK, ...),
 * never appears in this bar. The complete catalog belongs to the future Video Filter Dialog. */
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

/** The ONE canonical, ordered list of category filters shared by the push-notification
 * settings (Home's own bar is the fixed subset above), in the product's display order: 雑談, 歌回, MV, Apex, Minecraft, SF6, VALO, then any topic the backend has added since (in the
 * backend's order), then Short (a content format), then Other last (Short is last when there is no Other topic). `topics` is null while GET /topics has not succeeded -- never a hardcoded topic
 * list -- in which case only Short is returned. ALL / 最新影片 / 最新直播 are browsing shortcuts, not categories, so they are
 * deliberately absent. */
export function buildVideoFilterEntries(topics: readonly BackendVideoTopic[] | null, locale: Locale): VideoFilterEntry[] {
  const short: VideoFilterEntry = { id: SHORT_VIDEO_FILTER, kind: "format", label: t(locale, SPECIAL_VIDEO_FILTER_LABEL_KEYS[SHORT_VIDEO_FILTER]) }
  if (topics === null) return [short]
  const entries: VideoFilterEntry[] = [...topics.map((topic): VideoFilterEntry => ({ id: topic.id, kind: "topic", label: topicLabel(topic, locale) })), short]
  // Array.prototype.sort is stable, so topics with the same rank (new backend topics) keep the backend's order.
  return entries.sort((a, b) => filterDisplayRank(a.id) - filterDisplayRank(b.id))
}
