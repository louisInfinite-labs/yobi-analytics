import { getWidgetDefinition, isKnownWidgetType } from "./widgetRegistry"
import type { WidgetHeight } from "../model/dashboardLayout"
import type { WidgetInstance, WidgetTypeId } from "../model/widget"

/** A widget as the live GridStack renderer sees it. */
export type GridWidgetType = WidgetTypeId
export type GridWidgetInstance = Omit<WidgetInstance, "type"> & { type: GridWidgetType }

export interface GridWidgetMeta {
  title: string
  allowedHeights: WidgetHeight[]
}

/** True for every widget type the grid can render: a registered widget. */
export function isRenderableGridWidgetType(type: string): type is GridWidgetType {
  return isKnownWidgetType(type)
}

export function getGridWidgetMeta(type: GridWidgetType): GridWidgetMeta {
  const { title, allowedHeights } = getWidgetDefinition(type)
  return { title, allowedHeights }
}
