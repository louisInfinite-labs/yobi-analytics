/** MT-13 "Flow 3: Drag Creator Cell into Chart" (Section 3.4 Flow 3). */
import { isComparisonCapableWidget } from "./dashboardComparisonWidgets"
import type { CanonicalLayout, CreatorComparisonConfig } from "../types/dashboardLayout"

/** Appends `creatorId` to the target widget's `comparison.creatorIds` if the
 * widget is comparison-capable and doesn't already contain it (AC5, AC6);
 * otherwise returns `layout` unchanged. Every other widget is returned by
 * the same object reference (AC8, AC9). */
export function dropCreatorOntoWidget(layout: CanonicalLayout, widgetId: string, creatorId: string): CanonicalLayout {
  const target = layout.widgets.find((widget) => widget.widgetId === widgetId)
  if (!target || !isComparisonCapableWidget(target)) return layout

  const existingCreatorIds = target.comparison?.creatorIds ?? []
  if (existingCreatorIds.includes(creatorId)) return layout

  const nextComparison: CreatorComparisonConfig = {
    creatorIds: [...existingCreatorIds, creatorId],
    comparisonItemIds: target.comparison?.comparisonItemIds ?? [],
  }

  return {
    ...layout,
    widgets: layout.widgets.map((widget) => (widget.widgetId === widgetId ? { ...widget, comparison: nextComparison } : widget)),
  }
}
