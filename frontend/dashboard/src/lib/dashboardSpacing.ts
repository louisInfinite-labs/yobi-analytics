/** MT-06 "Exact 16px Spacing"
 * (frontend/dashboard/DASHBOARD_LAYOUT_GUIDELINES.md, Section 5.3).
 *
 * The single canonical pixel-geometry calculation for a widget's own
 * border-box, given its canonical grid coordinates (../types/
 * dashboardLayout.ts) and a pixel-per-grid-unit configuration. Every
 * consumer -- a saved widget, a drag placeholder, an insertion placeholder,
 * or an edit-mode preview -- must compute its rect through this same
 * function so the 16px contract (Section 5.3) and the "same spacing
 * calculation" requirement ("Grid placeholders, drag previews, and the
 * saved layout must use the same spacing calculation") hold by
 * construction rather than by convention.
 *
 * Model: each widget contributes `WIDGET_EDGE_CONTRIBUTION_PX` (8px, the
 * project's existing `--space-2` token) on every edge that faces another
 * widget, insetting its own box from its raw grid cell by that amount.
 * Two adjacent widgets each contributing 8px toward each other produces
 * exactly 16px between their boxes. A widget's edge facing a non-widget
 * component instead uses `widgetToComponentContribution` (Section 5.3:
 * "widgetContribution + componentContribution = 16px") rather than the
 * default 8px, since the component may contribute 0px or 8px of its own.
 */
import type { DashboardWidget } from "../types/dashboardLayout"

/** Matches the project's existing `--space-2` token (src/index.css) --
 * reused rather than a new custom token, per Guidelines Section 5.3's
 * recommended tokens note ("Use existing project tokens instead when they
 * already represent these exact values."). */
export const WIDGET_EDGE_CONTRIBUTION_PX = 8

/** The final visible separation the guidelines require between every
 * adjacent pair (Section 5.3) -- matches the project's existing
 * `--space-4` token. */
export const DASHBOARD_ELEMENT_GAP_PX = 16

export interface GridPixelConfig {
  columnWidthPx: number
  rowHeightPx: number
}

export interface EdgeContributionsPx {
  top: number
  right: number
  bottom: number
  left: number
}

export const DEFAULT_EDGE_CONTRIBUTIONS: EdgeContributionsPx = {
  top: WIDGET_EDGE_CONTRIBUTION_PX,
  right: WIDGET_EDGE_CONTRIBUTION_PX,
  bottom: WIDGET_EDGE_CONTRIBUTION_PX,
  left: WIDGET_EDGE_CONTRIBUTION_PX,
}

export interface PixelRect {
  top: number
  left: number
  width: number
  height: number
}

export type WidgetGeometry = Pick<DashboardWidget, "x" | "y" | "width" | "height">

/** A widget's own border-box in pixels, inset from its raw grid cell by
 * `edges` (defaulting to 8px on every side -- the "facing another widget"
 * case). Pass an explicit `edges` override for a widget sitting on a grid
 * boundary that instead faces a non-widget component (see
 * `widgetToComponentContribution`). */
export function computeWidgetPixelRect(
  widget: WidgetGeometry,
  grid: GridPixelConfig,
  edges: EdgeContributionsPx = DEFAULT_EDGE_CONTRIBUTIONS,
): PixelRect {
  const cellLeft = widget.x * grid.columnWidthPx
  const cellTop = widget.y * grid.rowHeightPx
  const cellWidth = widget.width * grid.columnWidthPx
  const cellHeight = widget.height * grid.rowHeightPx
  return {
    left: cellLeft + edges.left,
    top: cellTop + edges.top,
    width: cellWidth - edges.left - edges.right,
    height: cellHeight - edges.top - edges.bottom,
  }
}

/** Section 5.3: "The required equation is widgetContribution +
 * componentContribution = 16px." Never apply a default 16px margin to both
 * sides -- the widget's own contribution is always the complement of
 * whatever the neighboring non-widget component already contributes. */
export function widgetToComponentContribution(componentContributionPx: number): number {
  return DASHBOARD_ELEMENT_GAP_PX - componentContributionPx
}
