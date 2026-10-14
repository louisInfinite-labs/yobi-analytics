import { lazy, Suspense, useRef, useState } from "react"
import { Menu } from "lucide-react"
import { MyOshiSettings } from "../../features/oshi/components/MyOshiSettings"
import { NotificationSettings } from "../../features/notifications/components/NotificationSettings"
import { OshiSettings } from "../../features/oshi/components/OshiSettings"
import { useModalFocus } from "../../shared/hooks/useModalFocus"
import { useLocale } from "../../shared/i18n/hooks/useLocale"
import { t } from "../../shared/i18n/translations"
import { DisplaySettings } from "./DisplaySettings"
import { visibleNavItems, type SettingsSection } from "./settingsSections"
import { SettingsSecondaryNavbar } from "./SettingsSecondaryNavbar"
import { useSettingsSection } from "./useSettingsSection"

/** Device Sync is dev-only (backend/infra rollout isn't approved yet): the same
 * `import.meta.env.DEV`-gated `lazy()`-or-`null` pattern App.tsx uses for the
 * Video Data page, so a production build never bundles or mounts this module. */
const DeviceSyncSettings = import.meta.env.DEV
  ? lazy(() => import("../../features/device-sync/components/DeviceSyncSettings").then((module) => ({ default: module.DeviceSyncSettings })))
  : null

/** While the Settings menu drawer is open (below 1440px): focus moves into it, Tab stays inside, Escape closes it, and focus returns to
 * the opener -- the shared modal-focus behavior. Mounted only while open, so the hook is active exactly then. */
function SettingsMenuFocusScope({ drawerRef, onClose }: { drawerRef: React.RefObject<HTMLElement | null>; onClose: () => void }) {
  useModalFocus(drawerRef, onClose)
  return null
}

/** Settings' own layout. From 1440px: [MainNavbar 160px] [SettingsSecondaryNavbar, persistent] [Content]. Below 1440px: [56px MainNavbar rail]
 * [Content], and the Settings navigation is a full-height LEFT overlay drawer opened from the menu button above the content (it overlays
 * the rail and the content and never pushes or reflows them). It closes by backdrop, its close button, Escape, picking a section, or a
 * swipe-left inside it; there is no edge-swipe opener. Which layout shows is decided by CSS alone (settings.css), so the same markup
 * serves both. (MainNavbar is mounted one level up, in App.tsx.) Which section is active lives in this page's own URL (see
 * useSettingsSection.ts), not plain local state, so it survives a full reload -- defaults to OshiSettings per this feature's own spec
 * whenever no section is addressed yet. */
export function SettingsPage() {
  const [locale] = useLocale()
  const [activeSection, setActiveSection] = useSettingsSection()
  const [menuOpen, setMenuOpen] = useState(false)
  const drawerRef = useRef<HTMLElement | null>(null)
  const contentClassName = [
    "settings-page__content",
    activeSection === "myOshi" ? "settings-page__content--main-oshi" : "",
    activeSection === "oshi" ? "settings-page__content--favorites" : "",
    activeSection === "notification" ? "settings-page__content--notification" : "",
  ]
    .filter(Boolean)
    .join(" ")

  const closeMenu = () => setMenuOpen(false)
  const selectSection = (section: SettingsSection) => {
    setActiveSection(section)
    closeMenu()
  }
  const activeLabelKey = visibleNavItems().find((item) => item.section === activeSection)?.labelKey

  return (
    <div className="settings-page">
      {menuOpen && <SettingsMenuFocusScope drawerRef={drawerRef} onClose={closeMenu} />}
      {menuOpen && <div className="settings-drawer-backdrop" onClick={closeMenu} aria-hidden="true" />}
      <SettingsSecondaryNavbar ref={drawerRef} activeSection={activeSection} onSelect={selectSection} open={menuOpen} onClose={closeMenu} />
      <div className={contentClassName}>
        <div className="settings-page__menu-bar">
          <button
            type="button"
            className="settings-page__menu-button"
            onClick={() => setMenuOpen(true)}
            aria-label={t(locale, "settingsSecondaryNavbar.openMenuAriaLabel")}
            aria-expanded={menuOpen}
            aria-controls="settings-secondary-navbar"
          >
            <Menu size={20} aria-hidden="true" />
            {activeLabelKey && <span>{t(locale, activeLabelKey)}</span>}
          </button>
        </div>
        {activeSection === "myOshi" && <MyOshiSettings />}
        {activeSection === "oshi" && <OshiSettings />}
        {activeSection === "notification" && <NotificationSettings />}
        {activeSection === "display" && <DisplaySettings />}
        {activeSection === "deviceSync" && DeviceSyncSettings && (
          <Suspense fallback={null}>
            <DeviceSyncSettings />
          </Suspense>
        )}
      </div>
    </div>
  )
}
