import { useRef, type Ref } from "react"
import { X } from "lucide-react"
import { useLocale } from "../../shared/i18n/hooks/useLocale"
import { t } from "../../shared/i18n/translations"
import { NAV_ITEMS, type SettingsSection } from "./settingsSections"

export type { SettingsSection }

/** How far left (px) a touch must travel inside the open drawer to count as a close swipe. */
const SWIPE_CLOSE_DISTANCE_PX = 50

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
  open,
  onClose,
  ref,
}: {
  activeSection: SettingsSection
  onSelect: (section: SettingsSection) => void
  /** Below 1440px this navigation is a left overlay drawer and `open` is whether it is showing; from 1440px it is the persistent
   * second sidebar and both props are ignored by the layout (CSS decides -- see settings.css). */
  open: boolean
  onClose: () => void
  /** The drawer element, for the page's modal-focus handling. */
  ref?: Ref<HTMLElement>
}) {
  const [locale] = useLocale()
  // Swipe-left inside the open drawer closes it. Deliberately NO swipe-right-from-the-edge opener: that gesture belongs to the
  // browser's own back navigation on iOS.
  const swipeStart = useRef<{ x: number; y: number } | null>(null)

  return (
    <nav
      ref={ref}
      className={`settings-secondary-navbar${open ? " settings-secondary-navbar--open" : ""}`}
      aria-label={t(locale, "settingsSecondaryNavbar.navAriaLabel")}
      id="settings-secondary-navbar"
      onTouchStart={(event) => {
        const touch = event.touches[0]
        swipeStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null
      }}
      onTouchEnd={(event) => {
        const start = swipeStart.current
        swipeStart.current = null
        const touch = event.changedTouches[0]
        if (!open || !start || !touch) return
        const dx = touch.clientX - start.x
        const dy = touch.clientY - start.y
        if (dx <= -SWIPE_CLOSE_DISTANCE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) onClose()
      }}
    >
      <div className="settings-secondary-navbar__title">
        <span>{t(locale, "settingsSecondaryNavbar.title")}</span>
        <button type="button" className="settings-secondary-navbar__close" onClick={onClose} aria-label={t(locale, "settingsSecondaryNavbar.closeMenuAriaLabel")}>
          <X size={20} aria-hidden="true" />
        </button>
      </div>
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
    </nav>
  )
}
