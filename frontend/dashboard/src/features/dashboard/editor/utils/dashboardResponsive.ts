/** MT-16 "Responsive and Accessibility Verification"
 * (frontend/dashboard/DASHBOARD_LAYOUT_GUIDELINES.md, Section 11).
 *
 * MT-06's own docstring already noted MT-16 as the owner of "defining the
 * authoritative per-breakpoint column counts and widths (Section 11) that a
 * real render would need" -- `BREAKPOINT_COLUMN_LIMIT` and
 * `MIN_CHART_WIDTH_PX` below are that definition. Reuses the project's
 * existing `Breakpoint` type (`shared/responsive/model/breakpoint.ts`, already the type
 * `useBreakpoint.ts` resolves from `window.innerWidth`) rather than
 * inventing a second breakpoint concept (Guidelines Section 0: "Do not
 * introduce new breakpoints unless the task explicitly requires them").
 *
 * `reflowLayoutForBreakpoint` returns a `ResponsiveLayout`, not a
 * `CanonicalLayout`: its `rows` is a plain `number`, not MT-01's
 * `GridDimension` (1-3). `GridDimension` is the *editable canonical grid's*
 * own range (Section 5.1's "1x1 through 3x3" is a constraint on the grid a
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
import type { Breakpoint } from "../../../../shared/responsive/model/breakpoint"
import type { CanonicalLayout, DashboardWidget } from "../model/dashboardLayout"
import { sortWidgetsVisualOrder } from "../../comparison/utils/dashboardComparisonMapping"
import { DASHBOARD_ELEMENT_GAP_PX } from "./dashboardSpacing"

/** The authoritative per-breakpoint column cap this microtask defines
 * (Section 11). Desktop keeps the canonical grid's own column count (up to
 * the editable 1-3 range); tablet and mobile cap it down, mobile to a
 * single deterministic column/stack. */
export const BREAKPOINT_COLUMN_LIMIT: Record<Breakpoint, number> = {
  desktop: 3,
  tablet: 2,
  mobile: 1,
}

/** The
 * product's own per-breakpoint cap on the canonical grid *editing* may grow
 * into (desktop: the full 1-3 `GridDimension` range; tablet: 3x3; mobile:
 * not editable at all, so its own value is never consulted). This is a
 * distinct policy from `BREAKPOINT_COLUMN_LIMIT` above, which caps only the
 * *read-only display reflow*'s shelf width for a layout wider than a
 * breakpoint can show -- editing always operates on real canonical
 * coordinates (never the reflowed display geometry), so it needs its own
 * cap rather than reusing the display one. Desktop's and tablet's `3` both equal
 * `validateLayout`'s own `GridDimension` maximum, so neither adds a
 * restriction beyond the validator; the cap is enforced
 * at the one place the live grid size can grow (the Add-insertion
 * commit) -- a drag/resize can never grow `grid.columns`/`grid.rows` at all
 * (`updateWidgetGeometry` never touches `grid`), so the existing
 * `validateLayout` bounds check already enforces this cap for free once a
 * layout's own grid size respects it. */
export const BREAKPOINT_MAX_EDITABLE_GRID: Record<Breakpoint, number> = {
  desktop: 3,
  tablet: 3,
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

/** Dynamic readable column cap: the static
 * `BREAKPOINT_MAX_EDITABLE_GRID` values are ceilings, not guarantees -- a
 * narrow-enough grid container cannot show that many columns at
 * `MIN_CHART_WIDTH_PX` each. This computes how many columns the *actual
 * rendered* grid container width can hold.
 *
 * The spacing model is GridStack's real one (DashboardGrid.tsx's
 * `margin: 8`): every widget is inset by `WIDGET_EDGE_CONTRIBUTION_PX` on
 * *all* of its sides, outer edges included, so a column of a container
 * `W` wide renders `W / n - DASHBOARD_ELEMENT_GAP_PX` pixels wide (measured:
 * 1156px / 5 columns -> 215.2px). `n` columns are therefore readable iff
 * `W >= n * (MIN_CHART_WIDTH_PX + DASHBOARD_ELEMENT_GAP_PX)`. (The
 * original `(W + gap) / (min + gap)` treated the outer edges as flush and
 * so admitted a 16px band of widths where widgets rendered up to 3.2px under
 * the minimum.) Clamped to `[1, maxColumns]`. Pure arithmetic -- callers own
 * measuring the real DOM width (`ResizeObserver` against the actual rendered
 * grid container, not `window.innerWidth`) and which ceiling applies. */
export function computeReadableColumnCap(availableContentWidthPx: number, maxColumns: number): number {
  const rawColumns = Math.floor(availableContentWidthPx / (MIN_CHART_WIDTH_PX + DASHBOARD_ELEMENT_GAP_PX))
  return Math.max(1, Math.min(maxColumns, rawColumns))
}

/** AC1 (deterministic order), AC2 (no overlap/overflow), AC4 (identical
 * `widgetId`s): pure and total over every supported `Breakpoint` --
 * reloading at the same breakpoint with the same input always produces the
 * same output (Section 11: "Reloading at the same breakpoint must produce
 * the same order").
 *
 * `columnCapOverride` (tablet and desktop): when supplied, replaces
 * `BREAKPOINT_COLUMN_LIMIT[breakpoint]` as the shelf-packing width -- the
 * same shelf-packing algorithm below, not a second one, parameterized so
 * the live production tablet/desktop paths (`DashboardPage.tsx`) can
 * reflow at their own dynamically measured `computeReadableColumnCap`
 * result instead of the static display cap.
 * Every existing caller omits it and gets the exact previous behavior. */
export function reflowLayoutForBreakpoint(layout: CanonicalLayout, breakpoint: Breakpoint, columnCapOverride?: number): ResponsiveLayout {
  const orderedWidgets = sortWidgetsVisualOrder(layout.widgets)

  const columnCap = columnCapOverride ?? BREAKPOINT_COLUMN_LIMIT[breakpoint]
  // Desktop keeps the canonical geometry whenever it fits the cap
  // (always, when no override is supplied -- the cap then defaults to the
  // product's own 3-column maximum); a `columnCapOverride` below the
  // layout's own width reflows the *display* exactly like tablet does.
  if (breakpoint === "desktop" && layout.grid.columns <= columnCap) {
    return { columns: layout.grid.columns, rows: layout.grid.rows, widgets: orderedWidgets }
  }

  const columns = Math.min(layout.grid.columns, columnCap)
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
