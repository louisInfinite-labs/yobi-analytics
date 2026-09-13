import { useState } from "react"
import { NotificationSettings } from "./settings/NotificationSettings"
import { OshiSettings } from "./settings/OshiSettings"
import { SettingsSecondaryNavbar, type SettingsSection } from "./settings/SettingsSecondaryNavbar"

/** Settings' own [MainNavbar] [SettingsSecondaryNavbar] [Content] layout
 * (MainNavbar is mounted one level up, in App.tsx -- this renders the
 * other two). Which section is active is plain local state, not part of
 * the URL, since nothing else needs to deep-link into a specific
 * settings section today -- defaults to OshiSettings per this feature's
 * own spec. */
export function SettingsPage() {
  const [activeSection, setActiveSection] = useState<SettingsSection>("oshi")

  return (
    <div className="settings-page">
      <SettingsSecondaryNavbar activeSection={activeSection} onSelect={setActiveSection} />
      <div className="settings-page__content">
        {activeSection === "oshi" && <OshiSettings />}
        {activeSection === "notification" && <NotificationSettings />}
      </div>
    </div>
  )
}
