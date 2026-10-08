import type { TranslationKey } from "../../../shared/i18n/translations"

export type TopicCatalogId = string

export interface TopicCatalogEntry {
  id: TopicCatalogId
  labelKey: TranslationKey
}

/** The special topic id of the creator-level 全部 scope. NOT a video topic:
 * the backend never classifies a stream as "all" -- it is the reminder scope
 * that applies to every stream of a creator (and shadows that creator's
 * topic-specific reminders). */
export const ALL_TOPICS_ID = "all"

/** Topic ids are the machine contract shared with the backend
 * (src/tracking/video_topics.py, GET /topics): a topic that backend
 * returns uses its exact id here, with a frontend-chosen display label.
 * Ids from before this contract existed are migrated, never dropped. */
export const LEGACY_TOPIC_ID_ALIASES: Readonly<Record<string, TopicCatalogId>> = { valo: "valorant" }

/** The display catalog. Two kinds of entry:
 * - Backend-supported topics (sf6/valorant/apex/minecraft):
 *   their `id` is the backend canonical id, so a creator + topic reminder can
 *   be stored and resolved against it. Whether a topic is currently supported
 *   is decided at runtime by GET /topics (see useReminderTopicSupport), not
 *   by this list.
 * - Display-only categories (gta/seven_days_to_die/mahjong_soul/endfield):
 *   shown for organising members, but the backend does not classify streams
 *   into them, so they get no independent reminder (they follow the creator's
 *   全部 setting) until the backend taxonomy includes them.
 * "all" (全部) is the creator-level scope above, a permanent default card.
 * The 5 permanent default topics (confirmed with the user: 全部/SF6/VALO/APEX/
 * Minecraft) are pre-saved and never offered again via "+" -- see
 * useTopicNotificationPreferences.ts's own INITIAL_SAVED_TOPIC_IDS. */
const MOCK_TOPIC_CATALOG: readonly TopicCatalogEntry[] = [
  { id: ALL_TOPICS_ID, labelKey: "notificationSettings.topic.all" },
  { id: "sf6", labelKey: "recentVideos.tag.sf6" },
  { id: "valorant", labelKey: "recentVideos.tag.valo" },
  { id: "apex", labelKey: "recentVideos.tag.apex" },
  { id: "minecraft", labelKey: "recentVideos.tag.minecraft" },
  { id: "gta", labelKey: "notificationSettings.topicCatalog.gta" },
  { id: "seven_days_to_die", labelKey: "notificationSettings.topicCatalog.sevenDaysToDie" },
  { id: "mahjong_soul", labelKey: "notificationSettings.topicCatalog.mahjongSoul" },
  { id: "endfield", labelKey: "notificationSettings.topicCatalog.endfield" },
]

export function getAvailableTopics(): readonly TopicCatalogEntry[] {
  return MOCK_TOPIC_CATALOG
}

/** The options a draft card's own topic <Select> may actually offer: every
 * catalog topic EXCEPT one already claimed by an existing SAVED card --
 * confirmed with the user, no two cards may ever reference the same topic.
 * Only one draft can ever exist at a time (see NotificationSettings.tsx), so
 * excluding a draft's own in-progress pick from itself is never a real
 * case -- excluding savedTopicIds alone is sufficient. */
export function getSelectableTopics(savedTopicIds: readonly TopicCatalogId[]): readonly TopicCatalogEntry[] {
  const saved = new Set(savedTopicIds)
  return getAvailableTopics().filter((topic) => !saved.has(topic.id))
}
