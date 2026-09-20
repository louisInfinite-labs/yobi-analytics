/** Production catalog-driven canonical Add Widget UI.
 *
 * Maps the loaded chart catalog (`useChartCatalog`'s `ChartCatalogItem[]`,
 * held at page level) to the widget types the production Add UI may offer -- the single
 * place that decides "returned by the catalog AND supported by the frontend
 * registry" (AC2/AC3), so `WidgetTray` itself never has to know about
 * `ChartCatalogItem` or re-derive this filter. A catalog item whose
 * `chartDefinitionId` isn't a registered `WidgetTypeId` (the backend may add
 * charts before the frontend registers them, so nothing here assumes the catalog only ever returns
 * known ids) is dropped rather than fabricating a registry entry for it
 * (AC4) -- silently, since an unrenderable catalog entry is an expected,
 * not exceptional, condition (a chart definition can exist on the backend
 * before this frontend ships support for it). A duplicate
 * `chartDefinitionId` in the catalog response collapses to one Add option
 * (AC16's "distinct widgetId per insertion" is a separate, per-insertion
 * guarantee `addWidgetAtSlot`/`createWidgetId` already own; this only
 * avoids offering the same catalog choice twice).
 */
import { isKnownWidgetType } from "./widgetRegistry"
import type { ChartCatalogItem } from "../types/dashboardChartCatalog"
import type { WidgetTypeId } from "../types/widget"

export function resolveAddableWidgetTypes(items: readonly ChartCatalogItem[]): WidgetTypeId[] {
  const seen = new Set<WidgetTypeId>()
  const result: WidgetTypeId[] = []
  for (const item of items) {
    if (!isKnownWidgetType(item.chartDefinitionId)) continue
    if (seen.has(item.chartDefinitionId)) continue
    seen.add(item.chartDefinitionId)
    result.push(item.chartDefinitionId)
  }
  return result
}
