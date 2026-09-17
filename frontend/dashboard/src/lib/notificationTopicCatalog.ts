import type { TranslationKey } from "../i18n/translations"

export type TopicCatalogId = string

export interface TopicCatalogEntry {
  id: TopicCatalogId
  labelKey: TranslationKey
}

/** Local-dev mock catalog. Two groups:
 * - The 5 permanent default topics (confirmed with the user: 全部/SF6/VALO/
 *   APEX/Minecraft must stay pre-saved and are never offered again via "+"
 *   -- see useTopicNotificationPreferences.ts's own INITIAL_SAVED_TOPIC_IDS).
 *   "all" keeps its own dedicated notificationSettings.topic.all label
 *   (restored -- this used to be the fixed topic list's own "全部" entry);
 *   sf6/apex/minecraft reuse recentVideos.tag.* exactly like they always
 *   did before topics became dynamic.
 * - The 4 topics actually addable through "+" (GTA/7 DAYS TO DIE/雀魂/終末地
 *   -- the user's own confirmed local-dev catalog). GTA/7 DAYS TO DIE/雀魂
 *   have no existing translation anywhere in the project -- per the user's
 *   own instruction, they keep the exact same literal string in every
 *   locale (same treatment "VALO"/"SF6" already get). 終末地 gets real
 *   per-locale labels (zh-TW/en/ja differ).
 * "valo" is both a permanent default AND was the original catalog's own
 * VALO entry -- one array entry serves both, since a permanent default is
 * simply pre-added to savedTopicIds from the start (getSelectableTopics
 * already excludes anything in savedTopicIds, so it's automatically never
 * offered again via "+" either, the same as any other saved topic).
 *
 * No backend topic/category endpoint exists yet (confirmed with the user:
 * don't invent one) -- getAvailableTopics() is the one seam a future real
 * fetch would replace, without any caller needing to change. */
const MOCK_TOPIC_CATALOG: readonly TopicCatalogEntry[] = [
  { id: "all", labelKey: "notificationSettings.topic.all" },
  { id: "sf6", labelKey: "recentVideos.tag.sf6" },
  { id: "valo", labelKey: "recentVideos.tag.valo" },
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
