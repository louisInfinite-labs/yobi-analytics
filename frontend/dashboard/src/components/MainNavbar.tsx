import brandIcon from "../assets/brand-icon.png"
import type { Page } from "../hooks/useCurrentPage"
import { useCurrentPage } from "../hooks/useCurrentPage"
import { useLocale } from "../hooks/useLocale"
import { t, type TranslationKey } from "../i18n/translations"

const NAV_ITEMS: { page: Page; labelKey: TranslationKey }[] = [
  { page: "home", labelKey: "mainNavbar.home" },
  { page: "dashboard", labelKey: "mainNavbar.dashboard" },
  { page: "settings", labelKey: "mainNavbar.settings" },
]

/** App-wide fixed nav (Mantine's "Main Navbar" naming -- see
 * ui.mantine.dev/category/navbars -- not "Sidebar"), full viewport
 * height, docked to the left edge -- every page's content sits directly
 * to its right (see .app-shell in main-navbar.css), so its right edge is
 * always flush with whatever the current page renders as its own
 * leftmost content (e.g. home-scene on the Home page). Not shown on the
 * Admin screen (?admin), which stays an unlinked, full-page debug tool --
 * see AdminPanel's own docstring. */
export function MainNavbar() {
  const [page, setPage] = useCurrentPage()
  const [locale] = useLocale()

  return (
    <nav className="main-navbar" aria-label={t(locale, "mainNavbar.navAriaLabel")}>
      <div className="main-navbar__brand">
        <img className="main-navbar__brand-icon" src={brandIcon} alt="" aria-hidden="true" />
        <span className="main-navbar__brand-name">OshiYobi</span>
      </div>
      {NAV_ITEMS.map((item) => (
        <button
          key={item.page}
          type="button"
          className={`main-navbar__link${page === item.page ? " main-navbar__link--active" : ""}`}
          onClick={() => setPage(item.page)}
        >
          {t(locale, item.labelKey)}
        </button>
      ))}
    </nav>
  )
}
