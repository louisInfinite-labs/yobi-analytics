import { useLocale } from "../../hooks/useLocale"
import { t } from "../../i18n/translations"

/** Oshi Settings -- no oshi settings exist yet to configure here; this
 * just gives SettingsSecondaryNavbar's default section somewhere real to
 * render instead of an empty panel until an actual settings UI is
 * designed. */
export function OshiSettings() {
  const [locale] = useLocale()
  return (
    <div className="state-panel">
      <p>{t(locale, "oshiSettings.comingSoon")}</p>
    </div>
  )
}
