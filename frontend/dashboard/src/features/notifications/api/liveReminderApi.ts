import { apiRequest } from "../../../shared/api/apiClient"
import { getOrCreateClientSecret } from "../../../shared/api/clientCredential"
import { getOrCreateClientId } from "../../../shared/api/clientId"
import type { ReminderTimeValue } from "../model/notificationTopics"

/** The backend's own creatorLiveReminders/streamNotificationOverrides shape
 * (src/notifications/live_reminder.py) -- notifyAtStart and advanceReminder
 * are independent, both-can-apply fields (not a single mutually-exclusive
 * choice): advanceReminder is one of REMINDER_TIME_VALUES minus "at_start",
 * or null for "no additional reminder". */
export interface LiveReminderSetting {
  notifyAtStart: boolean
  advanceReminder: Exclude<ReminderTimeValue, "at_start"> | null
}

/** Maps the single existing ReminderTimeValue control (Settings/Schedule's
 * shared Segmented) onto the backend's two-field shape -- "at_start" is
 * encoded as advanceReminder=null (no additional reminder beyond the
 * guaranteed start notification), every other value is passed through as
 * the advance reminder, with notifyAtStart always true: neither the
 * Settings nor the Schedule UI currently offers a way to disable the start
 * notification on its own while keeping an advance reminder. */
export function reminderValueToSetting(value: ReminderTimeValue): LiveReminderSetting {
  return { notifyAtStart: true, advanceReminder: value === "at_start" ? null : value }
}

export function settingToReminderValue(setting: LiveReminderSetting | null | undefined): ReminderTimeValue | null {
  if (!setting) return null
  return setting.advanceReminder ?? "at_start"
}

interface RemoteConfigReadResponse {
  configs: Array<{ clientId: string; key: string; value: unknown; updatedAt: string }>
}

async function clientSecretHeaders(clientId: string): Promise<Record<string, string> | undefined> {
  const secret = await getOrCreateClientSecret(clientId)
  return secret ? { "X-Client-Secret": secret } : undefined
}

async function readRemoteConfigValue(key: string): Promise<Record<string, unknown>> {
  const clientId = getOrCreateClientId()
  const response = await apiRequest<RemoteConfigReadResponse>(
    `/remote-config?clientId=${encodeURIComponent(clientId)}&key=${encodeURIComponent(key)}`,
    { headers: await clientSecretHeaders(clientId) },
  )
  const value = response.configs[0]?.value
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

/** Every creator this client has their own saved recurring live-reminder
 * setting for (src/notifications/live_reminder.py's "creatorLiveReminders"
 * remote-config key) -- real backend-persisted state, not localStorage, so
 * the dispatcher (and Schedule's single-stream override fallback) can see
 * it without this browser needing to be open. */
export async function fetchCreatorLiveReminders(): Promise<Record<string, LiveReminderSetting>> {
  return (await readRemoteConfigValue("creatorLiveReminders")) as Record<string, LiveReminderSetting>
}

export async function saveCreatorLiveReminder(creatorId: string, setting: LiveReminderSetting): Promise<void> {
  const clientId = getOrCreateClientId()
  await apiRequest(`/clients/${encodeURIComponent(clientId)}/creator-live-reminder/${encodeURIComponent(creatorId)}`, {
    method: "PUT",
    headers: await clientSecretHeaders(clientId),
    body: setting,
  })
}

/** Notification preference only -- deliberately no scheduledStartMs. A
 * livestream can be rescheduled after this is saved; the backend always
 * resolves the CURRENT scheduledStartMs from its own system-wide schedule
 * snapshot at dispatch time (src/notifications/live_reminder.py's
 * StreamScheduleEntry), for overridden and non-overridden streams alike,
 * rather than trusting a value frozen here at save time. */
export interface StreamNotificationOverride extends LiveReminderSetting {
  creatorId: string
}

/** Every stream this client has their own saved single-stream override for
 * (src/notifications/live_reminder.py's "streamNotificationOverrides" key),
 * keyed by videoId. */
export async function fetchStreamNotificationOverrides(): Promise<Record<string, StreamNotificationOverride>> {
  return (await readRemoteConfigValue("streamNotificationOverrides")) as Record<string, StreamNotificationOverride>
}

export async function saveStreamNotificationOverride(videoId: string, override: StreamNotificationOverride): Promise<void> {
  const clientId = getOrCreateClientId()
  await apiRequest(`/clients/${encodeURIComponent(clientId)}/stream-notification-override/${encodeURIComponent(videoId)}`, {
    method: "PUT",
    headers: await clientSecretHeaders(clientId),
    body: override,
  })
}
