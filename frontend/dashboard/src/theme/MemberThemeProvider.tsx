import { useMemo, useState, type ReactNode } from "react"
import { ThemeContext, type ThemeContextValue } from "./ThemeContext"
import { DEFAULT_THEME_ID, THEME_PRESETS } from "./themePresets"

export function MemberThemeProvider({ children }: { children: ReactNode }) {
  const [themeId, setThemeId] = useState(DEFAULT_THEME_ID)
  const theme = THEME_PRESETS[themeId] ?? THEME_PRESETS[DEFAULT_THEME_ID]

  const cssVars = useMemo(
    () =>
      ({
        "--theme-primary": theme.primary,
        "--theme-primary-soft": theme.primarySoft,
        "--theme-primary-muted": theme.primaryMuted,
        "--theme-text-accent": theme.textAccent,
        "--theme-chart": theme.chart,
        "--theme-ring": theme.ring,
      }) as React.CSSProperties,
    [theme],
  )

  const value = useMemo<ThemeContextValue>(
    () => ({
      themeId,
      theme,
      setThemeId,
      availableThemes: Object.values(THEME_PRESETS),
    }),
    [themeId, theme],
  )

  return (
    <ThemeContext.Provider value={value}>
      <div
        className={`theme-root theme-${theme.visualMode} shape-${theme.buttonShape} header-${theme.headerStyle} badge-${theme.badgeStyle}`}
        style={cssVars}
        data-theme-id={theme.id}
      >
        {children}
      </div>
    </ThemeContext.Provider>
  )
}
