import { CalendarClock, Gauge, Home, Settings } from "lucide-react"
import type { ComponentType } from "react"
import brandIcon from "../../assets/brand-icon.png"
import type { Page } from "./useCurrentPage"
import { useCurrentPage } from "./useCurrentPage"
import { useLocale } from "../../shared/i18n/hooks/useLocale"
import { t, type TranslationKey } from "../../shared/i18n/translations"

const NAV_ITEMS: { page: Page; labelKey: TranslationKey; Icon: ComponentType<{ size?: number; strokeWidth?: number }> }[] = [
  { page: "home", labelKey: "mainNavbar.home", Icon: Home },
  { page: "schedule", labelKey: "mainNavbar.schedule", Icon: CalendarClock },
  { page: "dashboard", labelKey: "mainNavbar.dashboard", Icon: Gauge },
  { page: "settings", labelKey: "mainNavbar.settings", Icon: Settings },
]

/** App-wide fixed nav (Mantine's "Main Navbar" naming -- see
 * ui.mantine.dev/category/navbars -- not "Sidebar"), originally ported
 * pixel-for-pixel from that page's own "Navbar with 2 sections" demo
 * (DoubleNavbar.tsx/.module.css) as a 60px icon-only rail with a hover
 * tooltip carrying each label. Now a 160px rail with the label always
 * visible instead (160px was sized against the longest known nav label
 * across every locale, "Video Data"/"動画データ"), so the tooltip that
 * used to carry that same text is gone rather than showing it twice. The
 * only two things swapped for our own branding are the icon
 * in the top logo slot (this app's cat mark instead of Mantine's own logo)
 * and the document <title> (index.html's own "OshiYobi", not anything
 * rendered here -- "Section Title" from this feature's spec turned out to
 * mean the browser tab title, not on-screen navbar text).
 *
 * Full viewport height, docked to the left edge -- every page's content
 * sits directly to its right (see .app-shell in main-navbar.css), so its
 * right edge is always flush with whatever the current page renders as
 * its own leftmost content (e.g. home-scene on the Home page). Not shown
 * on the Admin screen (?admin), which stays an unlinked, full-page debug
 * tool -- see AdminPanel's own docstring. */
export function MainNavbar() {
  const [page, setPage] = useCurrentPage()
  const [locale] = useLocale()

  return (
    <nav className="main-navbar" aria-label={t(locale, "mainNavbar.navAriaLabel")}>
      <div className="main-navbar__logo">
        <img className="main-navbar__logo-icon" src={brandIcon} alt="OshiYobi" />
      </div>
      {NAV_ITEMS.map((item) => {
        const label = t(locale, item.labelKey)
        return (
          <button
            key={item.page}
            type="button"
            className={`main-navbar__link${page === item.page ? " main-navbar__link--active" : ""}`}
            onClick={() => setPage(item.page)}
            aria-label={label}
          >
            <item.Icon size={22} strokeWidth={1.5} />
            <span className="main-navbar__label">{label}</span>
          </button>
        )
      })}
    </nav>
  )
}
