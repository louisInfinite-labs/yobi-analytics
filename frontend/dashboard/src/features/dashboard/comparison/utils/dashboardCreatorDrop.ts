/** MT-13 "Flow 3: Drag Creator Cell into Chart" (Section 3.4 Flow 3), extended
 * by R9's per-widget-type creator count cap (Phase 3: "one video-ranking
 * widget = exactly one creator"). */
import { maxCreatorScopeCount, supportsCreatorScope } from "../../editor/utils/widgetRegistry"
import type { CanonicalLayout } from "../../editor/model/dashboardLayout"

/** Appends `creatorId` to the target widget's `creatorScope.creatorIds` if the
 * widget supports creator scope, doesn't already contain it, and the
 * resulting count doesn't exceed that widget type's own cap (e.g.
 * creator-video-ranking: at most 1); otherwise returns `layout` unchanged.
 * Every other widget is returned by the same object reference. */
export function dropCreatorsOntoWidget(layout: CanonicalLayout, widgetId: string, creatorIds: readonly string[]): CanonicalLayout {
  const target = layout.widgets.find((widget) => widget.widgetId === widgetId)
  if (!target || !supportsCreatorScope(target.widgetType)) return layout
  const nextCreatorIds = [...new Set(creatorIds)]
  if (nextCreatorIds.length > maxCreatorScopeCount(target.widgetType)) return layout

  return {
    ...layout,
    widgets: layout.widgets.map((widget) =>
      widget.widgetId === widgetId ? { ...widget, creatorScope: { creatorIds: nextCreatorIds } } : widget,
    ),
  }
}

export type CreatorDropOutcome =
  | { status: "accepted" }
  | { status: "incompatible" }
  | { status: "too_many_creators"; max: number }
  | { status: "missing" }

/** Classifies whether `widgetId` accepts a creator drop, so the live page
 * can announce the result without re-deriving compatibility rules. Does not
 * know how many creators a caller is about to drop -- see the `creatorCount`
 * overload's own contract below for the count-aware check. */
export function describeCreatorDrop(layout: CanonicalLayout, widgetId: string, creatorCount = 1): CreatorDropOutcome {
  const target = layout.widgets.find((widget) => widget.widgetId === widgetId)
  if (!target) return { status: "missing" }
  if (!supportsCreatorScope(target.widgetType)) return { status: "incompatible" }
  const max = maxCreatorScopeCount(target.widgetType)
  if (creatorCount > max) return { status: "too_many_creators", max }
  return { status: "accepted" }
}
