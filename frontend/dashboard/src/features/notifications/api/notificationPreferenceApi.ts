import { apiRequest } from "../../../shared/api/apiClient"
import { getOrCreateClientSecret } from "../../../shared/api/clientCredential"
import { getOrCreateClientId } from "../../../shared/api/clientId"
import { getLocale } from "../../../shared/i18n/hooks/useLocale"
import { getDeliverySlots } from "../hooks/deliverySlotsStore"
import { DEFAULT_DELIVERY_SLOTS } from "../model/deliverySlots"
import { getAllNotificationCreators } from "../model/notificationCreatorGrouping"

/** The delivery slots a browser sends until its user picks their own (see useDeliverySlots). */
export const DEFAULT_DELIVERY_WINDOWS = [...DEFAULT_DELIVERY_SLOTS]

const NOTIFICATION_LOCALE_SYNCED_KEY = "yobi.notificationLocaleSynced"
const NOTIFICATIONS_DISABLED_KEY = "yobi.notificationsDisabled"

// Kept in module memory when storage itself fails after a confirmed write, so the OFF state still holds for the rest of this page
// session (same pattern as getOrCreateClientId). Null whenever storage holds the answer. Across a reload an unavailable store cannot
// carry it -- but that browser also cannot persist its clientId, so the reloaded page is a different client anyway.
let memoryOnlyDisabled: boolean | null = null

/** True once a preference write with `enabled: false` succeeded for this browser and no later write turned notifications back on.
 * Global OFF is the master switch: background syncs (language change, creator switches) must not infer "on" from a browser push
 * subscription that merely outlived a failed unsubscribe. Browser-local bookkeeping about the last CONFIRMED backend write. */
export function isNotificationDisabledByUser(): boolean {
  try {
    if (window.localStorage.getItem(NOTIFICATIONS_DISABLED_KEY) === "1") return true
  } catch {
    // Unreadable storage: fall through to the in-session value.
  }
  return memoryOnlyDisabled === true
}

function markNotificationEnabledState(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.removeItem(NOTIFICATIONS_DISABLED_KEY)
    else window.localStorage.setItem(NOTIFICATIONS_DISABLED_KEY, "1")
    memoryOnlyDisabled = null
  } catch {
    memoryOnlyDisabled = !enabled
  }
}

/** The locale the backend last CONFIRMED (a successful preference write) for this browser's push notifications, or null if never.
 * Browser-local bookkeeping only -- the backend value is the one the dispatcher reads. */
export function getSyncedNotificationLocale(): string | null {
  try {
    return window.localStorage.getItem(NOTIFICATION_LOCALE_SYNCED_KEY)
  } catch {
    return null
  }
}

function markNotificationLocaleSynced(locale: string): void {
  try {
    window.localStorage.setItem(NOTIFICATION_LOCALE_SYNCED_KEY, locale)
  } catch {
    // Without the marker the next app start simply re-sends the preference once more.
  }
}

/** The full notification preference this client stores (PUT .../notification-preference replaces the whole
 * item, so every writer must send everything). `newVideoCreatorOverride` carries the Settings per-creator
 * 新片 switches: an explicit true/false for every creator the Settings roster lists, so the backend delivers
 * new-video pushes for exactly the creators the UI shows as ON. It only gates new-video pushes -- live
 * reminders are governed by the reminder settings. The roster deliberately omits group channels, staff and graduated members, and they
 * are NOT listed here: the backend reads a creator with no entry as OFF (fail-closed), so leaving them out is how they stay silent.
 * `newVideoShortCreatorOverride` carries the members of the Short card: Short is a
 * content FORMAT with its own field (never a topic id), and a creator not enabled there is OFF, so with no Short card every
 * value is false. `deliveryWindows` are the fixed Japan Standard Time (Asia/Tokyo) half-hour slots new-video pushes are delivered
 * at -- always JST, never `notificationTimeZone` (which only governs quiet hours and reminders); every writer sends the user's
 * stored slots unless it is writing a PROPOSED selection that is not stored yet. */
export function buildNotificationPreference(
  enabled: boolean,
  newVideoEnabledCreatorIds: ReadonlySet<string>,
  shortEnabledCreatorIds: ReadonlySet<string>,
  deliveryWindows: readonly string[] = getDeliverySlots(),
) {
  return {
    enabled,
    notificationLevel: "all",
    notificationTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    // The language of this client's push notifications (zh-TW / ja / en): follows the dashboard language, and is part of the
    // full preference so every writer (enable toggle, Settings switches, the language-change sync) carries it.
    notificationLocale: getLocale(),
    deliveryWindows: [...deliveryWindows],
    newVideoCreatorOverride: Object.fromEntries(
      getAllNotificationCreators().map((creator) => [creator.creatorId, newVideoEnabledCreatorIds.has(creator.creatorId)]),
    ),
    newVideoShortCreatorOverride: Object.fromEntries(
      getAllNotificationCreators().map((creator) => [creator.creatorId, shortEnabledCreatorIds.has(creator.creatorId)]),
    ),
  }
}

// Every preference PUT -- the toggle's explicit enable/disable AND the automatic syncs (language change, creator switches) -- runs through
// this one queue, one at a time in call order. PUT replaces the whole item, so two writes in flight could land out of order; serialized,
// an older automatic sync can never complete AFTER a newer explicit disable and overwrite it.
let writeChain: Promise<unknown> = Promise.resolve()

function inWriteOrder<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task)
  writeChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function writePreference(
  clientId: string,
  clientSecret: string | null,
  enabled: boolean,
  newVideoEnabledCreatorIds: ReadonlySet<string>,
  shortEnabledCreatorIds: ReadonlySet<string>,
  deliveryWindows?: readonly string[],
): Promise<unknown> {
  const body = buildNotificationPreference(enabled, newVideoEnabledCreatorIds, shortEnabledCreatorIds, deliveryWindows)
  return apiRequest(`/clients/${encodeURIComponent(clientId)}/notification-preference`, {
    method: "PUT",
    headers: clientSecret ? { "X-Client-Secret": clientSecret } : undefined,
    body,
  }).then((result) => {
    markNotificationLocaleSynced(body.notificationLocale)
    // Recorded as soon as the backend confirms, i.e. before the caller attempts the browser unsubscribe.
    markNotificationEnabledState(enabled)
    return result
  })
}

/** Writes the full preference with an already-obtained credential (the push toggle manages its own secret so it
 * can clean up after a partial failure). Queued behind every earlier preference write (see writeChain). */
export function putNotificationPreference(
  clientId: string,
  clientSecret: string | null,
  enabled: boolean,
  newVideoEnabledCreatorIds: ReadonlySet<string>,
  shortEnabledCreatorIds: ReadonlySet<string>,
  deliveryWindows?: readonly string[],
): Promise<unknown> {
  return inWriteOrder(() => writePreference(clientId, clientSecret, enabled, newVideoEnabledCreatorIds, shortEnabledCreatorIds, deliveryWindows))
}

/** The AUTOMATIC writer (language change, creator switches): writes the full preference as this browser's client, obtaining the
 * credential itself. Queued behind every earlier preference write, and a write that would turn notifications ON is skipped when the
 * user has disabled them -- that check runs inside the queue, immediately before the PUT, so a disable that was queued or completed
 * ahead of this sync always wins. Rejects if the backend does -- callers must not treat the change as saved in that case. */
export async function saveNotificationPreference(
  enabled: boolean,
  newVideoEnabledCreatorIds: ReadonlySet<string>,
  shortEnabledCreatorIds: ReadonlySet<string>,
  deliveryWindows?: readonly string[],
): Promise<void> {
  await inWriteOrder(async () => {
    if (enabled && isNotificationDisabledByUser()) return
    const clientId = getOrCreateClientId()
    const clientSecret = await getOrCreateClientSecret(clientId)
    await writePreference(clientId, clientSecret, enabled, newVideoEnabledCreatorIds, shortEnabledCreatorIds, deliveryWindows)
  })
}
