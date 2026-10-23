import { apiRequest } from "../../../shared/api/apiClient"
import { getOrCreateClientSecret } from "../../../shared/api/clientCredential"
import { getOrCreateClientId } from "../../../shared/api/clientId"

/** The backend's sparse opt-in item for 同時直播預告 (src/notifications/simultaneous_live.py's OPT_IN_KEY): present with {enabled: true} = on, absent = off. */
export const SIMULTANEOUS_LIVE_NOTICE_KEY = "simultaneousLiveNotice"

interface RemoteConfigReadResponse {
  configs: Array<{ key: string; value: unknown }>
}

async function clientSecretHeaders(clientId: string): Promise<Record<string, string> | undefined> {
  const secret = await getOrCreateClientSecret(clientId)
  return secret ? { "X-Client-Secret": secret } : undefined
}

/** Whether this client has opted in on the backend. Real backend state, not localStorage: the dispatcher reads the same item, so this stays right on
 * every device and without this browser being open. Anything but exactly {enabled: true} is off. */
export async function fetchSimultaneousLiveNotice(): Promise<boolean> {
  const clientId = getOrCreateClientId()
  const response = await apiRequest<RemoteConfigReadResponse>(
    `/remote-config?clientId=${encodeURIComponent(clientId)}&key=${encodeURIComponent(SIMULTANEOUS_LIVE_NOTICE_KEY)}`,
    { headers: await clientSecretHeaders(clientId) },
  )
  const stored = response.configs.find((config) => config.key === SIMULTANEOUS_LIVE_NOTICE_KEY)?.value
  return typeof stored === "object" && stored !== null && (stored as Record<string, unknown>).enabled === true
}

/** Opts in (PUT) or out (DELETE) -- one tiny backend item per call, never part of the notification preference (whose PUT replaces the whole item). */
export async function saveSimultaneousLiveNotice(enabled: boolean): Promise<void> {
  const clientId = getOrCreateClientId()
  await apiRequest(`/clients/${encodeURIComponent(clientId)}/simultaneous-live-notice`, {
    method: enabled ? "PUT" : "DELETE",
    headers: await clientSecretHeaders(clientId),
  })
}
