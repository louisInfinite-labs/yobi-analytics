import { useLocale } from "../../shared/i18n/hooks/useLocale"
import { t, type TranslationKey } from "../../shared/i18n/translations"
import { LanguagePicker } from "../../shared/i18n/components/LanguagePicker"

export type SettingsSection = "myOshi" | "oshi" | "notification"

/** Fixed order -- confirmed with the user: 我推設定 (myOshi, a new blank
 * placeholder section -- see MyOshiSettings.tsx) now leads, followed by the
 * pre-existing Favorites List (oshi, this feature's own original "oshi"
 * section id -- kept as-is since nothing besides its own display label
 * changed) and Notification Settings. Language switching isn't a nav
 * section/page of its own -- LanguagePicker below is pinned to this
 * navbar's own bottom instead, always visible regardless of which section
 * is active. */
const NAV_ITEMS: { section: SettingsSection; labelKey: TranslationKey }[] = [
  { section: "myOshi", labelKey: "settingsSecondaryNavbar.myOshiSettings" },
  { section: "oshi", labelKey: "settingsSecondaryNavbar.oshiSettings" },
  { section: "notification", labelKey: "settingsSecondaryNavbar.notificationSettings" },
]

/** Settings' own secondary nav, to MainNavbar's right -- Mantine's
 * "Secondary Navbar" naming (ui.mantine.dev/category/navbars), styled as
 * an inset rounded-pill NavLink list (Mantine's own default NavLink look)
 * rather than MainNavbar's edge-to-edge active style, since this panel is
 * a nested, page-local nav rather than the app-wide shell. Exactly one
 * item is active at a time; selecting one swaps SettingsPage's content
 * area, it doesn't navigate anywhere on its own. */
export function SettingsSecondaryNavbar({
  activeSection,
  onSelect,
}: {
  activeSection: SettingsSection
  onSelect: (section: SettingsSection) => void
}) {
  const [locale] = useLocale()

  return (
    <nav className="settings-secondary-navbar" aria-label={t(locale, "settingsSecondaryNavbar.navAriaLabel")}>
      <div className="settings-secondary-navbar__title">{t(locale, "settingsSecondaryNavbar.title")}</div>
      {NAV_ITEMS.map((item) => (
        <button
          key={item.section}
          type="button"
          className={`settings-secondary-navbar__link${
            activeSection === item.section ? " settings-secondary-navbar__link--active" : ""
          }`}
          onClick={() => onSelect(item.section)}
          aria-current={activeSection === item.section ? "page" : undefined}
        >
          {t(locale, item.labelKey)}
        </button>
      ))}
      <LanguagePicker />
    </nav>
  )
}
