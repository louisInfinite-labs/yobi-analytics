import { CalendarClock, Gauge, Home, Info, Menu, Settings, Video, X } from "lucide-react"
import { useRef, useState, type ComponentType, type RefObject } from "react"
import brandIcon from "../../assets/brand-icon.png"
import type { Page } from "./useCurrentPage"
import { useCurrentPage } from "./useCurrentPage"
import { useBreakpoint } from "../../shared/hooks/useBreakpoint"
import { useModalFocus } from "../../shared/hooks/useModalFocus"
import { useLocale } from "../../shared/i18n/hooks/useLocale"
import { t, type TranslationKey } from "../../shared/i18n/translations"

const NAV_ITEMS: { page: Page; labelKey: TranslationKey; Icon: ComponentType<{ size?: number; strokeWidth?: number }> }[] = [
  { page: "home", labelKey: "mainNavbar.home", Icon: Home },
  { page: "videos", labelKey: "mainNavbar.videos", Icon: Video },
  { page: "schedule", labelKey: "mainNavbar.schedule", Icon: CalendarClock },
  { page: "dashboard", labelKey: "mainNavbar.dashboard", Icon: Gauge },
  { page: "settings", labelKey: "mainNavbar.settings", Icon: Settings },
  { page: "about", labelKey: "mainNavbar.about", Icon: Info },
]

/** The Video Data page (影片數據) is development-only: a production build has no nav entry for it (and no route -- see useCurrentPage / App).
 * `import.meta.env.DEV` is the project's own dev-only gate (the same one Home's dev controls use); it is replaced at build time, and the
 * entry is not rendered, rather than hidden with CSS.
 *
 * "videos" (the mobile-only Videos/Search view) is gated to the phone breakpoint for the same reason: desktop already has its own Video
 * List + Search on Home (RecentVideosSection) and keeps its current information architecture unchanged (spec), so a desktop user has no
 * use for a second, separate Videos destination in this nav -- it would just be dead weight next to the equivalent desktop feature. */
function visibleNavItems(breakpoint: ReturnType<typeof useBreakpoint>) {
  return NAV_ITEMS.filter((item) => {
    if (item.page === "dashboard") return import.meta.env.DEV
    if (item.page === "videos") return breakpoint === "mobile"
    return true
  })
}

/** How far left (px) a touch must travel inside the open drawer to count as a close swipe. */
const SWIPE_CLOSE_DISTANCE_PX = 50

/** While the phone navigation drawer is open: focus moves into it, Tab stays inside, Escape closes it, and focus returns to the
 * hamburger -- the shared modal-focus behavior. Mounted only while open, so the hook is active exactly then. */
function NavDrawerFocusScope({ drawerRef, onClose }: { drawerRef: RefObject<HTMLElement | null>; onClose: () => void }) {
  useModalFocus(drawerRef, onClose)
  return null
}

/** App-wide navigation, in three responsive shapes decided by CSS alone (main-navbar.css), from ONE markup:
 *  - from 1440px: the full 160px left sidebar (icon + label);
 *  - 768-1439px (tablet / notebook): a 56px icon-only left rail (labels hidden; each link keeps its aria-label);
 *  - below 768px (phone, the same breakpoint useBreakpoint calls "mobile"): NO persistent rail. A full-width top bar (hamburger at
 *    the left) is the first row of the page, and the hamburger opens this same <nav> as a left overlay drawer with the icons AND
 *    labels. The drawer overlays the page (it never pushes or reflows it) and closes by backdrop, its close button, Escape, picking a
 *    page, or a swipe-left inside it. There is deliberately no left-edge swipe opener (iOS back gesture) and never a bottom navigation.
 *
 * Originally ported pixel-for-pixel from Mantine UI's "Navbar with 2 sections" demo (ui.mantine.dev/category/navbars, DoubleNavbar) as
 * a 60px icon-only rail; the cat mark in the logo slot and the document <title> ("OshiYobi", index.html) are the only things swapped
 * for this app's own branding. Full viewport height, docked to the left edge -- every page's content sits directly to its right (see
 * .app-shell__content in main-navbar.css). Not shown on the Admin screen (?admin), which stays an unlinked, full-page debug tool --
 * see AdminPanel's own docstring. */
export function MainNavbar() {
  const [page, setPage] = useCurrentPage()
  const [locale] = useLocale()
  const breakpoint = useBreakpoint()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const drawerRef = useRef<HTMLElement | null>(null)
  const swipeStart = useRef<{ x: number; y: number } | null>(null)
  const closeDrawer = () => setDrawerOpen(false)

  return (
    <>
      <header className="main-topbar">
        <button
          type="button"
          className="main-topbar__menu"
          onClick={() => setDrawerOpen(true)}
          aria-label={t(locale, "mainNavbar.openNavAriaLabel")}
          aria-expanded={drawerOpen}
          aria-controls="main-navbar"
        >
          <Menu size={24} aria-hidden="true" />
        </button>
        {/* An empty slot the current page may portal its own phone-only top-row action into (e.g. Home's
            Search entry, Videos' Search input + Filter trigger -- see TopbarSlotPortal) -- MainNavbar
            itself never imports or knows about any of that; it only renders this fixed anchor point,
            which is what keeps it page-agnostic (see this component's own docstring). Empty and inert
            on every page that portals nothing into it. */}
        <div id="main-topbar-slot" className="main-topbar__slot" />
      </header>
      {drawerOpen && <NavDrawerFocusScope drawerRef={drawerRef} onClose={closeDrawer} />}
      {drawerOpen && <div className="main-navbar-backdrop" onClick={closeDrawer} aria-hidden="true" />}
      <nav
        ref={drawerRef}
        id="main-navbar"
        className={`main-navbar${drawerOpen ? " main-navbar--open" : ""}`}
        aria-label={t(locale, "mainNavbar.navAriaLabel")}
        onTouchStart={(event) => {
          const touch = event.touches[0]
          swipeStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null
        }}
        onTouchEnd={(event) => {
          const start = swipeStart.current
          swipeStart.current = null
          const touch = event.changedTouches[0]
          if (!drawerOpen || !start || !touch) return
          const dx = touch.clientX - start.x
          const dy = touch.clientY - start.y
          if (dx <= -SWIPE_CLOSE_DISTANCE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) closeDrawer()
        }}
      >
        <div className="main-navbar__logo">
          <img className="main-navbar__logo-icon" src={brandIcon} alt="OshiYobi" />
          <button type="button" className="main-navbar__close" onClick={closeDrawer} aria-label={t(locale, "mainNavbar.closeNavAriaLabel")}>
            <X size={22} aria-hidden="true" />
          </button>
        </div>
        {visibleNavItems(breakpoint).map((item) => {
          const label = t(locale, item.labelKey)
          return (
            <button
              key={item.page}
              type="button"
              className={`main-navbar__link${page === item.page ? " main-navbar__link--active" : ""}`}
              onClick={() => {
                setPage(item.page)
                closeDrawer()
              }}
              aria-label={label}
            >
              <item.Icon size={22} strokeWidth={1.5} />
              <span className="main-navbar__label">{label}</span>
            </button>
          )
        })}
      </nav>
    </>
  )
}
