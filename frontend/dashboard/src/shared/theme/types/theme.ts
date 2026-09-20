export type ThemeGroup = "hololive-jp" | "vspo-jp"

export type ThemeVisualMode = "soft-idol" | "soft-esports" | "tactical" | "momentum"

export type ButtonShape = "soft-rounded" | "soft-angular" | "sharp-angular"

export type HeaderStyle = "idol-soft" | "esports-hud"

export type BadgeStyle = "soft-pill" | "angled-chip" | "meter-chip"

export interface MemberTheme {
  id: string
  group: ThemeGroup
  memberName: string
  visualMode: ThemeVisualMode

  primary: string
  primarySoft: string
  primaryMuted: string
  textAccent: string
  chart: string
  ring: string

  buttonShape: ButtonShape
  headerStyle: HeaderStyle
  badgeStyle: BadgeStyle
}
