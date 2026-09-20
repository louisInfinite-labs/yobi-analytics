/** Roadmap Phase 7's "Widget and Layout Contract": a widget type + immutable
 * instance ID, a versioned config schema, and a layout format that stores
 * each instance's position/size/settings independently per breakpoint. */

import type { Breakpoint } from "../../../../shared/responsive/model/breakpoint"
import type { WidgetHeight } from "./dashboardLayout"

export type WidgetTypeId =
  | "kpi-summary"
  | "growth-bar-chart"
  | "contribution-ring"
  | "ranking"
  | "insights"
  | "video-stats-table"

export interface WidgetSizeLimits {
  minW: number
  minH: number
  maxW?: number
  maxH?: number
  defaultW: number
  defaultH: number
}

/** A widget's registry entry: everything about the type that doesn't vary per instance. */
export interface WidgetDefinition<TSettings = Record<string, never>> {
  type: WidgetTypeId
  schemaVersion: number
  title: string
  description: string
  sizeLimits: WidgetSizeLimits
  /** GAP-2D: which canonical heights (dashboardLayout.ts's own WidgetHeight,
   * 0.5X/1X) this widget type is evidence-verified to render correctly at
   * (GAP-2C/GAP-2C1's real-browser results) -- not every legal canonical
   * height is supported by every widget type. Reuses the canonical type
   * directly rather than a second 0.5 | 1 union. */
  allowedHeights: WidgetHeight[]
  /** Reserved for future scoped-data widgets (Roadmap Phase 9+); empty for every v1 widget. */
  permissions: readonly string[]
  defaultSettings: TSettings
  /** Upgrades a persisted settings object from an older schemaVersion; absent means the shape never changed. */
  migrateSettings?: (settings: unknown, fromVersion: number) => TSettings
}

/** One placed widget in a layout: immutable instanceId once created, mutable everything else. */
export interface WidgetInstance<TSettings = unknown> {
  instanceId: string
  type: WidgetTypeId
  schemaVersion: number
  x: number
  y: number
  w: number
  h: number
  settings: TSettings
  updatedAt: string
}

export const CURRENT_LAYOUT_VERSION = 1

export interface LayoutProfile {
  layoutVersion: number
  profileId: string
  profileName: string
  breakpoint: Breakpoint
  widgets: WidgetInstance[]
}

/** A widget whose type is missing from the registry (retired, or from a newer build) — rendered as a safe placeholder rather than crashing the page. */
export function isKnownWidgetType(type: string): type is WidgetTypeId {
  return (
    type === "kpi-summary" ||
    type === "growth-bar-chart" ||
    type === "contribution-ring" ||
    type === "ranking" ||
    type === "insights" ||
    type === "video-stats-table"
  )
}
