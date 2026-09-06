import { ALL_WIDGET_TYPES, getWidgetDefinition } from "./widgetRegistry"
import { CURRENT_LAYOUT_VERSION, type Breakpoint, type LayoutProfile, type WidgetInstance } from "../types/widget"

const STORAGE_PREFIX = "yobi-analytics-layout"

function storageKey(profileId: string, breakpoint: Breakpoint): string {
  return `${STORAGE_PREFIX}:${profileId}:${breakpoint}`
}

/** The out-of-the-box arrangement, matching the pre-Phase-7 fixed dashboard's
 * visual order — every default-shipped user sees this until they edit their
 * own layout. Positions are grid units; a 12-wide grid matches the existing
 * `dashboard-grid` 12-column layout so migrating away from CSS grid classes
 * doesn't have to also relearn column math. */
export function buildDefaultLayout(profileId: string, breakpoint: Breakpoint): LayoutProfile {
  const now = new Date().toISOString()
  const at = (type: (typeof ALL_WIDGET_TYPES)[number], x: number, y: number): WidgetInstance => {
    const { sizeLimits, schemaVersion, defaultSettings } = getWidgetDefinition(type)
    return {
      instanceId: `${type}-default`,
      type,
      schemaVersion,
      x,
      y,
      w: sizeLimits.defaultW,
      h: sizeLimits.defaultH,
      settings: defaultSettings,
      updatedAt: now,
    }
  }

  return {
    layoutVersion: CURRENT_LAYOUT_VERSION,
    profileId,
    profileName: "Default",
    breakpoint,
    widgets: [
      at("kpi-summary", 0, 0),
      at("growth-bar-chart", 0, 1),
      at("contribution-ring", 8, 1),
      at("ranking", 8, 3),
      at("insights", 0, 5),
      at("video-stats-table", 0, 6),
    ],
  }
}

function isValidLayoutProfile(value: unknown): value is LayoutProfile {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.layoutVersion !== "number") return false
  if (typeof v.profileId !== "string" || typeof v.profileName !== "string") return false
  if (typeof v.breakpoint !== "string") return false
  if (!Array.isArray(v.widgets)) return false
  return v.widgets.every((w) => {
    if (typeof w !== "object" || w === null) return false
    const widget = w as Record<string, unknown>
    return (
      typeof widget.instanceId === "string" &&
      typeof widget.type === "string" &&
      typeof widget.schemaVersion === "number" &&
      typeof widget.x === "number" &&
      typeof widget.y === "number" &&
      typeof widget.w === "number" &&
      typeof widget.h === "number" &&
      typeof widget.updatedAt === "string"
    )
  })
}

/** Read a profile's saved layout, or the built-in default if nothing is
 * saved yet, the saved value is corrupt, or it fails validation. Never
 * throws — a broken saved layout must degrade to the default, not crash
 * the dashboard (Roadmap 7's "unknown/retired widgets show a safe
 * placeholder" principle extended to a broken layout document itself). */
export function readLayout(profileId: string, breakpoint: Breakpoint, storage?: Storage): LayoutProfile {
  const fallback = buildDefaultLayout(profileId, breakpoint)
  try {
    const raw = (storage ?? window.localStorage).getItem(storageKey(profileId, breakpoint))
    if (!raw) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (!isValidLayoutProfile(parsed)) return fallback
    if (parsed.layoutVersion !== CURRENT_LAYOUT_VERSION) {
      // No migrations exist yet (this is the first layoutVersion) — a
      // future bump adds a migration step here rather than discarding the
      // user's layout outright.
      return fallback
    }
    return parsed
  } catch {
    return fallback
  }
}

/** Persist a profile's layout. Never throws — saving is a convenience, not
 * a correctness requirement; a full quota or disabled storage should not
 * crash Edit Mode, just silently fail to persist (the caller's own "saved"
 * confirmation should only fire after checking this returned true). */
export function writeLayout(layout: LayoutProfile, storage?: Storage): boolean {
  try {
    ;(storage ?? window.localStorage).setItem(storageKey(layout.profileId, layout.breakpoint), JSON.stringify(layout))
    return true
  } catch {
    return false
  }
}

/** Explicit "Reset to default" — removes the saved override so the next
 * readLayout call falls back to buildDefaultLayout instead of an empty one. */
export function resetLayout(profileId: string, breakpoint: Breakpoint, storage?: Storage): void {
  try {
    ;(storage ?? window.localStorage).removeItem(storageKey(profileId, breakpoint))
  } catch {
    // Best-effort; if removal fails the next readLayout still tries again.
  }
}
