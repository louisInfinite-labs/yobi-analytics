import { useState } from "react"
import { SimpleDialog } from "../../../shared/ui/SimpleDialog"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t } from "../../../shared/i18n/translations"
import { useInstallAvailability } from "../installState"
import { HomeScreenGuide } from "./HomeScreenGuide"

/** The optional "Install OshiYobi" row in Display Settings (never a modal on first visit, never a banner, never nagging).
 * Renders nothing unless installing is actually possible: not when already installed (standalone), and not on a browser that
 * offers neither an install prompt nor iOS's Add to Home Screen. Where the browser provides an install prompt (Chrome/Edge/Android)
 * the button triggers it; on iOS/iPadOS Safari it opens the Add-to-Home-Screen steps with the local-data warning. */
export function InstallSetting() {
  const [locale] = useLocale()
  const { availability, promptInstall } = useInstallAvailability()
  const [guideOpen, setGuideOpen] = useState(false)

  if (availability !== "prompt" && availability !== "manual") return null

  return (
    <div className="display-setting-row">
      <div className="display-setting-copy">
        <h2 className="display-setting-label">{t(locale, "pwa.installLabel")}</h2>
        <p className="display-setting-help">{t(locale, "pwa.installHelp")}</p>
      </div>
      {availability === "prompt" ? (
        <button type="button" className="pwa-install-button" onClick={() => void promptInstall()}>
          {t(locale, "pwa.installButton")}
        </button>
      ) : (
        <button type="button" className="pwa-install-button" onClick={() => setGuideOpen(true)}>
          {t(locale, "pwa.howButton")}
        </button>
      )}
      {guideOpen && (
        <SimpleDialog
          title={t(locale, "pwa.iosTitle")}
          onClose={() => setGuideOpen(false)}
          actions={
            <button type="button" className="simple-dialog__button simple-dialog__button--primary" onClick={() => setGuideOpen(false)}>
              {t(locale, "push.close")}
            </button>
          }
        >
          <HomeScreenGuide locale={locale} />
        </SimpleDialog>
      )}
    </div>
  )
}
