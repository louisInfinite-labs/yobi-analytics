import { t, type Locale } from "../../../shared/i18n/translations"

/** iOS/iPadOS "Add to Home Screen" steps plus the local-data warning. The warning belongs with the guidance (not after it): the
 * Home Screen web app may not share the Safari tab's local storage, so My Oshi / Favorites / display settings may not be there.
 * Safari's own data is never touched and no migration is promised. */
export function HomeScreenGuide({ locale }: { locale: Locale }) {
  return (
    <>
      <ol>
        <li>{t(locale, "pwa.iosStep1")}</li>
        <li>{t(locale, "pwa.iosStep2")}</li>
        <li>{t(locale, "pwa.iosStep3")}</li>
      </ol>
      <div className="simple-dialog__note" role="note">
        <p className="simple-dialog__note-title">{t(locale, "pwa.dataWarningTitle")}</p>
        <p>{t(locale, "pwa.dataWarningBody")}</p>
      </div>
    </>
  )
}
