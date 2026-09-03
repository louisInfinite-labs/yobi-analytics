import { createContext, useContext } from "react"
import type { ThemePreset } from "./themePresets"

export interface ThemeContextValue {
  themeId: string
  theme: ThemePreset
  setThemeId: (id: string) => void
  availableThemes: ThemePreset[]
}

export const ThemeContext = createContext<ThemeContextValue | null>(null)

export function useMemberTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error("useMemberTheme must be used within a MemberThemeProvider")
  return ctx
}
