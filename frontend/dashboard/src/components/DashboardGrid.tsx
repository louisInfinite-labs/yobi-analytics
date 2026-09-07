import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { GridStack } from "gridstack"
import "gridstack/dist/gridstack.css"
import { X } from "lucide-react"
import type { WidgetInstance } from "../types/widget"
import { getWidgetDefinition, renderWidget, type DashboardWidgetData } from "../lib/widgetRegistry"

interface DashboardGridProps {
  widgets: WidgetInstance[]
  editable: boolean
  data: DashboardWidgetData
  onPositionsChange: (updates: { instanceId: string; x: number; y: number; w: number; h: number }[]) => void
  onRemoveWidget: (instanceId: string) => void
}

/** Renders widget instances on a GridStack-managed grid: GridStack owns
 * position/size/drag/resize (mouse-first, per the product direction — no
 * keyboard drag alternative for v1), React owns each widget's actual
 * content via a portal into the DOM node GridStack creates for it. Static
 * (locked) outside Edit Layout mode; draggable/resizable inside it. */
export function DashboardGrid({ widgets, editable, data, onPositionsChange, onRemoveWidget }: DashboardGridProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<GridStack | null>(null)
  const [contentNodes, setContentNodes] = useState<Record<string, HTMLElement>>({})

  useEffect(() => {
    if (!containerRef.current) return
    const grid = GridStack.init(
      {
        column: 12,
        margin: 8,
        cellHeight: 90,
        float: true,
        staticGrid: !editable,
      },
      containerRef.current,
    )
    gridRef.current = grid

    if (grid) {
      grid.on("change", (_event, nodes) => {
        const updates = nodes
          .filter((n): n is typeof n & { id: string; x: number; y: number; w: number; h: number } => n.id != null)
          .map((n) => ({ instanceId: n.id, x: n.x ?? 0, y: n.y ?? 0, w: n.w ?? 1, h: n.h ?? 1 }))
        if (updates.length > 0) onPositionsChange(updates)
      })
    }

    return () => {
      grid?.destroy(false)
      gridRef.current = null
    }
    // Grid is initialized once; widgets/editable are synced via the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    gridRef.current?.setStatic(!editable)
  }, [editable])

  useEffect(() => {
    const grid = gridRef.current
    if (!grid) return

    grid.load(
      widgets.map((w) => {
        const { sizeLimits } = getWidgetDefinition(w.type)
        return { id: w.instanceId, x: w.x, y: w.y, w: w.w, h: w.h, minW: sizeLimits.minW, minH: sizeLimits.minH }
      }),
    )

    const nodes: Record<string, HTMLElement> = {}
    for (const widget of widgets) {
      // CSS.escape, not a raw template literal -- instanceId is a persisted
      // value (layoutStore.ts), so a malformed one containing a quote or
      // bracket would otherwise produce an invalid attribute selector and
      // make querySelector throw, breaking the whole dashboard's render.
      const el = containerRef.current?.querySelector<HTMLElement>(
        `[gs-id="${CSS.escape(widget.instanceId)}"] .grid-stack-item-content`,
      )
      if (el) nodes[widget.instanceId] = el
    }
    setContentNodes(nodes)
  }, [widgets])

  return (
    <div className="dashboard-grid-v2">
      <div ref={containerRef} className="grid-stack" />
      {widgets.map((widget) => {
        const node = contentNodes[widget.instanceId]
        if (!node) return null
        return createPortal(
          <div className="widget-shell">
            {editable && (
              <button
                type="button"
                className="widget-shell__remove"
                onClick={() => onRemoveWidget(widget.instanceId)}
                aria-label={`Remove ${getWidgetDefinition(widget.type).title}`}
              >
                <X size={14} aria-hidden="true" />
              </button>
            )}
            <div className="widget-shell__body">{renderWidget(widget.type, data)}</div>
          </div>,
          node,
          widget.instanceId,
        )
      })}
    </div>
  )
}
