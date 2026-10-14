import { apiRequest } from "../../../shared/api/apiClient"
import { getOrCreateClientSecret } from "../../../shared/api/clientCredential"
import { getOrCreateClientId } from "../../../shared/api/clientId"
import type { DeviceType } from "../model/syncDevice"

export interface PairingSession {
  token: string
  humanCode: string
  expiresAt: number
}

export interface DeviceSyncDevice {
  profileId: string
  deviceId: string
  deviceLabel: string
  deviceType: DeviceType
  createdAt: string
  lastSeenAt: string
}

/** This browser/PWA's own stable local identity (clientId.ts's existing Roadmap 4.3 id) and the secret that
 * proves ownership of it -- every Device Sync self-service route requires both, exactly like the existing
 * push-subscription/notification-preference routes. Never throws: a null secret means the upcoming call will be
 * rejected by the backend, the same degrade-safely contract those routes already use. */
async function thisDeviceCredential(): Promise<{ deviceId: string; clientSecret: string | null }> {
  const deviceId = getOrCreateClientId()
  const clientSecret = await getOrCreateClientSecret(deviceId)
  return { deviceId, clientSecret }
}

function secretHeader(clientSecret: string | null): Record<string, string> | undefined {
  return clientSecret ? { "X-Client-Secret": clientSecret } : undefined
}

/** This device's own stable deviceId (clientId.ts's id) -- Device Sync never mints a second, competing identity. */
export function getThisDeviceId(): string {
  return getOrCreateClientId()
}

/** Create a new pairing session as THIS device: the QR/code another device will scan or type.
 * `profileId` is omitted for a fresh pairing (two unpaired devices meeting for the first time), or passed when
 * this device already belongs to a profile and is inviting a second device into it. */
export async function createPairingSession(profileId?: string): Promise<PairingSession> {
  const { deviceId, clientSecret } = await thisDeviceCredential()
  return apiRequest<PairingSession>("/sync/pairing-sessions", {
    method: "POST",
    headers: secretHeader(clientSecret),
    body: profileId ? { deviceId, profileId } : { deviceId },
  })
}

/** Redeem a scanned QR token or a typed human code as THIS device, attaching it to the resulting Sync Profile.
 * Exactly one of `token`/`code` is passed. No client-secret header: possession of the one-time value itself is
 * this route's whole trust model (api_handler.py's own `_handle_post_pairing_consume` docstring). */
export async function consumePairingSession(
  credential: { token: string } | { code: string },
  deviceLabel: string,
  deviceType: DeviceType,
): Promise<{ profileId: string }> {
  const deviceId = getThisDeviceId()
  return apiRequest<{ profileId: string }>("/sync/pairing-sessions/consume", {
    method: "POST",
    body: { ...credential, deviceId, deviceLabel, deviceType },
  })
}

/** Which Sync Profile (if any) THIS device currently belongs to. `profileId: null` means solo/unpaired. */
export async function getDeviceSyncProfile(): Promise<{ deviceId: string; profileId: string | null }> {
  const { deviceId, clientSecret } = await thisDeviceCredential()
  return apiRequest(`/sync/devices/${encodeURIComponent(deviceId)}/profile`, { headers: secretHeader(clientSecret) })
}

/** Every device sharing THIS device's Sync Profile (the Connected Devices list), including itself. An empty list
 * when this device is unpaired. */
export async function listDeviceSyncSiblings(): Promise<{ profileId: string | null; devices: DeviceSyncDevice[] }> {
  const { deviceId, clientSecret } = await thisDeviceCredential()
  return apiRequest(`/sync/devices/${encodeURIComponent(deviceId)}/siblings`, { headers: secretHeader(clientSecret) })
}

/** Revoke one OTHER device from THIS device's own Sync Profile. Never revokes the caller itself or every device
 * at once -- one explicit target per call, matching the spec's "never an ambiguous single button" requirement. */
export async function deleteDeviceSyncSibling(targetDeviceId: string): Promise<void> {
  const { deviceId, clientSecret } = await thisDeviceCredential()
  await apiRequest(`/sync/devices/${encodeURIComponent(deviceId)}/siblings/${encodeURIComponent(targetDeviceId)}`, {
    method: "DELETE",
    headers: secretHeader(clientSecret),
  })
}
