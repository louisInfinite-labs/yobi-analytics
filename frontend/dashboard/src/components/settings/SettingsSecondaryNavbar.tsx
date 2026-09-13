import { useLocale } from "../../hooks/useLocale"
import { t, type TranslationKey } from "../../i18n/translations"

export type SettingsSection = "oshi" | "notification" | "language"

/** Fixed order per this feature's own spec -- Oshi Settings, Notification
 * Settings, Language Settings -- not to be reordered. */
const NAV_ITEMS: { section: SettingsSection; labelKey: TranslationKey }[] = [
  { section: "oshi", labelKey: "settingsSecondaryNavbar.oshiSettings" },
  { section: "notification", labelKey: "settingsSecondaryNavbar.notificationSettings" },
  { section: "language", labelKey: "settingsSecondaryNavbar.languageSettings" },
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
        >
          {t(locale, item.labelKey)}
        </button>
      ))}
    </nav>
  )
}
