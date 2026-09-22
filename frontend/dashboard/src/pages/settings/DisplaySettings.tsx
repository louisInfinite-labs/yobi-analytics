import { UpcomingDisplaySettings } from "../../features/live-status/components/UpcomingDisplaySettings"
import { ThemeSelector } from "../../shared/theme/ThemeSelector"

export function DisplaySettings() {
  return (
    <section className="display-settings" aria-labelledby="display-settings-title">
      <div className="settings-section-heading">
        <div>
          <h1 id="display-settings-title">Display</h1>
          <p>Choose how the app looks and how upcoming stream times are shown.</p>
        </div>
      </div>

      <div className="display-settings__group">
        <h2>Appearance</h2>
        <ThemeSelector />
      </div>

      <div className="display-settings__group">
        <h2>Upcoming streams</h2>
        <UpcomingDisplaySettings />
      </div>
    </section>
  )
}
