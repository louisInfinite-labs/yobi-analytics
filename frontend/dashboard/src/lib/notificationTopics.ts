import type { TranslationKey } from "../i18n/translations"

/** Notification Settings' own topic list. Reuses the exact id spellings
 * already defined by Home's VideoCategory (lib/videoCategories.ts) --
 * "valo"/"apex"/"minecraft"/"sf6"/"singing"/"chatting" -- since that is the
 * only place this game/activity vocabulary already exists in the app, and
 * the display labels below reuse that feature's own already-translated
 * strings (t(locale, "recentVideos.tag.valo") etc.) rather than inventing
 * new proper-noun translations. VideoCategory's own type is deliberately
 * NOT imported here: that taxonomy tags VIDEO CONTENT on Home's Recent
 * Videos section, a different concern from "which topics a creator can be
 * subscribed to notifications for" (same reasoning as videoCategories.ts's
 * own top comment about not reusing ContentTagKey/ContentFormat for its
 * concern) -- this stays its own small, notification-specific list, this
 * feature's only actual net-new taxonomy decision.
 *
 * "other" is a user-requested addition (this feature's original written
 * spec excluded it, reasoning it had no coherent "notify me about this
 * topic" meaning) -- confirmed with the user, it reuses VideoCategory's own
 * "recentVideos.tag.other" label, same as every other non-"all" topic here
 * reusing that feature's own tag labels. */
export type NotificationTopicId = "all" | "valo" | "apex" | "minecraft" | "sf6" | "singing" | "chatting" | "other"

export interface NotificationTopic {
  id: NotificationTopicId
  labelKey: TranslationKey
}

/** "all" is a user-requested addition (not from the original written spec)
 * -- its own label ("全部"/"All"/"全部", given directly by the user) is
 * deliberately its own new key rather than reusing Home's existing
 * "recentVideos.tag.all" ("ALL" in every locale): the wording the user
 * asked for here doesn't match that existing string, so reusing it would
 * silently show the wrong text rather than what was actually requested. */
export const NOTIFICATION_TOPICS: readonly NotificationTopic[] = [
  { id: "all", labelKey: "notificationSettings.topic.all" },
  { id: "valo", labelKey: "recentVideos.tag.valo" },
  { id: "apex", labelKey: "recentVideos.tag.apex" },
  { id: "minecraft", labelKey: "recentVideos.tag.minecraft" },
  { id: "sf6", labelKey: "recentVideos.tag.sf6" },
  { id: "singing", labelKey: "recentVideos.tag.singing" },
  { id: "chatting", labelKey: "recentVideos.tag.chatting" },
  { id: "other", labelKey: "recentVideos.tag.other" },
]

/** Reminder-time values a creator can be notified at -- confirmed directly
 * with the user (superseding this feature's original written spec, which
 * also listed "5 分鐘前"): 開播時/10 分鐘前/30 分鐘前/1 小時前 only. */
export type ReminderTimeValue = "at_start" | "10min" | "30min" | "1hour"

export const REMINDER_TIME_VALUES: readonly ReminderTimeValue[] = ["at_start", "10min", "30min", "1hour"]

export const REMINDER_TIME_LABEL_KEYS: Record<ReminderTimeValue, TranslationKey> = {
  at_start: "notificationSettings.reminder.atStart",
  "10min": "notificationSettings.reminder.10min",
  "30min": "notificationSettings.reminder.30min",
  "1hour": "notificationSettings.reminder.1hour",
}

/** Sentinel topic-level mode -- confirmed with the user, this REPLACES the
 * original written spec's "default + optional per-creator override, member
 * override always wins" inheritance model with a MODE SWITCH instead:
 * - Topic's own reminder mode is a concrete ReminderTimeValue: that time is
 *   forced onto every Live-enabled member of the topic, full stop --
 *   overriding whatever that member's own reminder is individually set to.
 * - Topic's own reminder mode is "member_choice": each member's own
 *   individually-set reminder (see useTopicNotificationPreferences'
 *   getMemberReminder) is what actually applies.
 * A member's own individual setting is NEVER cleared by the topic being in
 * a concrete-time mode -- it just sits dormant (not currently in effect)
 * until the topic switches back to "member_choice". This sentinel is
 * deliberately NOT a selectable value in a member's OWN reminder control
 * (REMINDER_TIME_VALUES above) -- "member_choice" only exists as a
 * topic-level mode, a member can't set their own reminder to "go by each
 * member's own setting". */
export const MEMBER_CHOICE_MODE = "member_choice"
export type TopicReminderMode = typeof MEMBER_CHOICE_MODE | ReminderTimeValue

/** Every topic's own starting reminder mode, before any user change -- "10
 * 分鐘前", this spec's own worked example value for VALORANT (section 3),
 * applied uniformly to every topic since no other topic has its own
 * example to draw a different starting value from. */
export const INITIAL_TOPIC_REMINDER_MODE: TopicReminderMode = "10min"

/** A member's own reminder, before they've ever touched their own control
 * (useTopicNotificationPreferences' getMemberReminder falls back to this
 * when nothing is stored yet) -- same "10 分鐘前" starting value as
 * INITIAL_TOPIC_REMINDER_MODE above, for consistency, since no other value
 * was specified for this case. */
export const INITIAL_MEMBER_REMINDER: ReminderTimeValue = "10min"
