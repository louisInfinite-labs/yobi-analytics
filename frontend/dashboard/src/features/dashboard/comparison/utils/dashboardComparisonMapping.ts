/** MT-12 "Flow 2: Creator List Selection and widget[0]-First Save"
 * (frontend/dashboard/DASHBOARD_LAYOUT_GUIDELINES.md, Section 3.4 Flow 2).
 *
 * Pure mapping/transaction logic only. Operates on `canonicalLayout` --
 * never `draftLayout` -- so the resulting transaction can never include an
 * unrelated, unsaved Dashboard edit (Section 3.4: "must not accidentally
 * commit unrelated Dashboard draft changes"; MT-12 AC14). This is a
 * deliberately separate boundary from `dashboardLayoutSave.ts`'s MT-09
 * `submitLayoutSave`: Flow 2's dialog Save is its own atomic transaction,
 * not the normal Dashboard Save flow (Section 3.4: "Flow 2 uses its own
 * explicit dialog Save as the atomic persistence boundary").
 *
 * Widgets are sorted into row-major visual order (top-to-bottom, then
 * left-to-right) rather than trusting `layout.widgets`' storage-array order
 * -- Section 3.4 Flow 2, step 5-6 ("Define the top-left widget as widget[0].
 * Do not rely on incidental array or API response order."). Reused widgets
 * only ever have their `widgetType` and `comparison` fields replaced; every
 * other field, including `widgetId`, `x`, `y`, `width`, and `height`, is
 * preserved by construction (a widget this function does not assign is
 * returned by the exact same object reference it came in with).
 *
 * Newly appended widgets (when more items are selected than existing
 * containers) are placed only into a canonical-validator-confirmed empty
 * 1x1 slot -- `findNextAvailableSlot` never invents a coordinate that
 * bypasses `validateLayout`. This function only searches whole,
 * integer-row 1x1 slots; a half-row (`0.5X`) auto-fill is out of MT-12's
 * scope (no acceptance criterion or fixture describes one).
 */
import { validateLayout } from "../../editor/utils/dashboardLayoutValidation"
import { createWidgetId } from "../../editor/utils/dashboardWidgetActions"
import { COMPARISON_WIDGET_TYPE } from "./dashboardComparisonWidgets"
import { dedupePreservingOrder } from "./creatorComparisonOrder"
import type { CanonicalLayout, DashboardWidget, GridSize } from "../../editor/model/dashboardLayout"

const APPENDED_WIDGET_WIDTH = 1
const APPENDED_WIDGET_HEIGHT = 1

export interface ComparisonAssignment {
  widgetId: string
  comparisonItemId: string
  /** 0-based visual-order index -- `widget[widgetIndex]` per Section 3.4. */
  widgetIndex: number
}

export interface ComparisonMappingResult {
  ok: boolean
  /** The candidate layout with every assignment/append applied. When `ok`
   * is false, this is `canonicalLayout` itself, completely unchanged
   * (MT-12 AC11: "no widget is appended, existing widget configuration
   * remains unchanged"). */
  resultingLayout: CanonicalLayout
  /** Ordered exactly like the selected comparison items. */
  assignments: ComparisonAssignment[]
  appendedWidgetIds: string[]
  reason?: "INSUFFICIENT_CAPACITY"
}

/** Row-major visual order: top to bottom, then left to right (Section 3.4
 * Flow 2 step 5). Independent of `widgets`' own array order. */
export function sortWidgetsVisualOrder(widgets: readonly DashboardWidget[]): DashboardWidget[] {
  return [...widgets].sort((a, b) => a.y - b.y || a.x - b.x)
}

/** Scans the grid row-major for the first 1x1 cell where placing a new
 * widget keeps the layout valid under the canonical validator -- never a
 * manually invented coordinate. Returns `null` when no such cell exists. */
function findNextAvailableSlot(grid: GridSize, occupiedWidgets: readonly DashboardWidget[]): { x: number; y: number } | null {
  for (let y = 0; y < grid.rows; y++) {
    for (let x = 0; x < grid.columns; x++) {
      const probe: DashboardWidget = {
        widgetId: "__mt12_slot_probe__",
        widgetType: "__mt12_slot_probe__",
        x,
        y,
        width: APPENDED_WIDGET_WIDTH,
        height: APPENDED_WIDGET_HEIGHT,
      }
      const probeLayout: CanonicalLayout = { grid, widgets: [...occupiedWidgets, probe] }
      if (validateLayout(probeLayout).valid) return { x, y }
    }
  }
  return null
}

/** MT-12 AC1-AC12: computes (without mutating anything) the complete
 * widget[0]-first mapping of `comparisonItemIds` onto `canonicalLayout`'s
 * existing widgets in visual order, appending exactly the widgets still
 * missing after reusing every existing container. Pure and side-effect
 * free -- safe to call on every keystroke for a live mapping preview
 * (AC12) without ever mutating Dashboard state merely by being displayed. */
export function computeComparisonMapping(
  canonicalLayout: CanonicalLayout,
  creatorIds: readonly string[],
  comparisonItemIds: readonly string[],
): ComparisonMappingResult {
  const orderedCreatorIds = dedupePreservingOrder(creatorIds)
  const orderedItemIds = dedupePreservingOrder(comparisonItemIds)
  const visualOrder = sortWidgetsVisualOrder(canonicalLayout.widgets)

  const appendedWidgets: DashboardWidget[] = []
  let workingWidgets: DashboardWidget[] = [...canonicalLayout.widgets]

  const neededAppendCount = Math.max(0, orderedItemIds.length - visualOrder.length)
  for (let i = 0; i < neededAppendCount; i++) {
    const slot = findNextAvailableSlot(canonicalLayout.grid, workingWidgets)
    if (!slot) {
      return { ok: false, resultingLayout: canonicalLayout, assignments: [], appendedWidgetIds: [], reason: "INSUFFICIENT_CAPACITY" }
    }
    const newWidget: DashboardWidget = {
      widgetId: createWidgetId(COMPARISON_WIDGET_TYPE),
      widgetType: COMPARISON_WIDGET_TYPE,
      x: slot.x,
      y: slot.y,
      width: APPENDED_WIDGET_WIDTH,
      height: APPENDED_WIDGET_HEIGHT,
    }
    appendedWidgets.push(newWidget)
    workingWidgets = [...workingWidgets, newWidget]
  }

  // Existing containers in visual order first, appended containers after --
  // "append exactly the missing number of chart widgets after the existing
  // visual sequence" (Section 3.4 Flow 2 step 11).
  const containers = [...visualOrder, ...appendedWidgets]
  const assignments: ComparisonAssignment[] = orderedItemIds.map((comparisonItemId, widgetIndex) => ({
    widgetId: containers[widgetIndex].widgetId,
    comparisonItemId,
    widgetIndex,
  }))
  const assignedItemIdByWidgetId = new Map(assignments.map((a) => [a.widgetId, a.comparisonItemId]))

  const resultingWidgets = workingWidgets.map((widget) => {
    const assignedItemId = assignedItemIdByWidgetId.get(widget.widgetId)
    if (assignedItemId === undefined) return widget // untouched: same reference (AC9, AC10)
    return {
      ...widget,
      widgetType: COMPARISON_WIDGET_TYPE,
      comparison: { creatorIds: orderedCreatorIds, comparisonItemIds: [assignedItemId] },
    }
  })

  const resultingLayout: CanonicalLayout = { grid: canonicalLayout.grid, widgets: resultingWidgets }
  if (!validateLayout(resultingLayout).valid) {
    return { ok: false, resultingLayout: canonicalLayout, assignments: [], appendedWidgetIds: [], reason: "INSUFFICIENT_CAPACITY" }
  }

  return { ok: true, resultingLayout, assignments, appendedWidgetIds: appendedWidgets.map((w) => w.widgetId) }
}

export interface ComparisonTransactionOutcome {
  /** True only when `submit` was called and resolved. */
  committed: boolean
  /** Present only when `committed` is true. */
  layout?: CanonicalLayout
  /** Present only when `submit` was called and rejected. */
  error?: Error
}

/** A plain per-field/per-widget copy, matching `dashboardLayoutSave.ts`'s
 * own `cloneCanonicalLayout` convention: `submit` never receives (or can
 * mutate) the object this module keeps as the eventual committed value. */
function cloneCanonicalLayout(layout: CanonicalLayout): CanonicalLayout {
  return { grid: { ...layout.grid }, widgets: layout.widgets.map((widget) => ({ ...widget })) }
}

/** MT-12 AC13/AC19: the single atomic transaction boundary for Flow 2.
 * Never calls `submit` for a `!mapping.ok` result (AC11's "no comparison
 * transaction is sent"). On success, `outcome.layout` is always the
 * already-computed `mapping.resultingLayout` -- never whatever `submit`
 * resolves with -- so a misbehaving `submit` cannot reintroduce a changed
 * `widgetId`, a duplicate, or an overlap. On failure, nothing is returned to
 * commit, so the caller's own canonical state is left completely untouched
 * (AC19's atomicity). No real backend endpoint exists for this transaction
 * yet (the same architecture gap `dashboardLayoutSave.ts`'s `submitSave`
 * documents for MT-09); `submit` is the same injected-boundary pattern, not
 * an invented backend API. */
export async function submitComparisonTransaction(
  mapping: ComparisonMappingResult,
  submit: (layout: CanonicalLayout) => Promise<void>,
): Promise<ComparisonTransactionOutcome> {
  if (!mapping.ok) return { committed: false }

  try {
    await submit(cloneCanonicalLayout(mapping.resultingLayout))
    return { committed: true, layout: mapping.resultingLayout }
  } catch (err) {
    return { committed: false, error: err instanceof Error ? err : new Error(String(err)) }
  }
}
