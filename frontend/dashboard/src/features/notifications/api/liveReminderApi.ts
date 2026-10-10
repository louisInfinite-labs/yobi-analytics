import { apiRequest } from "../../../shared/api/apiClient"
import { getOrCreateClientSecret } from "../../../shared/api/clientCredential"
import { getOrCreateClientId } from "../../../shared/api/clientId"
import { ALL_TOPICS_ID } from "../model/notificationTopicCatalog"
import { REMINDER_TIME_VALUES, type ReminderSetting, type ReminderTimeValue } from "../model/notificationTopics"

/** The backend's own reminder setting shape (src/notifications/live_reminder.py)
 * -- notifyAtStart and advanceReminder are independent, both-can-apply fields
 * (not a single mutually-exclusive choice): advanceReminder is one of
 * REMINDER_TIME_VALUES minus "at_start", or null for "no additional reminder". */
export interface LiveReminderSetting {
  notifyAtStart: boolean
  advanceReminder: Exclude<ReminderTimeValue, "at_start"> | null
}

/** Maps the single existing ReminderTimeValue control (Settings/Schedule's
 * shared Segmented) onto the backend's two-field shape -- "at_start" is
 * encoded as advanceReminder=null (no additional reminder beyond the
 * start notification), every other value is passed through as the advance
 * reminder, with notifyAtStart always true. "Unset" is not a setting at all:
 * it is the backend item being absent (see deleteCreatorReminder). */
export function reminderValueToSetting(value: ReminderTimeValue): LiveReminderSetting {
  return { notifyAtStart: true, advanceReminder: value === "at_start" ? null : value }
}

export function settingToReminderValue(setting: LiveReminderSetting | null | undefined): ReminderSetting {
  if (!setting) return null
  return setting.advanceReminder ?? "at_start"
}

/** Every reminder setting this client has stored, one backend item each
 * (src/notifications/live_reminder.py): the creator-level 全部 setting per
 * creator, the creator + topic settings, and the per-stream overrides. */
export interface ReminderSettingsSnapshot {
  creatorAll: Record<string, LiveReminderSetting>
  creatorTopics: Record<string, Record<string, LiveReminderSetting>>
  streamOverrides: Record<string, StreamNotificationOverride>
}

export function emptyReminderSettings(): ReminderSettingsSnapshot {
  return { creatorAll: {}, creatorTopics: {}, streamOverrides: {} }
}

interface RemoteConfigReadResponse {
  configs: Array<{ clientId: string; key: string; value: unknown; updatedAt: string }>
}

const CREATOR_REMINDER_KEY_PREFIX = "creatorReminder#"
const STREAM_OVERRIDE_KEY_PREFIX = "streamOverride#"
const KEY_SEPARATOR = "#"

async function clientSecretHeaders(clientId: string): Promise<Record<string, string> | undefined> {
  const secret = await getOrCreateClientSecret(clientId)
  return secret ? { "X-Client-Secret": secret } : undefined
}

function isLiveReminderSetting(value: unknown): value is LiveReminderSetting {
  if (!value || typeof value !== "object") return false
  const { notifyAtStart, advanceReminder } = value as Record<string, unknown>
  return (
    typeof notifyAtStart === "boolean" &&
    (advanceReminder === null || (typeof advanceReminder === "string" && advanceReminder !== "at_start" && (REMINDER_TIME_VALUES as readonly string[]).includes(advanceReminder)))
  )
}

function isStreamOverride(value: unknown): value is StreamNotificationOverride {
  return isLiveReminderSetting(value) && typeof (value as unknown as Record<string, unknown>).creatorId === "string"
}

/** Every reminder setting this client has stored on the backend -- real
 * backend-persisted state, not localStorage, so the dispatcher (and
 * Schedule's effective-reminder display) see the same thing without this
 * browser needing to be open. A stored item that doesn't parse is skipped. */
export async function fetchReminderSettings(): Promise<ReminderSettingsSnapshot> {
  const clientId = getOrCreateClientId()
  const response = await apiRequest<RemoteConfigReadResponse>(`/remote-config?clientId=${encodeURIComponent(clientId)}`, {
    headers: await clientSecretHeaders(clientId),
  })
  const snapshot = emptyReminderSettings()
  for (const { key, value } of response.configs) {
    if (key.startsWith(CREATOR_REMINDER_KEY_PREFIX)) {
      const [, creatorId, scope, ...rest] = key.split(KEY_SEPARATOR)
      if (!creatorId || !scope || rest.length > 0 || !isLiveReminderSetting(value)) continue
      if (scope === ALL_TOPICS_ID) snapshot.creatorAll[creatorId] = value
      else (snapshot.creatorTopics[creatorId] ??= {})[scope] = value
    } else if (key.startsWith(STREAM_OVERRIDE_KEY_PREFIX)) {
      const videoId = key.slice(STREAM_OVERRIDE_KEY_PREFIX.length)
      if (videoId && isStreamOverride(value)) snapshot.streamOverrides[videoId] = value
    }
  }
  return snapshot
}

function creatorReminderPath(clientId: string, creatorId: string, scope: string): string {
  return `/clients/${encodeURIComponent(clientId)}/creator-reminder/${encodeURIComponent(creatorId)}/${encodeURIComponent(scope)}`
}

/** Sets ONE reminder: scope "all" is the creator's 全部 reminder, any other
 * scope is a canonical backend topic id. One backend item per call -- it
 * cannot overwrite the creator's other scopes, other creators, or any other
 * preference. */
export async function saveCreatorReminder(creatorId: string, scope: string, setting: LiveReminderSetting): Promise<void> {
  const clientId = getOrCreateClientId()
  await apiRequest(creatorReminderPath(clientId, creatorId, scope), {
    method: "PUT",
    headers: await clientSecretHeaders(clientId),
    body: setting,
  })
}

/** Unsets ONE reminder (see saveCreatorReminder) by deleting only its own backend item. */
export async function deleteCreatorReminder(creatorId: string, scope: string): Promise<void> {
  const clientId = getOrCreateClientId()
  await apiRequest(creatorReminderPath(clientId, creatorId, scope), {
    method: "DELETE",
    headers: await clientSecretHeaders(clientId),
  })
}

/** Notification preference only -- deliberately no scheduledStartMs. A
 * livestream can be rescheduled after this is saved; the backend always
 * resolves the CURRENT scheduledStartMs from its own system-wide schedule
 * snapshot at dispatch time (src/notifications/live_reminder.py's
 * StreamScheduleEntry), rather than trusting a value frozen here at save time. */
export interface StreamNotificationOverride extends LiveReminderSetting {
  creatorId: string
}

/** Removes this one stream's override, so the stream falls back to the creator 全部 / topic reminders again. Deletes only that stream's own item. */
export async function deleteStreamNotificationOverride(videoId: string): Promise<void> {
  const clientId = getOrCreateClientId()
  await apiRequest(`/clients/${encodeURIComponent(clientId)}/stream-notification-override/${encodeURIComponent(videoId)}`, {
    method: "DELETE",
    headers: await clientSecretHeaders(clientId),
  })
}

/** Sets this one stream's override (from Schedule/Timeline). It outranks the
 * creator's 全部 and topic reminders for that exact stream only, and never
 * changes them. */
export async function saveStreamNotificationOverride(videoId: string, override: StreamNotificationOverride): Promise<void> {
  const clientId = getOrCreateClientId()
  await apiRequest(`/clients/${encodeURIComponent(clientId)}/stream-notification-override/${encodeURIComponent(videoId)}`, {
    method: "PUT",
    headers: await clientSecretHeaders(clientId),
    body: override,
  })
}
