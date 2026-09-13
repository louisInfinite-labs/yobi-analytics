import { ChevronDown } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useLocale } from "../../hooks/useLocale"
import { t, type Locale, type TranslationKey } from "../../i18n/translations"

const LANGUAGE_DATA: { locale: Locale; flag: string; labelKey: TranslationKey }[] = [
  { locale: "zh-TW", flag: "🇭🇰", labelKey: "languageSettings.picker.zhTW" },
  { locale: "en", flag: "🇬🇧", labelKey: "languageSettings.picker.en" },
  { locale: "ja", flag: "🇯🇵", labelKey: "languageSettings.picker.ja" },
]

/** Language Settings -- ported pixel-for-pixel from Mantine UI's own
 * "Language picker" demo (ui.mantine.dev/component/language-picker,
 * LanguagePicker.tsx/.module.css): a pill control (flag + label +
 * chevron) opening a dropdown menu, sizes/colors/spacing measured from
 * that demo's own dark-mode rendering, same as MainNavbar/
 * SettingsSecondaryNavbar. The only things this app supplies itself are
 * the three languages' own flags/labels (Hong Kong/UK/Japan flags for
 * Traditional Chinese/English/Japanese, per this feature's own spec) and
 * wiring selection to useLocale -- Mantine's own demo has no such
 * app-wide effect, it's just local component state there. */
export function LanguageSettings() {
  const [locale, setLocale] = useLocale()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handlePointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", handlePointerDown)
    document.addEventListener("keydown", handleKeyDown)
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown)
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [open])

  const selected = LANGUAGE_DATA.find((item) => item.locale === locale) ?? LANGUAGE_DATA[0]

  return (
    <div className="language-picker" ref={rootRef}>
      <button
        type="button"
        className="language-picker__control"
        data-expanded={open || undefined}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="language-picker__control-content">
          <span className="language-picker__flag" aria-hidden="true">
            {selected.flag}
          </span>
          <span className="language-picker__label">{t(locale, selected.labelKey)}</span>
        </span>
        <ChevronDown size={16} strokeWidth={1.5} className="language-picker__icon" aria-hidden="true" />
      </button>
      {open && (
        <div className="language-picker__dropdown" role="menu">
          {LANGUAGE_DATA.map((item) => (
            <button
              key={item.locale}
              type="button"
              role="menuitem"
              className="language-picker__item"
              onClick={() => {
                setLocale(item.locale)
                setOpen(false)
              }}
            >
              <span className="language-picker__flag" aria-hidden="true">
                {item.flag}
              </span>
              <span>{t(locale, item.labelKey)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
