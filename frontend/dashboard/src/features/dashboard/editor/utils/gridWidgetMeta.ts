import { COMPARISON_WIDGET_TYPE } from "../../comparison/utils/dashboardComparisonWidgets"
import { getWidgetDefinition, isKnownWidgetType } from "./widgetRegistry"
import type { WidgetHeight } from "../model/dashboardLayout"
import type { WidgetInstance, WidgetTypeId } from "../model/widget"

/** A widget as the live GridStack renderer sees it. Registry widgets
 * are unchanged; the comparison widget type is outside the legacy registry
 * (its content depends on per-widget comparison config, not page data), so it
 * is projected under its own type string. */
export type GridWidgetType = WidgetTypeId | typeof COMPARISON_WIDGET_TYPE
export type GridWidgetInstance = Omit<WidgetInstance, "type"> & { type: GridWidgetType }

export interface GridWidgetMeta {
  title: string
  allowedHeights: WidgetHeight[]
}

/** True for every widget type the grid can render: a registered widget or the comparison chart. */
export function isRenderableGridWidgetType(type: string): type is GridWidgetType {
  return type === COMPARISON_WIDGET_TYPE || isKnownWidgetType(type)
}

export function getGridWidgetMeta(type: GridWidgetType): GridWidgetMeta {
  if (type === COMPARISON_WIDGET_TYPE) return { title: "Creator Comparison", allowedHeights: [0.5, 1] }
  const { title, allowedHeights } = getWidgetDefinition(type)
  return { title, allowedHeights }
}
