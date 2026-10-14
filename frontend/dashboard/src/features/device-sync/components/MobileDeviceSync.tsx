import { useState } from "react"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t } from "../../../shared/i18n/translations"
import type { DeviceSyncPlatform } from "../platformDetection"
import { defaultDeviceLabel, deviceTypeForPlatform } from "../model/syncDevice"
import { getThisDeviceId } from "../api/deviceSyncApi"
import { useDeviceSyncController } from "../useDeviceSyncController"
import { PairingCodeInput } from "./PairingCodeInput"
import { QrCodeScanner } from "./QrCodeScanner"
import { ConnectedDevicesCompactList } from "./ConnectedDevicesCompactList"

/** Installed-PWA Device Sync (Android or iOS -- spec sections 9/11/13): scan QR / enter code are the PRIMARY
 * actions (never a QR-display-first flow -- a PC may have no camera, so this component never renders
 * QrCodeDisplay at all). "Generate a code for PC" only appears once this device already belongs to a profile,
 * for the reverse pairing direction (spec section 13). A fresh, unpaired PWA instead shows the onboarding prompt
 * (spec section 19) ahead of the scan/enter actions, so recovering an existing profile is the first thing offered. */
export function MobileDeviceSync({ platform }: { platform: DeviceSyncPlatform }) {
  const [locale] = useLocale()
  const { profileId, devices, busy, createSession, consume, revoke } = useDeviceSyncController()
  const [generatedCode, setGeneratedCode] = useState<string | null>(null)
  const thisDeviceId = getThisDeviceId()
  const deviceType = deviceTypeForPlatform(platform)
  const deviceLabel = defaultDeviceLabel(platform)

  async function handleDecoded(token: string) {
    await consume({ token }, deviceLabel, deviceType)
  }

  async function handleEnterCode(code: string) {
    await consume({ code }, deviceLabel, deviceType)
  }

  async function handleGenerateCode() {
    const session = await createSession()
    if (session) setGeneratedCode(session.humanCode)
  }

  return (
    <div className="device-sync-page device-sync-page--mobile">
      {!profileId && (
        <section className="device-sync-section device-sync-onboarding">
          <h3 className="device-sync-section-title">{t(locale, "deviceSync.onboardingTitle")}</h3>
          <p className="device-sync-onboarding-hint">{t(locale, "deviceSync.onboardingHint")}</p>
        </section>
      )}

      <section className="device-sync-section">
        <QrCodeScanner onDecoded={(value) => void handleDecoded(value)} />
      </section>

      <section className="device-sync-section">
        <PairingCodeInput onSubmit={(code) => void handleEnterCode(code)} pending={busy} />
      </section>

      {profileId && (
        <section className="device-sync-section">
          <h3 className="device-sync-section-title">{t(locale, "deviceSync.connectAnother")}</h3>
          {generatedCode ? (
            <p className="device-sync-human-code">{generatedCode}</p>
          ) : (
            <button type="button" className="device-sync-primary-button" onClick={() => void handleGenerateCode()} disabled={busy}>
              {t(locale, "deviceSync.generateCode")}
            </button>
          )}
        </section>
      )}

      <section className="device-sync-section">
        <h3 className="device-sync-section-title">{t(locale, "deviceSync.connectedDevices")}</h3>
        <ConnectedDevicesCompactList devices={devices} thisDeviceId={thisDeviceId} onRevoke={(id) => void revoke(id)} busy={busy} />
      </section>
    </div>
  )
}
