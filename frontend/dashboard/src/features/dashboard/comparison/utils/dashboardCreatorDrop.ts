/** MT-13 "Flow 3: Drag Creator Cell into Chart" (Section 3.4 Flow 3). */
import { supportsCreatorScope } from "../../editor/utils/widgetRegistry"
import { isComparisonCapableWidget } from "./dashboardComparisonWidgets"
import type { CanonicalLayout, CreatorComparisonConfig } from "../../editor/model/dashboardLayout"

/** Appends `creatorId` to the target widget's `comparison.creatorIds` if the
 * widget is comparison-capable and doesn't already contain it (AC5, AC6);
 * otherwise returns `layout` unchanged. Every other widget is returned by
 * the same object reference (AC8, AC9). */
export function dropCreatorsOntoWidget(layout: CanonicalLayout, widgetId: string, creatorIds: readonly string[]): CanonicalLayout {
  const target = layout.widgets.find((widget) => widget.widgetId === widgetId)
  if (!target || !supportsCreatorScope(target.widgetType)) return layout
  const nextCreatorIds = [...new Set(creatorIds)]

  return {
    ...layout,
    widgets: layout.widgets.map((widget) =>
      widget.widgetId === widgetId ? { ...widget, creatorScope: { creatorIds: nextCreatorIds } } : widget,
    ),
  }
}

/** Backward-compatible single-member entry point for existing callers. */
export function dropCreatorOntoWidget(layout: CanonicalLayout, widgetId: string, creatorId: string): CanonicalLayout {
  const target = layout.widgets.find((widget) => widget.widgetId === widgetId)
  if (!target || !isComparisonCapableWidget(target)) return layout
  const existingCreatorIds = target.comparison?.creatorIds ?? []
  if (existingCreatorIds.includes(creatorId)) return layout
  const comparison: CreatorComparisonConfig = {
    creatorIds: [...existingCreatorIds, creatorId],
    comparisonItemIds: target.comparison?.comparisonItemIds ?? [],
  }
  return {
    ...layout,
    widgets: layout.widgets.map((widget) => widget.widgetId === widgetId ? { ...widget, comparison } : widget),
  }
}

export type CreatorDropOutcome =
  | { status: "accepted" }
  | { status: "added"; order: number }
  | { status: "duplicate" }
  | { status: "incompatible" }
  | { status: "missing" }

/** Classifies what `dropCreatorOntoWidget` would do, so the live page
 * can announce the result without re-deriving compatibility or duplicate
 * rules. `order` is the 1-based comparison order the new creator receives. */
export function describeCreatorDrop(layout: CanonicalLayout, widgetId: string, _creatorId?: string): CreatorDropOutcome {
  const target = layout.widgets.find((widget) => widget.widgetId === widgetId)
  if (!target) return { status: "missing" }
  if (_creatorId !== undefined) {
    if (!isComparisonCapableWidget(target)) return { status: "incompatible" }
    const existing = target.comparison?.creatorIds ?? []
    return existing.includes(_creatorId) ? { status: "duplicate" } : { status: "added", order: existing.length + 1 }
  }
  if (!supportsCreatorScope(target.widgetType) && !isComparisonCapableWidget(target)) return { status: "incompatible" }
  return { status: "accepted" }
}
