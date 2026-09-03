import { useMemberTheme } from "../theme/ThemeContext"

/** Switches the dashboard's page-level visual theme (Hololive soft-idol vs.
 * VSPO soft-esports, with VSPO's two abstract sub-modes). */
export function ThemeSelector() {
  const { themeId, setThemeId, availableThemes } = useMemberTheme()

  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-secondary)" }}>
      Theme
      <select className="soft-select" value={themeId} onChange={(e) => setThemeId(e.target.value)} aria-label="Dashboard theme">
        {availableThemes.map((theme) => (
          <option key={theme.id} value={theme.id}>
            {theme.label}
          </option>
        ))}
      </select>
    </label>
  )
}
