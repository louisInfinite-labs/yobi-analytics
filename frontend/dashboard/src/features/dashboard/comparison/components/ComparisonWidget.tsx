import { useCallback, useEffect, useMemo, useState } from "react"
import { Button } from "antd"
import { ComparisonChart } from "./ComparisonChart"
import { ComparisonOrderBadge } from "./ComparisonOrderBadge"
import { resolveComparisonCreators } from "../utils/comparisonCreators"
import type { MockCreator } from "../../../../entities/creator/data/mockCreators"
import type { DashboardWidget } from "../../editor/model/dashboardLayout"
import type { ComparisonItem } from "../model/dashboardComparisonCatalog"
import type { ComparisonDataRequest, ComparisonDataResponse } from "../model/dashboardComparisonData"

export interface ComparisonWidgetProps {
  widget: DashboardWidget
  roster: readonly MockCreator[]
  availableComparisonItems: readonly ComparisonItem[]
  fetchComparisonData: (request: ComparisonDataRequest) => Promise<ComparisonDataResponse>
  /** Present only while the Dashboard is editable: shows Flow 1's **Select Creators** action. */
  onSelectCreators?: (widgetId: string) => void
  /** True when the source is a temporary mock: the widget says so, so sample values are never mistaken for real analytics. */
  sampleData?: boolean
}

/** Measures the element an instance is attached to (a callback ref, so it
 * also works for an element that mounts later). Whole pixels; `null` until measured. */
function useElementSize() {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)

  useEffect(() => {
    if (!element) return
    const read = (width: number, height: number) => setSize({ width: Math.floor(width), height: Math.floor(height) })
    const rect = element.getBoundingClientRect()
    read(rect.width, rect.height)
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box) read(box.width, box.height)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])

  return { size, ref: useCallback((node: HTMLDivElement | null) => setElement(node), []) }
}

/** The live Dashboard's comparison widget -- the production mount of
 * the `ComparisonChart` (data, series/legend/tooltip order, and the
 * loading/error/empty/unavailable states) plus an ordered creator list that
 * exposes comparison order to assistive technology. The same
 * `comparison.creatorIds` array drives the list, the request, the series,
 * the legend and the tooltip; nothing here sorts it. All content is derived
 * from the widget's own (draft or canonical) config, so a loading or failed
 * request can never erase it. */
export function ComparisonWidget({ widget, roster, availableComparisonItems, fetchComparisonData, onSelectCreators, sampleData = false }: ComparisonWidgetProps) {
  const creatorIds = widget.comparison?.creatorIds
  const comparisonItemId = widget.comparison?.comparisonItemIds[0]
  const creators = useMemo(() => resolveComparisonCreators(creatorIds ?? [], roster), [creatorIds, roster])
  const itemLabel = availableComparisonItems.find((item) => item.comparisonItemId === comparisonItemId)?.label ?? comparisonItemId
  const { size, ref } = useElementSize()

  return (
    <div className="comparison-widget" data-testid="comparison-widget" data-widget-id={widget.widgetId} data-comparison-item-id={comparisonItemId}>
      <div className="comparison-widget__header">
        <span className="comparison-widget__title">{itemLabel ? `${itemLabel} comparison` : "Creator comparison"}</span>
        {creators.length > 0 && (
          <ol className="comparison-widget__creators" aria-label="Comparison creators in order" data-testid="comparison-widget-creators">
            {creators.map((creator, index) => (
              <li key={creator.channelId} className="comparison-widget__creator" data-creator-id={creator.channelId}>
                <span className="comparison-widget__creator-name">{creator.channelName}</span>
                <span className="comparison-widget__creator-order">
                  <ComparisonOrderBadge order={index + 1} />
                </span>
              </li>
            ))}
          </ol>
        )}
        {sampleData && (
          <span className="comparison-widget__sample" data-testid="comparison-widget-sample-data" title="Temporary sample data: no comparison backend exists yet.">
            Sample data
          </span>
        )}
        {onSelectCreators && (
          <Button className="comparison-widget__select" onClick={() => onSelectCreators(widget.widgetId)}>
            Select Creators
          </Button>
        )}
      </div>
      <div ref={ref} className="comparison-widget__chart">
        {comparisonItemId === undefined || creators.length === 0 ? (
          <p className="comparison-widget__hint" data-testid="comparison-widget-unconfigured">
            {creators.length === 0 ? "No creators selected yet." : "No comparison item selected."}
          </p>
        ) : availableComparisonItems.length === 0 || size === null ? null : (
          <ComparisonChart
            creators={creators}
            comparisonItemId={comparisonItemId}
            availableComparisonItems={availableComparisonItems}
            width={size.width}
            height={Math.max(size.height, 1)}
            fetchComparisonData={fetchComparisonData}
          />
        )}
      </div>
    </div>
  )
}
