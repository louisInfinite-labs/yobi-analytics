import { useCallback, useEffect, useState } from "react"
import {
  consumePairingSession,
  createPairingSession,
  deleteDeviceSyncSibling,
  listDeviceSyncSiblings,
  type DeviceSyncDevice,
  type PairingSession,
} from "./api/deviceSyncApi"
import type { DeviceType } from "./model/syncDevice"

/** Shared business logic for Device Sync, used identically by PcDeviceSync.tsx and MobileDeviceSync.tsx -- the
 * two render entirely different JSX around the exact same state/actions (the spec's own "share business logic,
 * allow platform-specific presentation" instruction), rather than one shared component styled responsively. */
export function useDeviceSyncController() {
  const [profileId, setProfileId] = useState<string | null>(null)
  const [devices, setDevices] = useState<DeviceSyncDevice[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const result = await listDeviceSyncSiblings()
      setProfileId(result.profileId)
      setDevices(result.devices)
      setError(null)
    } catch {
      setError("refresh")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const createSession = useCallback(async (): Promise<PairingSession | null> => {
    setBusy(true)
    try {
      // Passing the CURRENT profileId (undefined when this device is itself still unpaired) is what lets an
      // already-paired device invite a second one into the SAME profile, instead of every new session minting a
      // fresh one (api_handler.py's _handle_post_pairing_session docstring).
      const session = await createPairingSession(profileId ?? undefined)
      setError(null)
      return session
    } catch {
      setError("createSession")
      return null
    } finally {
      setBusy(false)
    }
  }, [profileId])

  const consume = useCallback(
    async (credential: { token: string } | { code: string }, deviceLabel: string, deviceType: DeviceType): Promise<boolean> => {
      setBusy(true)
      try {
        await consumePairingSession(credential, deviceLabel, deviceType)
        await refresh()
        return true
      } catch {
        setError("consume")
        return false
      } finally {
        setBusy(false)
      }
    },
    [refresh],
  )

  const revoke = useCallback(
    async (targetDeviceId: string) => {
      setBusy(true)
      try {
        await deleteDeviceSyncSibling(targetDeviceId)
        await refresh()
      } catch {
        setError("revoke")
      } finally {
        setBusy(false)
      }
    },
    [refresh],
  )

  return { profileId, devices, loading, busy, error, refresh, createSession, consume, revoke }
}

export type DeviceSyncController = ReturnType<typeof useDeviceSyncController>
