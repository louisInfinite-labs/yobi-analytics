import { OTHER_TOPIC_ID, SHORT_VIDEO_FILTER, SPECIAL_VIDEO_FILTER_LABEL_KEYS } from "../../home-room/model/specialVideoFilters"
import type { VideoFilterEntry } from "../../home-room/model/videoFilterCatalog"
import { topicLabel, type BackendVideoTopic } from "../../home-room/model/videoTopicCatalog"
import { t, type Locale } from "../../../shared/i18n/translations"

export type TopicCatalogId = string

/** The special topic id of the creator-level 全部 scope. NOT a video topic:
 * the backend never classifies a stream as "all" -- it is the reminder scope
 * that applies to every stream of a creator (and shadows that creator's
 * topic-specific reminders). */
export const ALL_TOPICS_ID = "all"

/** The id of the Short card. Short is a content FORMAT, not a topic: it sits beside the topics in the "+ Add topic" list only for
 * consistency with Home, and its members are stored as the backend's own `newVideoShortCreatorOverride` field -- never as a
 * topic id. */
export const SHORT_TOPIC_ID = SHORT_VIDEO_FILTER

export function isShortCard(topicId: TopicCatalogId): boolean {
  return topicId === SHORT_TOPIC_ID
}

/** The 5 permanent default cards the page starts with, in this exact order (confirmed with the user: 全部/雜談/歌回/MV/Apex). They
 * are never removed; every other card (Minecraft/SF6/VALO/Short/其他) is added through "+ Add topic" and can be removed again. */
export const PERMANENT_TOPIC_IDS: readonly TopicCatalogId[] = [ALL_TOPICS_ID, "chatting", "singing", "mv", "apex"]

export function isPermanentTopic(topicId: TopicCatalogId): boolean {
  return PERMANENT_TOPIC_IDS.includes(topicId)
}

/** The push-notification topic list: EXACTLY these ten, in this order -- 全部, 雜談, 歌回, MV, Apex, Minecraft, SF6, VALO, Short, 其他. Its OWN explicit
 * configuration, independent of Home's tag bar (which also carries 最新影片 / 最新直播: browsing shortcuts, not notification topics -- Live and
 * New Video are this page's separate notification TYPES). The Topic Catalog supplies each topic's id and localized label, but never decides
 * which topics the list offers: nothing else is appended, however many topics GLOBAL gains. A card the user saved earlier for a topic outside
 * this list keeps its stored preferences untouched; it is just not shown. */
export const NOTIFICATION_TOPIC_IDS: readonly TopicCatalogId[] = [
  ALL_TOPICS_ID,
  "chatting",
  "singing",
  "mv",
  "apex",
  "minecraft",
  "sf6",
  "valorant",
  SHORT_TOPIC_ID,
  OTHER_TOPIC_ID,
]

/** Whether the push-notification settings list shows a card for this topic id. */
export function isNotificationTopic(topicId: TopicCatalogId): boolean {
  return NOTIFICATION_TOPIC_IDS.includes(topicId)
}

/** Position in the notification list; anything outside it sorts last (it is not shown anyway). */
export function notificationTopicRank(topicId: TopicCatalogId): number {
  const index = NOTIFICATION_TOPIC_IDS.indexOf(topicId)
  return index === -1 ? NOTIFICATION_TOPIC_IDS.length : index
}

/** The categories "+ Add topic" can offer: the ten above minus 全部 (a permanent card), in order, labelled from the catalog in the selected
 * language. A topic the catalog lacks is left out, never replaced. Short is a content format (its label is the shared Short label). `topics`
 * is null while GET /topics has not succeeded -- never a hardcoded topic list -- in which case only Short is known. */
export function buildNotificationTopicEntries(topics: readonly BackendVideoTopic[] | null, locale: Locale): VideoFilterEntry[] {
  const short: VideoFilterEntry = { id: SHORT_TOPIC_ID, kind: "format", label: t(locale, SPECIAL_VIDEO_FILTER_LABEL_KEYS[SHORT_VIDEO_FILTER]) }
  if (topics === null) return [short]
  const byId = new Map(topics.map((topic) => [topic.id, topic]))
  return NOTIFICATION_TOPIC_IDS.flatMap((id): VideoFilterEntry[] => {
    if (id === ALL_TOPICS_ID) return []
    if (id === SHORT_TOPIC_ID) return [short]
    const topic = byId.get(id)
    return topic ? [{ id: topic.id, kind: "topic", label: topicLabel(topic, locale) }] : []
  })
}

/** Topic ids are the machine contract shared with the backend
 * (src/tracking/video_topics.py, GET /topics): a topic that backend
 * returns uses its exact id here, with its backend label. Ids from before this contract existed are migrated, never dropped. */
export const LEGACY_TOPIC_ID_ALIASES: Readonly<Record<string, TopicCatalogId>> = { valo: "valorant" }

/** Notification-only display categories this page used to hard-code (the backend never classified a stream into them). The list
 * of selectable categories is now NOTIFICATION_TOPIC_IDS (buildNotificationTopicEntries), so a card saved for one of these is dropped. */
export const RETIRED_TOPIC_IDS: ReadonlySet<TopicCatalogId> = new Set(["gta", "seven_days_to_die", "mahjong_soul", "endfield"])

/** The options a draft card's own topic <Select> may actually offer: every
 * category of the notification list EXCEPT one already claimed by an existing SAVED card --
 * confirmed with the user, no two cards may ever reference the same topic.
 * Only one draft can ever exist at a time (see NotificationSettings.tsx), so
 * excluding a draft's own in-progress pick from itself is never a real
 * case -- excluding savedTopicIds alone is sufficient. `entries` is already in the notification list's order, Short before Other. */
export function getSelectableTopics(entries: readonly VideoFilterEntry[], savedTopicIds: readonly TopicCatalogId[]): readonly VideoFilterEntry[] {
  const saved = new Set(savedTopicIds)
  return entries.filter((entry) => !saved.has(entry.id))
}
