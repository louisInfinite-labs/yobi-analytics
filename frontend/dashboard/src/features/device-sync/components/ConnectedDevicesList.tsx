import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t } from "../../../shared/i18n/translations"
import type { DeviceSyncDevice } from "../api/deviceSyncApi"

/** Desktop's own wide-layout connected-devices presentation: one row per device, label + a per-row revoke button
 * -- never a single "disconnect all" action (spec section 21/22). Never renders a raw deviceId. */
export function ConnectedDevicesList({
  devices,
  thisDeviceId,
  onRevoke,
  busy,
}: {
  devices: DeviceSyncDevice[]
  thisDeviceId: string
  onRevoke: (deviceId: string) => void
  busy: boolean
}) {
  const [locale] = useLocale()

  if (devices.length === 0) {
    return <p className="device-sync-empty">{t(locale, "deviceSync.noDevices")}</p>
  }

  return (
    <ul className="device-sync-devices-list">
      {devices.map((device) => {
        const isThisDevice = device.deviceId === thisDeviceId
        return (
          <li key={device.deviceId} className="device-sync-devices-row">
            <span className="device-sync-devices-label">
              {device.deviceLabel}
              {isThisDevice && <span className="device-sync-devices-current"> {t(locale, "deviceSync.thisDeviceBadge")}</span>}
            </span>
            {!isThisDevice && (
              <button type="button" className="device-sync-devices-revoke" onClick={() => onRevoke(device.deviceId)} disabled={busy}>
                {t(locale, "deviceSync.revoke")}
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
