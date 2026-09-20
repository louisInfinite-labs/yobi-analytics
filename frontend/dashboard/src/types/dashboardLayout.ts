/** MT-01 "Canonical Layout Types and Validation Contract"
 * (frontend/dashboard/DASHBOARD_LAYOUT_GUIDELINES.md, sections 2-10).
 *
 * This is a separate model from the pre-existing GridStack-backed
 * WidgetInstance/LayoutProfile types in ./widget.ts. Those model a 12-column
 * GridStack grid with arbitrary integer widget heights; this file models the
 * guidelines' 1x1-3x3 custom grid with 0.5X/1X widget heights that the
 * layout editor rework (MT-02 onward) builds against. The two are not
 * interchangeable and neither replaces the other in this microtask.
 */

/** Both grid dimensions (columns and rows) are restricted to integers 1-3. */
export type GridDimension = 1 | 2 | 3

export interface GridSize {
  columns: GridDimension
  rows: GridDimension
}

/** A widget's height in row units: one full row (`1X`) or a half row (`0.5X`),
 * always paired with another `0.5X` widget to fill the row (Section 5.2). */
export type WidgetHeight = 0.5 | 1

/** One placed widget instance on the canonical/draft grid. */
export interface DashboardWidget {
  widgetId: string
  widgetType: string
  x: number
  y: number
  width: number
  height: WidgetHeight
  /** MT-11 "Flow 1: In-Widget Creator Picker" (Section 3.4 Flow 1): present
   * only on a comparison-capable widget that has an in-progress or saved
   * creator comparison. Optional and additive so every existing widget,
   * fixture, and validation path from MT-01 through MT-10 is unaffected by
   * a widget that never sets it. */
  comparison?: CreatorComparisonConfig
}

export interface CanonicalLayout {
  grid: GridSize
  widgets: DashboardWidget[]
}

/** Isolated editing copy of a CanonicalLayout (Section 6/10): structurally
 * identical, kept as a distinct alias so call sites document which one they
 * hold instead of mixing an in-progress edit with the saved source of truth. */
export type DraftLayout = CanonicalLayout

/** Section 3.4's comparison configuration contract. */
export interface CreatorComparisonConfig {
  creatorIds: string[] // ordered, unique, minimum length: 2
  comparisonItemIds: string[] // ordered, unique backend-supported items
}

export type LayoutValidationErrorCode =
  | "DUPLICATE_WIDGET_ID"
  | "WIDGET_OVERLAP"
  | "OUT_OF_BOUNDS"
  | "INVALID_GRID_SIZE"
  | "INVALID_HEIGHT"
  | "INVALID_WIDTH"
  | "INCOMPLETE_COLUMN"

export interface LayoutValidationError {
  code: LayoutValidationErrorCode
  widgetIds?: string[]
  message: string
}

export interface LayoutValidationResult {
  valid: boolean
  errors: LayoutValidationError[]
}

export function isGridDimension(value: number): value is GridDimension {
  return Number.isInteger(value) && value >= 1 && value <= 3
}

export function isWidgetHeight(value: number): value is WidgetHeight {
  return value === 0.5 || value === 1
}
