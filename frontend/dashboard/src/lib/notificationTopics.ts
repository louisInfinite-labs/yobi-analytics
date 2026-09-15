import type { TranslationKey } from "../i18n/translations"

/** Reminder-mode machinery only -- topic IDENTITY (which topics exist, and
 * their labels) now lives in lib/notificationTopicCatalog.ts instead: this
 * used to also hold a closed NotificationTopicId enum/NOTIFICATION_TOPICS
 * array, but topics are now a dynamic, user-added list (confirmed with the
 * user), so nothing here can assume a fixed topic set any more. Everything
 * below is genuinely topic-agnostic and unaffected by that change.
 *
 * Reminder-time values a creator can be notified at -- confirmed directly
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
