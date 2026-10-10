import { SHORT_VIDEO_FILTER } from "../../home-room/model/specialVideoFilters"
import type { VideoFilterEntry } from "../../home-room/model/videoFilterCatalog"

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

/** The 5 permanent default cards the page starts with, in this exact order (confirmed with the user: 全部/SF6/VALO/APEX/Minecraft). They
 * are never removed; every other card is added through "+ Add topic" and can be removed again. */
export const PERMANENT_TOPIC_IDS: readonly TopicCatalogId[] = [ALL_TOPICS_ID, "sf6", "valorant", "apex", "minecraft"]

export function isPermanentTopic(topicId: TopicCatalogId): boolean {
  return PERMANENT_TOPIC_IDS.includes(topicId)
}

/** Topic ids are the machine contract shared with the backend
 * (src/tracking/video_topics.py, GET /topics): a topic that backend
 * returns uses its exact id here, with its backend label. Ids from before this contract existed are migrated, never dropped. */
export const LEGACY_TOPIC_ID_ALIASES: Readonly<Record<string, TopicCatalogId>> = { valo: "valorant" }

/** Notification-only display categories this page used to hard-code (the backend never classified a stream into them). The list
 * of selectable categories is now the one Home uses (buildVideoFilterEntries), so a card saved for one of these is dropped. */
export const RETIRED_TOPIC_IDS: ReadonlySet<TopicCatalogId> = new Set(["gta", "seven_days_to_die", "mahjong_soul", "endfield"])

/** The options a draft card's own topic <Select> may actually offer: every
 * category of the shared Home list EXCEPT one already claimed by an existing SAVED card --
 * confirmed with the user, no two cards may ever reference the same topic.
 * Only one draft can ever exist at a time (see NotificationSettings.tsx), so
 * excluding a draft's own in-progress pick from itself is never a real
 * case -- excluding savedTopicIds alone is sufficient. `entries` is already in Home's order, Short before Other. */
export function getSelectableTopics(entries: readonly VideoFilterEntry[], savedTopicIds: readonly TopicCatalogId[]): readonly VideoFilterEntry[] {
  const saved = new Set(savedTopicIds)
  return entries.filter((entry) => !saved.has(entry.id))
}
