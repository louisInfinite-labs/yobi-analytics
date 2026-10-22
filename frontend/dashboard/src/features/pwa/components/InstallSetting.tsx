import { useId, useState } from "react"
import { SimpleDialog } from "../../../shared/ui/SimpleDialog"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t } from "../../../shared/i18n/translations"
import { useInstallAvailability } from "../installState"
import { HomeScreenGuide } from "./HomeScreenGuide"

/** The optional "Install OshiYobi" section of Notification Settings: its own section after the push and simultaneous-livestream settings (never nested
 * in either), never a modal on first visit, never a banner, never nagging. It renders nothing -- not even a disabled button -- unless the visitor is on a
 * phone browser outside the installed app: not in the installed (standalone) app, and not on desktop, a tablet or a narrow desktop window. Where the
 * browser provides an install prompt (Chrome/Android) the button triggers it after a tap; on iOS it opens the Add-to-Home-Screen steps with the
 * local-data warning (iOS has no programmatic install); any other phone browser gets the generic browser-menu steps. */
export function InstallSetting() {
  const [locale] = useLocale()
  const { availability, promptInstall } = useInstallAvailability()
  const [guideOpen, setGuideOpen] = useState(false)
  const titleId = useId()

  if (availability === "installed" || availability === "notMobile") return null

  return (
    <section className="notification-detail-section pwa-install-section" aria-labelledby={titleId}>
      <div className="notification-members-heading">
        <div>
          <h3 className="notification-detail-section__title" id={titleId}>
            {t(locale, "pwa.installLabel")}
          </h3>
          <p className="notification-detail-section__description">{t(locale, "pwa.installHelp")}</p>
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
      </div>
      {guideOpen && (
        <SimpleDialog
          title={t(locale, availability === "manual" ? "pwa.iosTitle" : "pwa.menuTitle")}
          onClose={() => setGuideOpen(false)}
          actions={
            <button type="button" className="simple-dialog__button simple-dialog__button--primary" onClick={() => setGuideOpen(false)}>
              {t(locale, "push.close")}
            </button>
          }
        >
          {availability === "manual" ? (
            <HomeScreenGuide locale={locale} />
          ) : (
            <ol>
              <li>{t(locale, "pwa.menuStep1")}</li>
              <li>{t(locale, "pwa.menuStep2")}</li>
            </ol>
          )}
        </SimpleDialog>
      )}
    </section>
  )
}
