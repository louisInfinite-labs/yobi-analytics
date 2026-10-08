import type { TranslationKey } from "../../../shared/i18n/translations"

/** Reminder-time values a creator can be notified at -- confirmed directly
 * with the user: 開播時/1 分鐘前/10 分鐘前/30 分鐘前/1 小時前.
 *
 * Semantics (confirmed with the user): "at_start" means notify when the
 * stream starts; every other value means an ADDITIONAL pre-live reminder at
 * that offset, on top of the start notification -- e.g. "10min" is "notify 10
 * minutes before, and again at start". A reminder that is not set at all
 * ("unset", represented as `null` -- see ReminderSetting) means NO reminder:
 * it is a different state from "at_start" and is never defaulted to any value.
 *
 * Which setting actually applies to a stream is decided by the backend, in
 * this precedence (highest first): Mute / Quiet Hours > a reminder set for
 * that one stream from Schedule > the creator's 全部 reminder > the creator +
 * the stream's topic reminder > unset. Setting 全部 never erases a topic
 * reminder -- it only shadows it until 全部 is unset again. */
export type ReminderTimeValue = "at_start" | "1min" | "10min" | "30min" | "1hour"

/** A reminder choice, where `null` is "unset" (no reminder). */
export type ReminderSetting = ReminderTimeValue | null

export const REMINDER_TIME_VALUES: readonly ReminderTimeValue[] = ["at_start", "1min", "10min", "30min", "1hour"]

export const REMINDER_TIME_LABEL_KEYS: Record<ReminderTimeValue, TranslationKey> = {
  at_start: "notificationSettings.reminder.atStart",
  "1min": "notificationSettings.reminder.1min",
  "10min": "notificationSettings.reminder.10min",
  "30min": "notificationSettings.reminder.30min",
  "1hour": "notificationSettings.reminder.1hour",
}

/** A topic-level preference for which kind(s) of notification it sends --
 * "both" is the starting value for every topic (matches this feature's own
 * pre-existing behavior, where a creator's Live and New Video enablement
 * were always independent per-creator switches with no topic-wide filter
 * on top; "both" preserves that default exactly for every existing topic).
 * The topic-level type is the source of truth for which channel(s) are
 * effectively live: it gates each creator's own Live/New Video switches in
 * TopicCreatorManagementDrawer (see useTopicNotificationPreferences'
 * isLiveChannelAllowed/isNewVideoChannelAllowed), while the underlying
 * per-creator membership itself stays stored and unchanged, so switching
 * the type back restores exactly what was there before. */
export type TopicNotificationType = "live" | "newVideo" | "both"
export const INITIAL_TOPIC_NOTIFICATION_TYPE: TopicNotificationType = "both"
