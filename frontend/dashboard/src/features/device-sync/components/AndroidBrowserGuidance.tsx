import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t } from "../../../shared/i18n/translations"
import { useInstallAvailability } from "../../pwa/installState"

/** Android, running in an ordinary (not-installed) browser tab (spec section 8): install guidance only -- no QR
 * display, no scanner, no automatic pairing. Reuses installState.ts's own useInstallAvailability exactly the way
 * InstallSetting.tsx (Display Settings) already does, so "can this browser show a native install prompt" is
 * answered once, the same way, everywhere in the app. */
export function AndroidBrowserGuidance() {
  const [locale] = useLocale()
  const { availability, promptInstall } = useInstallAvailability()

  return (
    <div className="device-sync-page device-sync-page--guidance">
      <h3 className="device-sync-section-title">{t(locale, "deviceSync.title")}</h3>
      <p className="device-sync-guidance-message">{t(locale, "deviceSync.installFirstAndroid")}</p>
      {availability === "prompt" && (
        <button type="button" className="device-sync-primary-button" onClick={() => void promptInstall()}>
          {t(locale, "pwa.installButton")}
        </button>
      )}
    </div>
  )
}
