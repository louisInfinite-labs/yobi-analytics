import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t } from "../../../shared/i18n/translations"
import type { DeviceSyncDevice } from "../api/deviceSyncApi"

/** Mobile's own compact connected-devices presentation (spec section 9/11/21/24): a single-column, touch-sized
 * list -- deliberately a separate component from ConnectedDevicesList, not that one reused at a narrower width,
 * per the "mobile UX is not a 1:1 desktop copy" requirement. No per-row label/badge layout tuning shared with
 * desktop's row shape; this one is free to grow taller rows for a comfortable tap target instead. */
export function ConnectedDevicesCompactList({
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
    <ul className="device-sync-devices-compact-list">
      {devices.map((device) => {
        const isThisDevice = device.deviceId === thisDeviceId
        return (
          <li key={device.deviceId} className="device-sync-devices-compact-row">
            <span className="device-sync-devices-compact-label">
              <span className="device-sync-devices-compact-name">{device.deviceLabel}</span>
              {isThisDevice && <span className="device-sync-devices-current">{t(locale, "deviceSync.thisDeviceBadge")}</span>}
            </span>
            {!isThisDevice && (
              <button
                type="button"
                className="device-sync-devices-compact-revoke"
                onClick={() => onRevoke(device.deviceId)}
                disabled={busy}
                aria-label={`${t(locale, "deviceSync.revoke")} ${device.deviceLabel}`}
              >
                {t(locale, "deviceSync.revoke")}
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
