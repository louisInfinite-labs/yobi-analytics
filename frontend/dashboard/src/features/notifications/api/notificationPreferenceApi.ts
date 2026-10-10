import { apiRequest } from "../../../shared/api/apiClient"
import { getOrCreateClientSecret } from "../../../shared/api/clientCredential"
import { getOrCreateClientId } from "../../../shared/api/clientId"
import { getAllNotificationCreators } from "../model/notificationCreatorGrouping"

// Roadmap 4.6's own worked example uses these as the default local delivery
// windows during Japanese development; a real per-window settings UI is
// future work.
export const DEFAULT_DELIVERY_WINDOWS = ["08:00", "18:00"]

/** The full notification preference this client stores (PUT .../notification-preference replaces the whole
 * item, so every writer must send everything). `newVideoCreatorOverride` carries the Settings per-creator
 * 新片 switches: an explicit true/false for every creator the Settings roster lists, so the backend delivers
 * new-video pushes for exactly the creators the UI shows as ON. It only gates new-video pushes -- live
 * reminders are governed by the reminder settings. `newVideoShortCreatorOverride` carries the members of the Short card: Short is a
 * content FORMAT with its own field (never a topic id), and a creator not enabled there is OFF, so with no Short card every
 * value is false. */
export function buildNotificationPreference(
  enabled: boolean,
  newVideoEnabledCreatorIds: ReadonlySet<string>,
  shortEnabledCreatorIds: ReadonlySet<string>,
) {
  return {
    enabled,
    notificationLevel: "all",
    notificationTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    deliveryWindows: DEFAULT_DELIVERY_WINDOWS,
    newVideoCreatorOverride: Object.fromEntries(
      getAllNotificationCreators().map((creator) => [creator.creatorId, newVideoEnabledCreatorIds.has(creator.creatorId)]),
    ),
    newVideoShortCreatorOverride: Object.fromEntries(
      getAllNotificationCreators().map((creator) => [creator.creatorId, shortEnabledCreatorIds.has(creator.creatorId)]),
    ),
  }
}

/** Writes the full preference with an already-obtained credential (the push toggle manages its own secret so it
 * can clean up after a partial failure). */
export function putNotificationPreference(
  clientId: string,
  clientSecret: string | null,
  enabled: boolean,
  newVideoEnabledCreatorIds: ReadonlySet<string>,
  shortEnabledCreatorIds: ReadonlySet<string>,
): Promise<unknown> {
  return apiRequest(`/clients/${encodeURIComponent(clientId)}/notification-preference`, {
    method: "PUT",
    headers: clientSecret ? { "X-Client-Secret": clientSecret } : undefined,
    body: buildNotificationPreference(enabled, newVideoEnabledCreatorIds, shortEnabledCreatorIds),
  })
}

/** Writes the full preference as this browser's client, obtaining the credential itself. Rejects if the
 * backend does -- callers must not treat the change as saved in that case. */
export async function saveNotificationPreference(
  enabled: boolean,
  newVideoEnabledCreatorIds: ReadonlySet<string>,
  shortEnabledCreatorIds: ReadonlySet<string>,
): Promise<void> {
  const clientId = getOrCreateClientId()
  const clientSecret = await getOrCreateClientSecret(clientId)
  await putNotificationPreference(clientId, clientSecret, enabled, newVideoEnabledCreatorIds, shortEnabledCreatorIds)
}
