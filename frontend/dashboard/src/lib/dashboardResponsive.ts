/** MT-16 "Responsive and Accessibility Verification"
 * (frontend/dashboard/DASHBOARD_LAYOUT_GUIDELINES.md, Section 11).
 *
 * MT-06's own docstring already noted MT-16 as the owner of "defining the
 * authoritative per-breakpoint column counts and widths (Section 11) that a
 * real render would need" -- `BREAKPOINT_COLUMN_LIMIT` and
 * `MIN_CHART_WIDTH_PX` below are that definition. Reuses the project's
 * existing `Breakpoint` type (`../types/widget.ts`, already the type
 * `useBreakpoint.ts` resolves from `window.innerWidth`) rather than
 * inventing a second breakpoint concept (Guidelines Section 0: "Do not
 * introduce new breakpoints unless the task explicitly requires them").
 *
 * `reflowLayoutForBreakpoint` returns a `ResponsiveLayout`, not a
 * `CanonicalLayout`: its `rows` is a plain `number`, not MT-01's
 * `GridDimension` (1-5). `GridDimension` is the *editable canonical grid's*
 * own range (Section 5.1's "1x1 through 5x5" is a constraint on the grid a
 * user can configure in the editor); a responsive reflow is a read-only
 * *display* transform of an already-valid canonical layout, not a new
 * editable/saveable grid size, so it is never fed back through
 * `validateLayout`/the editor's save path and is not bound by that same
 * range. Section 11 itself only requires "no overlaps or overflow" and
 * deterministic order/identity -- both proven directly against this
 * type's own geometry below, not by reusing the canonical validator.
 *
 * Deterministic shelf-packing (Section 11: "use deterministic stacking
 * rather than shrinking charts below their readable size"): widgets are
 * placed left-to-right in row-major order onto the current "shelf" (a run
 * of widgets sharing one `y`); a widget that would overflow the shelf's
 * remaining width starts a new shelf below the tallest widget already on
 * the current one. At `mobile` (`BREAKPOINT_COLUMN_LIMIT.mobile === 1`)
 * every widget's capped width is `1`, so no widget can ever share a shelf
 * with another -- this collapses to exactly the same one-widget-per-row
 * full-width stack Section 11's "small screens" wording describes, without
 * a separate code path. At `tablet` (`=== 2`), two `width: 1` widgets
 * genuinely sit side by side when there's room, instead of every widget
 * being forced full-width regardless of the declared column count -- the
 * MT-16 correction that made `tablet`'s `BREAKPOINT_COLUMN_LIMIT` value
 * actually observable in the produced geometry, not just a numeral that
 * was never used to place more than one widget per shelf.
 */
import type { Breakpoint } from "../types/widget"
import type { CanonicalLayout, DashboardWidget } from "../types/dashboardLayout"
import { sortWidgetsVisualOrder } from "./dashboardComparisonMapping"

/** The authoritative per-breakpoint column cap this microtask defines
 * (Section 11). Desktop keeps the canonical grid's own column count (up to
 * the editable 1-5 range); tablet and mobile cap it down, mobile to a
 * single deterministic column/stack. */
export const BREAKPOINT_COLUMN_LIMIT: Record<Breakpoint, number> = {
  desktop: 5,
  tablet: 2,
  mobile: 1,
}

/** The authoritative minimum pixel width a chart may render at (Section
 * 11: "rather than shrinking charts below their readable size"). Below
 * this, a chart must not render its normal content (see
 * `ComparisonChart.tsx`'s own `width < MIN_CHART_WIDTH_PX` guard). */
export const MIN_CHART_WIDTH_PX = 240

export interface ResponsiveLayout {
  columns: number
  rows: number
  widgets: DashboardWidget[]
}

/** AC1 (deterministic order), AC2 (no overlap/overflow), AC4 (identical
 * `widgetId`s): pure and total over every supported `Breakpoint` --
 * reloading at the same breakpoint with the same input always produces the
 * same output (Section 11: "Reloading at the same breakpoint must produce
 * the same order"). */
export function reflowLayoutForBreakpoint(layout: CanonicalLayout, breakpoint: Breakpoint): ResponsiveLayout {
  const orderedWidgets = sortWidgetsVisualOrder(layout.widgets)

  if (breakpoint === "desktop") {
    return { columns: layout.grid.columns, rows: layout.grid.rows, widgets: orderedWidgets }
  }

  const columns = Math.min(layout.grid.columns, BREAKPOINT_COLUMN_LIMIT[breakpoint])
  let shelfX = 0
  let shelfY = 0
  let shelfHeight = 0
  const widgets: DashboardWidget[] = []

  for (const widget of orderedWidgets) {
    const width = Math.min(widget.width, columns)
    if (shelfX + width > columns) {
      shelfY += shelfHeight
      shelfX = 0
      shelfHeight = 0
    }
    widgets.push({ ...widget, x: shelfX, y: shelfY, width })
    shelfX += width
    shelfHeight = Math.max(shelfHeight, widget.height)
  }

  return { columns, rows: shelfY + shelfHeight, widgets }
}
