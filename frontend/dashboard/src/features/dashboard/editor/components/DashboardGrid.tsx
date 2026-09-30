import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { GridStack, type GridItemHTMLElement } from "gridstack"
import "gridstack/dist/gridstack.css"
import { Button } from "antd"
import { X } from "lucide-react"
import { useDroppable } from "@dnd-kit/core"
import type { WidgetTypeId } from "../model/widget"
import { renderWidget, supportsCreatorScope, type DashboardWidgetData } from "../utils/widgetRegistry"
import { getGridWidgetMeta, type GridWidgetInstance, type GridWidgetType } from "../utils/gridWidgetMeta"
import {
  GRIDSTACK_ROW_SCALE,
  gridStackNodeToCanonicalCandidate,
  minGridStackHeightForAllowedHeights,
} from "../utils/gridStackGeometryAdapter"
import type { WidgetHeight } from "../model/dashboardLayout"

interface DashboardGridProps {
  widgets: GridWidgetInstance[]
  /** The GridStack `column` count to render at -- the canonical
   * grid's own column count (1-3), never the legacy hardcoded `12`. GridStack
   * accepts any positive integer here; syncing it to the canonical grid is
   * what makes a canonical `width` render at its real proportion of the row
   * instead of a sliver of an unrelated 12-column track. */
  columns: number
  /** Canonical row boundary. GridStack must never grow the document while
   * a pointer approaches the bottom edge of Edit Mode. */
  rows: number
  editable: boolean
  data: DashboardWidgetData
  getWidgetData?: (widgetId: string) => DashboardWidgetData
  getWidgetScopeLabels?: (widgetId: string) => string[]
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
  scopeLabels?: string[]
}

/** Every widget shell is a `@dnd-kit/core` drop target
 * for a creator dragged out of the Creator List. Any `supportsCreatorScope`
 * widget is a compatible target ("active"); any other widget shows a
 * disabled target. The state is a visible label plus border *style*, never
 * color alone (Guidelines Section 0.2). The indicator is an absolutely
 * positioned overlay, so it adds no geometry. Outside a `DndContext` (or
 * when not editing) this is inert. */
function DroppableShell({ widgetId, type, editable, className, ariaInvalid, scopeLabels = [], children }: DroppableShellProps) {
  const { setNodeRef, isOver, active } = useDroppable({ id: widgetId })
  const compatible = supportsCreatorScope(type)
  const dropState = editable && active ? (compatible ? (isOver ? "active" : "ready") : "disabled") : undefined
  return (
    <div ref={setNodeRef} className={className} aria-invalid={ariaInvalid ? "true" : undefined} data-drop-state={dropState}>
      {dropState && (
        <div data-testid="drop-indicator" className={`drop-indicator drop-indicator--${dropState}`}>
          {dropState === "active"
            ? "Release to apply members"
            : dropState === "ready"
              ? "Drop members here"
              : "This widget does not support member filters"}
        </div>
      )}
      {scopeLabels.length > 0 && !dropState && (
        <div className="widget-shell__creator-scope" title={scopeLabels.join(", ")}>
          <strong>{scopeLabels.length} member{scopeLabels.length === 1 ? "" : "s"}</strong>
          <span>{scopeLabels.join(", ")}</span>
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
  rows,
  editable,
  data,
  getWidgetData,
  getWidgetScopeLabels,
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
  const rowsRef = useRef(rows)
  const onCommitGeometryRef = useRef(onCommitGeometry)
  const validateGesturePreviewRef = useRef(validateGesturePreview)
  const onAnnounceRef = useRef(onAnnounce)

  /** Reloads every current widget's geometry from `widgetsRef`/`columnsRef`
   * into GridStack and re-queries each widget's content portal target. Does
   * NOT reset the GridStack engine for an ordinary sync (see the
   * `columnChanging` comment below) -- a widget whose id was already in the
   * engine keeps its existing DOM/portal target, so its React subtree stays
   * mounted (state, focus) across a sync its own geometry wasn't part of.
   * Stable identity ([] deps, reads only refs) so it can be called both from
   * the props-driven effect below and from a mount-once gesture handler. */
  const syncGridToCurrentWidgets = useCallback(() => {
    const grid = gridRef.current
    if (!grid) return
    // Only reset the engine (removeAll) when the column count is actually
    // changing. Read BEFORE load() -- load() never touches the engine's own
    // column count, so this stays valid for the grid.column() call below too.
    //
    // GridStack's own load() (gridstack.js's `load()`) already diffs by id:
    // for a node whose id is still present in `this.engine.nodes`, it calls
    // `this.update(item.el, w)`, reusing that EXISTING DOM element (and so
    // the React portal target already mounted into it) -- only a node whose
    // id is NOT found goes through `addWidget()`, which creates a fresh one
    // (confirmed by reading gridstack.js's own `load()` source, not
    // assumed). `removeAll(true)` empties `engine.nodes` first, so every
    // widget's id fails that lookup on the very next load() -- every widget,
    // changed or not, gets a brand-new DOM/portal target, remounting its
    // whole React subtree (resetting widget-local state, dropping focus from
    // any control inside it). This was firing on EVERY sync, including ones
    // where no widget's geometry actually changed (e.g. a responsive
    // reprojection that keeps the same column count, or the resync after a
    // gesture GridStack itself rejected).
    //
    // Changing the column count while GridStack's engine still holds the
    // PREVIOUS layout's nodes (each still at its old x/y, potentially now
    // out of range for the new column count -- e.g. x=2 in what is about to
    // become a 2-column grid) makes `column()`/the following `load()` each
    // try to resolve collisions against those stale, out-of-range
    // positions. For some column-count/node combinations (confirmed:
    // reflowing this component's own widgets to fewer columns), that
    // resolution drives GridStack's internal collision engine
    // (`_fixCollisions`/`moveNode`) into infinite mutual-recursion --
    // node A's move displaces node B, whose own resulting move displaces A
    // again, forever -- crashing this entire component with an uncaught
    // RangeError (GridStack's own "Infinite collide check" counter only
    // guards looping *within* one `_fixCollisions` call, not this
    // recursion across separate `moveNode`/`_fixCollisions` calls). That
    // precondition (stale out-of-range positions) only exists when the
    // column count is changing -- at an unchanged column count, every
    // existing node's x/y is already valid, so load()'s own reuse path
    // above is safe and this reset is not needed. Removing every node (DOM
    // included -- `load()` immediately recreates each one fresh from this
    // function's own `widgetsRef`, so nothing is ever actually lost) first
    // means the column change and the reload below both start from a
    // genuinely empty engine -- nothing stale left to collide with -- so
    // this is not a workaround for a transient symptom, it removes the
    // actual precondition (stale out-of-range nodes) the recursion depends
    // on, scoped to only the case that precondition can occur in.
    const columnChanging = grid.getColumn() !== columnsRef.current
    if (columnChanging) grid.removeAll(true)
    // `updateOptions`, not a direct `grid.opts.maxRow = ...` assignment --
    // GridStack's own engine keeps its own separate `maxRow` copy
    // (confirmed: assigning `opts.maxRow` directly leaves `engine.maxRow`
    // untouched, so the engine kept enforcing whichever `maxRow` was set at
    // `GridStack.init` time, from this component's very first render,
    // forever after). Every reflow that needs MORE rows than that stale
    // value silently clipped the widget(s) that only fit in the extra
    // row(s), which GridStack then placed by falling back to overlapping
    // an existing widget instead of rejecting the placement outright.
    grid.updateOptions({ maxRow: rowsRef.current * GRIDSTACK_ROW_SCALE })

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
    // Changing the column count AFTER `load()`, not before: every widget
    // above was already loaded at its final x/y for `columnsRef.current`
    // (the caller -- DashboardPage.tsx's projection -- already reflows
    // widgets to fit whatever column count is coming), so by the time this
    // runs every node already fits the new column count and 'none' has
    // nothing to relayout. Doing this the other way around (`column()`
    // then `load()`) fed `load()`'s own per-node placement through a grid
    // already mid-transition to the new column count, which corrupted
    // later nodes' positions (confirmed: a node's correct, non-overlapping
    // `y` was silently dropped back to 0). Reuses `columnChanging` from
    // above rather than re-reading `grid.getColumn()`: load() never changes
    // the engine's own column count, so the value read before it still
    // holds.
    if (columnChanging) grid.column(columnsRef.current, "none")

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
        // Raised from 90: at 90, a 1X widget's usable body height (164px)
        // clipped the default kpi-summary/contribution-ring/ranking widgets'
        // real content, forcing an internal scrollbar (Defect A). 180 gives
        // enough room for the tallest default 1X widget's content with no
        // scroll, measured directly against the rendered page rather than
        // assumed. This is a pixel-per-canonical-row-unit constant, not a
        // canonical grid/height value -- 1X/0.5X and the 1x1-3x3 grid
        // contract are unchanged.
        cellHeight: 180,
        float: true,
        maxRow: rowsRef.current * GRIDSTACK_ROW_SCALE,
        draggable: { scroll: false },
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
    rowsRef.current = rows
    syncGridToCurrentWidgets()
  }, [widgets, columns, rows, syncGridToCurrentWidgets])

  return (
    <div className="dashboard-grid-v2">
      {editable && (
        <div
          className="dashboard-grid-v2__slot-guides"
          data-testid="grid-slot-guides"
          aria-hidden="true"
          style={{
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, 360px)`,
          }}
        >
          {Array.from({ length: columns * rows }, (_, index) => (
            <span key={index} />
          ))}
        </div>
      )}
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
            scopeLabels={getWidgetScopeLabels?.(widget.instanceId)}
          >
            {editable && (
              <Button
                className="widget-shell__remove"
                shape="circle"
                size="small"
                disabled={locked}
                onClick={() => onRemoveWidget(widget.instanceId)}
                aria-label={`Remove ${getGridWidgetMeta(widget.type).title}`}
                icon={<X size={14} aria-hidden="true" />}
              />
            )}
            <div className="widget-shell__body">
              {renderWidget(widget.type as WidgetTypeId, getWidgetData?.(widget.instanceId) ?? data)}
            </div>
          </DroppableShell>,
          node,
          widget.instanceId,
        )
      })}
    </div>
  )
}
