import { useLocale } from "../../hooks/useLocale"
import { t } from "../../i18n/translations"

/** Language Settings -- no language settings exist yet to configure here
 * (locale today only auto-detects from the browser, see useLocale's own
 * docstring); this just gives SettingsSecondaryNavbar's third section
 * somewhere real to render instead of an empty panel until an actual
 * settings UI is designed. */
export function LanguageSettings() {
  const [locale] = useLocale()
  return (
    <div className="state-panel">
      <p>{t(locale, "languageSettings.comingSoon")}</p>
    </div>
  )
}
