import { useState } from "react"
import { SimpleDialog } from "../../../shared/ui/SimpleDialog"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t } from "../../../shared/i18n/translations"
import { HomeScreenGuide } from "../../pwa/components/HomeScreenGuide"

/** iOS/iPadOS, running in ordinary Safari (spec section 10): Add-to-Home-Screen guidance only -- no QR display,
 * no scanner, no automatic Sync Profile creation. Reuses HomeScreenGuide (InstallSetting.tsx's own iOS steps +
 * local-data-separation warning) rather than writing a second copy of the same instructions and the same
 * Safari-vs-installed-storage caveat Device Sync needs just as much as plain installability does. */
export function IosSafariGuidance() {
  const [locale] = useLocale()
  const [guideOpen, setGuideOpen] = useState(false)

  return (
    <div className="device-sync-page device-sync-page--guidance">
      <h3 className="device-sync-section-title">{t(locale, "deviceSync.title")}</h3>
      <p className="device-sync-guidance-message">{t(locale, "deviceSync.installFirstIos")}</p>
      <button type="button" className="device-sync-primary-button" onClick={() => setGuideOpen(true)}>
        {t(locale, "pwa.howButton")}
      </button>
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
