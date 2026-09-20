import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { GridStack, type GridItemHTMLElement } from "gridstack"
import "gridstack/dist/gridstack.css"
import { X } from "lucide-react"
import { useDroppable } from "@dnd-kit/core"
import type { WidgetTypeId } from "../model/widget"
import { renderWidget, type DashboardWidgetData } from "../utils/widgetRegistry"
import { getGridWidgetMeta, type GridWidgetInstance, type GridWidgetType } from "../utils/gridWidgetMeta"
import { COMPARISON_WIDGET_TYPE } from "../../comparison/utils/dashboardComparisonWidgets"
import {
  GRIDSTACK_ROW_SCALE,
  gridStackNodeToCanonicalCandidate,
  minGridStackHeightForAllowedHeights,
} from "../utils/gridStackGeometryAdapter"
import type { WidgetHeight } from "../model/dashboardLayout"

interface DashboardGridProps {
  widgets: GridWidgetInstance[]
  /** Renders one comparison-type widget's content (its chart and its
   * edit-mode actions), given its `widgetId`. Comparison widgets carry
   * per-widget config the page-level `data` does not, so their content comes
   * from the caller; when omitted a comparison widget renders empty. */
  renderComparisonWidget?: (widgetId: string) => ReactNode
  /** The GridStack `column` count to render at -- the canonical
   * grid's own column count (1-3), never the legacy hardcoded `12`. GridStack
   * accepts any positive integer here; syncing it to the canonical grid is
   * what makes a canonical `width` render at its real proportion of the row
   * instead of a sliver of an unrelated 12-column track. */
  columns: number
  editable: boolean
  data: DashboardWidgetData
  /** The canonical geometry-commit boundary. Called once a pointer
   * gesture (drag or resize) finishes, with the manipulated widget's final
   * geometry already translated to canonical units. Returns whether the
   * caller's canonical validation committed it -- `false` tells this
   * component to roll its own GridStack visual node back (see
   * `handleGestureEnd`). Never called for constraint-driven movement of any
   * other, non-manipulated widget. */
  onCommitGeometry: (widgetId: string, patch: { x: number; y: number; width: number; height: WidgetHeight }) => boolean
  onRemoveWidget: (instanceId: string) => void
  /** Pure canonical validity check for a live drag/resize gesture,
   * called on every GridStack `drag`/`resize` tick with the same
   * candidate conversion `onCommitGeometry` uses at gesture end. Never
   * commits -- only reports whether the current tentative geometry would be
   * accepted against the authoritative draft, so this component can show a
   * non-color valid/invalid state before the drop. */
  validateGesturePreview: (widgetId: string, patch: { x: number; y: number; width: number; height: WidgetHeight }) => boolean
  /** Reports a human-readable description of a commit or rollback
   * outcome for the page's shared assistive-technology live region. Called
   * exactly once per `dragstop`/`resizestop`, only for the widget actually
   * manipulated (never for a neighbor shifted as a side effect). */
  onAnnounce: (message: string) => void
  /** The id of an Add candidate whose geometry is being *previewed*
   * (never committed). It is a real GridStack node in `widgets` -- so it
   * gets exactly the geometry, margins and reflow a committed widget would --
   * but renders a preview-only shell instead of the chart, with no Remove. */
  placeholderWidgetId?: string | null
  /** While true, the geometry on screen is preview geometry rather
   * than the authoritative draft, so drag/resize (GridStack static) and
   * Remove are disabled -- no gesture can write preview coordinates back. */
  locked?: boolean
}

interface DroppableShellProps {
  widgetId: string
  type: GridWidgetType
  editable: boolean
  className: string
  ariaInvalid: boolean
  children: ReactNode
}

/** Every widget shell is a `@dnd-kit/core` drop target
 * for a creator dragged out of the Creator List. Only a comparison chart is a
 * compatible target ("active"); any other widget shows a disabled target. The
 * state is a visible label plus border *style*, never color alone (Guidelines
 * Section 0.2). The indicator is an absolutely positioned overlay, so it adds
 * no geometry. Outside a `DndContext` (or when not editing) this is inert. */
function DroppableShell({ widgetId, type, editable, className, ariaInvalid, children }: DroppableShellProps) {
  const { setNodeRef, isOver } = useDroppable({ id: widgetId })
  const dropState = editable && isOver ? (type === COMPARISON_WIDGET_TYPE ? "active" : "disabled") : undefined
  return (
    <div ref={setNodeRef} className={className} aria-invalid={ariaInvalid ? "true" : undefined} data-drop-state={dropState}>
      {dropState && (
        <div data-testid="drop-indicator" className={`drop-indicator drop-indicator--${dropState}`}>
          {dropState === "active" ? "Drop to compare" : "Not a comparison chart"}
        </div>
      )}
      {children}
    </div>
  )
}

/** Renders widget instances on a GridStack-managed grid: GridStack owns
 * position/size/drag/resize (mouse-first, per the product direction — no
 * keyboard drag alternative for v1), React owns each widget's actual
 * content via a portal into the DOM node GridStack creates for it. Static
 * (locked) outside Edit Layout mode; draggable/resizable inside it.
 *
 * Geometry
 * commit ownership moved from the aggregate `"change"` event (which fires
 * for both direct user gestures and constraint-driven repositioning of
 * *other* widgets, and can report several nodes at once -- see
 * gridstack.d.ts's own doc comment) to the per-element `dragstop`/
 * `resizestop` events, each reporting exactly the one widget the user
 * actually manipulated (`el.gridstackNode`). `"change"` is no longer
 * subscribed to at all, so a neighbor GridStack repositions during someone
 * else's drag can never reach `onCommitGeometry`. `syncGridToCurrentWidgets`
 * (the same `grid.load()` call this component already made on every
 * `widgets` prop change) is now also invoked directly after a rejected
 * gesture, since a rejected canonical patch leaves `draftLayout` referentially
 * unchanged (`useDashboardEditor.updateDraftWidget`'s own doc comment) and
 * React therefore never re-renders this component with new props for that
 * case -- without this explicit call, GridStack's mid-drag DOM position
 * would never be corrected. Reloading the *entire* current widget list (not
 * just the manipulated one) on every resync, exactly as the existing
 * `[widgets, columns]` effect below already does, is what discards any
 * neighbor GridStack shifted as a side effect of the gesture: that neighbor's
 * canonical geometry was never submitted (only the manipulated widget's was),
 * so reloading everyone from the current canonical projection always wins.
 */
export function DashboardGrid({
  widgets,
  columns,
  editable,
  data,
  renderComparisonWidget,
  onCommitGeometry,
  onRemoveWidget,
  validateGesturePreview,
  onAnnounce,
  placeholderWidgetId = null,
  locked = false,
}: DashboardGridProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<GridStack | null>(null)
  const [contentNodes, setContentNodes] = useState<Record<string, HTMLElement>>({})
  // The widget currently mid-gesture and whether its tentative
  // geometry currently validates -- `null` whenever no gesture is active.
  const [gesturePreview, setGesturePreview] = useState<{ widgetId: string; valid: boolean } | null>(null)

  // Mirrors of the latest props, read by the mount-once GridStack event
  // handlers below (a `useEffect(..., [])` closure would otherwise always
  // see the very first render's `widgets`/`columns`/`onCommitGeometry`).
  const widgetsRef = useRef(widgets)
  const columnsRef = useRef(columns)
  const onCommitGeometryRef = useRef(onCommitGeometry)
  const validateGesturePreviewRef = useRef(validateGesturePreview)
  const onAnnounceRef = useRef(onAnnounce)

  /** Reloads every current widget's geometry from `widgetsRef`/`columnsRef`
   * into GridStack and re-queries each widget's content portal target.
   * Stable identity ([] deps, reads only refs) so it can be called both from
   * the props-driven effect below and from a mount-once gesture handler. */
  const syncGridToCurrentWidgets = useCallback(() => {
    const grid = gridRef.current
    if (!grid) return
    if (grid.getColumn() !== columnsRef.current) grid.column(columnsRef.current)

    grid.load(
      widgetsRef.current.map((w) => {
        // The legacy sizeLimits.minH/minW (widgetRegistry.tsx) were
        // authored for the old 12-column/arbitrary-height model and do not
        // correspond to canonical GRIDSTACK_ROW_SCALE units -- see
        // minGridStackHeightForAllowedHeights's own doc comment. No
        // canonical minW concept exists, so minW is intentionally omitted.
        const { allowedHeights } = getGridWidgetMeta(w.type)
        return { id: w.instanceId, x: w.x, y: w.y, w: w.w, h: w.h, minH: minGridStackHeightForAllowedHeights(allowedHeights) }
      }),
    )

    const nodes: Record<string, HTMLElement> = {}
    for (const widget of widgetsRef.current) {
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
  }, [])

  useEffect(() => {
    if (!containerRef.current) return
    const grid = GridStack.init(
      {
        column: columnsRef.current,
        margin: 8,
        cellHeight: 90,
        float: true,
        staticGrid: !editable,
      },
      containerRef.current,
    )
    gridRef.current = grid

    /** Fires on every `drag`/`resize` tick (before drop) with the
     * same candidate conversion `handleGestureEnd` uses, but only
     * asks the caller's pure validator whether that tentative geometry
     * would be accepted -- never calls `onCommitGeometry`, so no draft
     * state is ever touched by a preview tick (AC8). */
    function handleGestureMove(_event: Event, el: GridItemHTMLElement) {
      const node = el.gridstackNode
      const widgetId = node?.id
      if (!node || widgetId == null) return
      const current = widgetsRef.current.find((w) => w.instanceId === widgetId)
      if (!current) return

      const candidate = gridStackNodeToCanonicalCandidate(
        { x: node.x ?? current.x, y: node.y ?? current.y, w: node.w ?? current.w, h: node.h ?? current.h },
        widgetId,
        current.type,
      )
      const valid = validateGesturePreviewRef.current(widgetId, {
        x: candidate.x,
        y: candidate.y,
        width: candidate.width,
        height: candidate.height,
      })
      setGesturePreview({ widgetId, valid })
    }

    /** Shared final handler for both a completed drag and a
     * completed resize -- both events report the single manipulated
     * widget's final geometry the same way (`el.gridstackNode`), and both
     * commit through the same canonical patch/rollback path (a
     * resize-from-a-top/left-handle changing `x`/`y` alongside `w`/`h` is
     * just a patch whose position fields happen to differ from before;
     * `updateWidgetGeometry` accepts all four in one call either way). */
    function handleGestureEnd(_event: Event, el: GridItemHTMLElement) {
      setGesturePreview(null)
      const node = el.gridstackNode
      const widgetId = node?.id
      if (!node || widgetId == null) return
      const current = widgetsRef.current.find((w) => w.instanceId === widgetId)
      if (!current) return

      const candidate = gridStackNodeToCanonicalCandidate(
        { x: node.x ?? current.x, y: node.y ?? current.y, w: node.w ?? current.w, h: node.h ?? current.h },
        widgetId,
        current.type,
      )
      const committed = onCommitGeometryRef.current(widgetId, {
        x: candidate.x,
        y: candidate.y,
        width: candidate.width,
        height: candidate.height,
      })

      // Exactly one announcement per gesture, derived only
      // from this call's own committed outcome for the widget actually
      // manipulated -- never inferred merely from the event having fired.
      // A gesture GridStack's own constraints (e.g. minH) already prevented
      // from producing any tentative geometry at all still reaches
      // dragstop/resizestop with the widget's unchanged current geometry,
      // which trivially "commits" (a no-op patch is always valid) -- `moved`
      // is skipped for that case so nothing is announced when nothing
      // actually happened.
      const title = getGridWidgetMeta(current.type).title
      const resized = candidate.width !== current.w || candidate.height !== current.h / GRIDSTACK_ROW_SCALE
      const moved = candidate.x !== current.x || candidate.y !== current.y
      if (committed && (resized || moved)) {
        onAnnounceRef.current(
          resized
            ? `${title} resized to ${candidate.width} by ${candidate.height}X, at column ${candidate.x + 1}, row ${candidate.y + 1}.`
            : `${title} moved to column ${candidate.x + 1}, row ${candidate.y + 1}.`,
        )
      } else if (!committed) {
        onAnnounceRef.current(`${title} could not be placed there and returned to its previous position.`)
      }

      // Accepted: the caller's canonical state advanced, this component will
      // re-render with new `widgets`/`columns` props, and the effect below
      // resyncs GridStack from them (also correcting any neighbor drift).
      // Rejected: props won't change (see this module's own doc comment), so
      // resync explicitly here -- reloading every widget from the still-
      // current `widgetsRef`, not just this one, so any neighbor GridStack
      // shifted during the failed gesture is discarded too.
      if (!committed) syncGridToCurrentWidgets()
    }

    if (grid) {
      grid.on("drag", handleGestureMove)
      grid.on("resize", handleGestureMove)
      grid.on("dragstop", handleGestureEnd)
      grid.on("resizestop", handleGestureEnd)
    }

    return () => {
      grid?.destroy(false)
      gridRef.current = null
    }
    // Grid is initialized once; widgets/editable are synced via the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    gridRef.current?.setStatic(!editable || locked)
  }, [editable, locked])

  useEffect(() => {
    onCommitGeometryRef.current = onCommitGeometry
  }, [onCommitGeometry])

  useEffect(() => {
    validateGesturePreviewRef.current = validateGesturePreview
  }, [validateGesturePreview])

  useEffect(() => {
    onAnnounceRef.current = onAnnounce
  }, [onAnnounce])

  useEffect(() => {
    widgetsRef.current = widgets
    columnsRef.current = columns
    syncGridToCurrentWidgets()
  }, [widgets, columns, syncGridToCurrentWidgets])

  return (
    <div className="dashboard-grid-v2">
      <div ref={containerRef} className="grid-stack" />
      {widgets.map((widget) => {
        const node = contentNodes[widget.instanceId]
        if (!node) return null
        // `gestureValid` is `null` whenever this widget isn't the one
        // currently mid-gesture (the common case), `true`/`false` only for
        // the single manipulated widget between its first `drag`/`resize`
        // tick and the matching `dragstop`/`resizestop`.
        const gestureValid = gesturePreview?.widgetId === widget.instanceId ? gesturePreview.valid : null
        const shellClassName = [
          "widget-shell",
          editable && "widget-shell--editing",
          gestureValid === true && "widget-shell--gesture-valid",
          gestureValid === false && "widget-shell--gesture-invalid",
        ]
          .filter(Boolean)
          .join(" ")
        if (widget.instanceId === placeholderWidgetId) {
          return createPortal(
            <div className={`${shellClassName} widget-shell--insertion-placeholder`} data-testid="insertion-placeholder" aria-hidden="true">
              New {getGridWidgetMeta(widget.type).title} (preview)
            </div>,
            node,
            widget.instanceId,
          )
        }
        return createPortal(
          <DroppableShell
            widgetId={widget.instanceId}
            type={widget.type}
            editable={editable}
            className={shellClassName}
            ariaInvalid={gestureValid === false}
          >
            {editable && (
              <button
                type="button"
                className="widget-shell__remove"
                disabled={locked}
                onClick={() => onRemoveWidget(widget.instanceId)}
                aria-label={`Remove ${getGridWidgetMeta(widget.type).title}`}
              >
                <X size={14} aria-hidden="true" />
              </button>
            )}
            <div className="widget-shell__body">
              {widget.type === COMPARISON_WIDGET_TYPE ? renderComparisonWidget?.(widget.instanceId) : renderWidget(widget.type as WidgetTypeId, data)}
            </div>
          </DroppableShell>,
          node,
          widget.instanceId,
        )
      })}
    </div>
  )
}
