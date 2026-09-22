import { useState } from "react"
import { MyOshiSettings } from "../../features/oshi/components/MyOshiSettings"
import { NotificationSettings } from "../../features/notifications/components/NotificationSettings"
import { OshiSettings } from "../../features/oshi/components/OshiSettings"
import { DisplaySettings } from "./DisplaySettings"
import { SettingsSecondaryNavbar, type SettingsSection } from "./SettingsSecondaryNavbar"

/** Settings' own [MainNavbar] [SettingsSecondaryNavbar] [Content] layout
 * (MainNavbar is mounted one level up, in App.tsx -- this renders the
 * other two). Which section is active is plain local state, not part of
 * the URL, since nothing else needs to deep-link into a specific
 * settings section today -- defaults to OshiSettings per this feature's
 * own spec. */
export function SettingsPage() {
  const [activeSection, setActiveSection] = useState<SettingsSection>("oshi")
  const contentClassName = [
    "settings-page__content",
    activeSection === "myOshi" ? "settings-page__content--main-oshi" : "",
    activeSection === "oshi" ? "settings-page__content--favorites" : "",
    activeSection === "notification" ? "settings-page__content--notification" : "",
    activeSection === "display" ? "settings-page__content--display" : "",
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
