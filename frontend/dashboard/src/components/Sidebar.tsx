import type { Page } from "../hooks/useCurrentPage"
import { useCurrentPage } from "../hooks/useCurrentPage"
import { useLocale } from "../hooks/useLocale"
import { t, type TranslationKey } from "../i18n/translations"

const NAV_ITEMS: { page: Page; labelKey: TranslationKey }[] = [
  { page: "home", labelKey: "sidebar.home" },
  { page: "dashboard", labelKey: "sidebar.dashboard" },
  { page: "settings", labelKey: "sidebar.settings" },
]

/** App-wide fixed nav, full viewport height, docked to the left edge --
 * every page's content sits directly to its right (see .app-shell in
 * sidebar.css), so its right edge is always flush with whatever the
 * current page renders as its own leftmost content (e.g. home-scene on
 * the Home page). Not shown on the Admin screen (?admin), which stays an
 * unlinked, full-page debug tool -- see AdminPanel's own docstring. */
export function Sidebar() {
  const [page, setPage] = useCurrentPage()
  const [locale] = useLocale()

  return (
    <nav className="sidebar" aria-label={t(locale, "sidebar.navAriaLabel")}>
      {NAV_ITEMS.map((item) => (
        <button
          key={item.page}
          type="button"
          className={`sidebar__link${page === item.page ? " sidebar__link--active" : ""}`}
          onClick={() => setPage(item.page)}
        >
          {t(locale, item.labelKey)}
        </button>
      ))}
    </nav>
  )
}
