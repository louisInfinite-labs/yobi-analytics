import { useState } from "react"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t } from "../../../shared/i18n/translations"
import { defaultDeviceLabel, deviceTypeForPlatform } from "../model/syncDevice"
import { getThisDeviceId } from "../api/deviceSyncApi"
import { useDeviceSyncController } from "../useDeviceSyncController"
import { PairingCodeInput } from "./PairingCodeInput"
import { QrCodeDisplay } from "./QrCodeDisplay"
import { ConnectedDevicesList } from "./ConnectedDevicesList"

/** Desktop's own full Device Sync page (spec section 4): current-device status, a QR + pairing code to connect a
 * phone, an enter-code form for the reverse direction (an existing profile that lives on mobile), and the
 * connected-devices list laid out for a wide viewport. PC is ALWAYS this page regardless of install state (see
 * platformDetection.ts) -- never the mobile scan-first UI, since a desktop may have no camera. */
export function PcDeviceSync() {
  const [locale] = useLocale()
  const { profileId, devices, busy, createSession, consume, revoke } = useDeviceSyncController()
  const [session, setSession] = useState<{ token: string; humanCode: string } | null>(null)
  const thisDeviceId = getThisDeviceId()

  async function handleConnectAnother() {
    const result = await createSession()
    if (result) setSession({ token: result.token, humanCode: result.humanCode })
  }

  async function handleEnterCode(code: string) {
    const ok = await consume({ code }, defaultDeviceLabel("pc"), deviceTypeForPlatform("pc"))
    if (ok) setSession(null)
  }

  return (
    <div className="device-sync-page device-sync-page--pc">
      <section className="device-sync-section">
        <h3 className="device-sync-section-title">{t(locale, "deviceSync.thisDevice")}</h3>
        <p className="device-sync-this-device">
          {defaultDeviceLabel("pc")}
          {" — "}
          {profileId ? t(locale, "deviceSync.statusSynced") : t(locale, "deviceSync.statusSolo")}
        </p>
      </section>

      <section className="device-sync-section">
        <h3 className="device-sync-section-title">{t(locale, "deviceSync.connectAnother")}</h3>
        {session ? (
          <div className="device-sync-pairing-panel">
            <QrCodeDisplay value={session.token} />
            <p className="device-sync-human-code">{session.humanCode}</p>
            <button type="button" className="device-sync-secondary-button" onClick={() => void handleConnectAnother()} disabled={busy}>
              {t(locale, "deviceSync.regenerate")}
            </button>
          </div>
        ) : (
          <button type="button" className="device-sync-primary-button" onClick={() => void handleConnectAnother()} disabled={busy}>
            {t(locale, "deviceSync.showQr")}
          </button>
        )}
      </section>

      <section className="device-sync-section">
        <h3 className="device-sync-section-title">{t(locale, "deviceSync.joinExisting")}</h3>
        <PairingCodeInput onSubmit={(code) => void handleEnterCode(code)} pending={busy} />
      </section>

      <section className="device-sync-section">
        <h3 className="device-sync-section-title">{t(locale, "deviceSync.connectedDevices")}</h3>
        <ConnectedDevicesList devices={devices} thisDeviceId={thisDeviceId} onRevoke={(id) => void revoke(id)} busy={busy} />
      </section>
    </div>
  )
}
