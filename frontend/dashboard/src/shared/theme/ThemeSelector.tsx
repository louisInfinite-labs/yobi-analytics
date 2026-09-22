import { Select } from "antd"
import { useMemberTheme } from "./ThemeContext"

/** Switches the dashboard's page-level visual theme (Hololive soft-idol vs.
 * VSPO soft-esports, with VSPO's two abstract sub-modes). */
export function ThemeSelector() {
  const { themeId, setThemeId, availableThemes } = useMemberTheme()

  return (
    <label className="preference-control">
      Theme
      <Select
        value={themeId}
        onChange={(next) => setThemeId(next)}
        aria-label="Dashboard theme"
        options={availableThemes.map((theme) => ({ value: theme.id, label: theme.label }))}
        popupMatchSelectWidth={false}
        size="small"
      />
    </label>
  )
}
