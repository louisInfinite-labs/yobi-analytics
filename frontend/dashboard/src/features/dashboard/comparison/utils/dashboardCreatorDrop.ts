/** MT-13 "Flow 3: Drag Creator Cell into Chart" (Section 3.4 Flow 3). */
import { supportsCreatorScope } from "../../editor/utils/widgetRegistry"
import type { CanonicalLayout } from "../../editor/model/dashboardLayout"

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

export type CreatorDropOutcome = { status: "accepted" } | { status: "incompatible" } | { status: "missing" }

/** Classifies whether `widgetId` accepts a creator drop, so the live page
 * can announce the result without re-deriving compatibility rules. */
export function describeCreatorDrop(layout: CanonicalLayout, widgetId: string): CreatorDropOutcome {
  const target = layout.widgets.find((widget) => widget.widgetId === widgetId)
  if (!target) return { status: "missing" }
  if (!supportsCreatorScope(target.widgetType)) return { status: "incompatible" }
  return { status: "accepted" }
}
