import type { MemberTheme, ThemeGroup, ThemeVisualMode } from "../types/theme"

export interface ThemePreset extends MemberTheme {
  label: string
}

// Group-level visual languages (dashboard_ui_direction_en.md section 4):
// hololive JP is soft-idol, VSPO JP is soft-esports with two abstract
// sub-modes. These are page-level presets the ThemeSelector switches
// between — not one authored object per individual member (impractical at
// ~70 creators); per-row member accents are derived instead, see
// getMemberAccent in memberAccent.ts.
export const THEME_PRESETS: Record<string, ThemePreset> = {
  "hololive-jp": {
    id: "hololive-jp",
    label: "Hololive JP — Soft Idol",
    group: "hololive-jp",
    memberName: "Hololive JP",
    visualMode: "soft-idol",
    primary: "#c77fb0",
    primarySoft: "#f3dcec",
    primaryMuted: "#faf0f6",
    textAccent: "#8a4a76",
    chart: "#c77fb0",
    ring: "#c77fb0",
    buttonShape: "soft-angular",
    headerStyle: "idol-soft",
    badgeStyle: "soft-pill",
  },
  "vspo-jp-tactical": {
    id: "vspo-jp-tactical",
    label: "VSPO JP — Tactical",
    group: "vspo-jp",
    memberName: "VSPO JP",
    visualMode: "tactical",
    primary: "#3f8fae",
    primarySoft: "#d8ecf4",
    primaryMuted: "#eef7fa",
    textAccent: "#215a70",
    chart: "#3f8fae",
    ring: "#3f8fae",
    buttonShape: "sharp-angular",
    headerStyle: "esports-hud",
    badgeStyle: "angled-chip",
  },
  "vspo-jp-momentum": {
    id: "vspo-jp-momentum",
    label: "VSPO JP — Momentum",
    group: "vspo-jp",
    memberName: "VSPO JP",
    visualMode: "momentum",
    primary: "#d97b3f",
    primarySoft: "#f7ded0",
    primaryMuted: "#fbf1ea",
    textAccent: "#8a4a1f",
    chart: "#d97b3f",
    ring: "#d97b3f",
    buttonShape: "sharp-angular",
    headerStyle: "esports-hud",
    badgeStyle: "meter-chip",
  },
}

export const DEFAULT_THEME_ID = "hololive-jp"

/** Map a creator's organization to its default theme group. */
export function themeGroupForOrganization(organization: "hololive" | "vspo"): ThemeGroup {
  return organization === "hololive" ? "hololive-jp" : "vspo-jp"
}

/** Human-readable label for a ThemeVisualMode. */
export function visualModeLabel(mode: ThemeVisualMode): string {
  switch (mode) {
    case "soft-idol":
      return "Soft Idol"
    case "soft-esports":
      return "Soft Esports"
    case "tactical":
      return "Tactical"
    case "momentum":
      return "Momentum"
  }
}
