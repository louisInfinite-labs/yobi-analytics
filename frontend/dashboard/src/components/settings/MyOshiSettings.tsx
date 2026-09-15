import { useLocale } from "../../hooks/useLocale"
import { t } from "../../i18n/translations"

/** Blank placeholder for the new "我推設定" settings section -- confirmed
 * with the user: build an empty page first, real content (single-Oshi
 * selection and/or image transform controls -- see useOshiTransform.ts /
 * OshiSwitchConfirmDialog.tsx for the app's existing single-Oshi concept
 * this section is expected to eventually manage) comes in a later task. */
export function MyOshiSettings() {
  const [locale] = useLocale()
  return (
    <div className="my-oshi-settings">
      <p className="my-oshi-settings__placeholder">{t(locale, "myOshiSettings.placeholder")}</p>
    </div>
  )
}
