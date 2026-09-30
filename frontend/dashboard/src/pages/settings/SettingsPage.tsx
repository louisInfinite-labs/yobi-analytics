import { MyOshiSettings } from "../../features/oshi/components/MyOshiSettings"
import { NotificationSettings } from "../../features/notifications/components/NotificationSettings"
import { OshiSettings } from "../../features/oshi/components/OshiSettings"
import { DisplaySettings } from "./DisplaySettings"
import { SettingsSecondaryNavbar } from "./SettingsSecondaryNavbar"
import { useSettingsSection } from "./useSettingsSection"

/** Settings' own [MainNavbar] [SettingsSecondaryNavbar] [Content] layout
 * (MainNavbar is mounted one level up, in App.tsx -- this renders the
 * other two). Which section is active lives in this page's own URL (see
 * useSettingsSection.ts), not plain local state, so it survives a full
 * reload -- defaults to OshiSettings per this feature's own spec whenever
 * no section is addressed yet. */
export function SettingsPage() {
  const [activeSection, setActiveSection] = useSettingsSection()
  const contentClassName = [
    "settings-page__content",
    activeSection === "myOshi" ? "settings-page__content--main-oshi" : "",
    activeSection === "oshi" ? "settings-page__content--favorites" : "",
    activeSection === "notification" ? "settings-page__content--notification" : "",
  ]
    .filter(Boolean)
    .join(" ")

  return (
    <div className="settings-page">
      <SettingsSecondaryNavbar activeSection={activeSection} onSelect={setActiveSection} />
      <div className={contentClassName}>
        {activeSection === "myOshi" && <MyOshiSettings />}
        {activeSection === "oshi" && <OshiSettings />}
        {activeSection === "notification" && <NotificationSettings />}
        {activeSection === "display" && <DisplaySettings />}
      </div>
    </div>
  )
}
