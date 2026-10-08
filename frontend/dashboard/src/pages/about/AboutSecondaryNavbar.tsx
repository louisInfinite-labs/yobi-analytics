import { useLocale } from "../../shared/i18n/hooks/useLocale"
import { t } from "../../shared/i18n/translations"
import type { AboutPage } from "./api/aboutContentApi"

/** About's own secondary nav -- structurally identical to
 * SettingsSecondaryNavbar.tsx (same settings-secondary-navbar* CSS classes,
 * same single-active-item button list), reused rather than a new,
 * independent About-specific navigation system. Labels/order come from the
 * backend's own `pages` array (aboutContentApi.ts) -- this component is not
 * a second source of truth for page titles or ordering. No LanguagePicker
 * here: that control is Settings' own, not a general app-chrome fixture. */
export function AboutSecondaryNavbar({
  pages,
  activeSection,
  onSelect,
}: {
  pages: AboutPage[]
  activeSection: string
  onSelect: (section: string) => void
}) {
  const [locale] = useLocale()

  return (
    <nav className="settings-secondary-navbar" aria-label={t(locale, "aboutSecondaryNavbar.navAriaLabel")}>
      <div className="settings-secondary-navbar__title">{t(locale, "aboutSecondaryNavbar.title")}</div>
      {pages.map((page) => (
        <button
          key={page.id}
          type="button"
          className={`settings-secondary-navbar__link${
            activeSection === page.id ? " settings-secondary-navbar__link--active" : ""
          }`}
          onClick={() => onSelect(page.id)}
          aria-current={activeSection === page.id ? "page" : undefined}
        >
          {page.title}
        </button>
      ))}
    </nav>
  )
}
