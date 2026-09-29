/** MT-07 "Editor Shell and Draft Isolation"
 * (frontend/dashboard/DASHBOARD_LAYOUT_GUIDELINES.md, Section 6).
 *
 * The first production renderer for the canonical (MT-01) layout model:
 * keys every widget by `widgetId` (AC13, the criterion MT-02 could only
 * establish as a state-layer invariant), renders the dashed edit-mode
 * guide as a geometry-neutral overlay reusing MT-06's canonical
 * `computeWidgetPixelRect` (never a second geometry calculation), and
 * reuses the existing `EditModeToolbar` -- already a plain
 * boolean/callback component with no dependency on the legacy
 * `WidgetInstance`/GridStack model -- for Edit/Save/Cancel/Restore
 * Default, per Guidelines Section 0's "reuse an existing project shared
 * component" rule.
 *
 * Deliberately not wired into `DashboardPage.tsx`: that page still runs
 * the legacy GridStack `useEditableLayout` system, and MT-07's Goal/
 * Acceptance Criteria never reference migrating it. Wiring a second,
 * canonical-model UI into the same page next to the legacy one would
 * create exactly the "silent hybrid" the current task guidance warns
 * against; that migration is not owned by any microtask yet. This
 * component only renders each widget's own box -- it does not render
 * chart content, since MT-07 owns editor shell/draft isolation, not chart
 * rendering, and does not call `useChartCatalog` (see GAP-1 in
 * DASHBOARD_LAYOUT_IMPLEMENTATION_TASKS.md's MT-04 section, which this
 * document's current text still records as unresolved and not assigned
 * to MT-07).
 *
 * MT-15 "Persistence, Legacy Layout, and Reload" supplies this component's
 * actual load/save persistence: `layout`/`submitSave` are still accepted
 * explicitly (tests and fixtures keep using them exactly as before), but
 * when omitted, the initial layout is loaded once via
 * `loadInitialCanonicalLayout` (AC2's production load path) and `save()`
 * persists through `createLocalCanonicalLayoutSubmit` -- the same
 * `dashboardCanonicalLayoutStore.ts` module, not a second implementation.
 * This is still deliberately not wired into `DashboardPage.tsx` (the note
 * above); MT-15 only supplies this component's own load/save boundary.
 *
 * MT-16 "Responsive and Accessibility Verification" wires `useBreakpoint`
 * (the same reactive viewport hook `useEditableLayout.ts` already uses) and
 * `reflowLayoutForBreakpoint` (dashboardResponsive.ts) into
 * `CanonicalWidgetGrid`'s own rendering: each widget's pixel `rect` is
 * computed from its *reflowed* geometry for the current breakpoint, while
 * the `widget` object passed to `CanonicalWidgetBox` (identity, keyboard
 * move/resize, comparison config) stays the real canonical/draft widget.
 * Resizing the viewport therefore changes what actually renders, not just
 * what a pure function returns in isolation -- this is what makes AC3
 * ("every supported breakpoint") a real, browser-observable behavior
 * instead of only an unwired arithmetic proof. `jsdom`'s default
 * `window.innerWidth` (1024) resolves to `"desktop"`, under which
 * `reflowLayoutForBreakpoint` returns the layout unchanged -- so this
 * wiring does not change any existing jsdom test's rendered geometry.
 */
import { useState, type KeyboardEvent } from "react"
import { computeWidgetPixelRect, type GridPixelConfig } from "../utils/dashboardSpacing"
import { useDashboardEditor } from "../hooks/useDashboardEditor"
import { useBreakpoint } from "../../../../shared/hooks/useBreakpoint"
import { reflowLayoutForBreakpoint } from "../utils/dashboardResponsive"
import { createLocalCanonicalLayoutSubmit, loadInitialCanonicalLayout } from "../data/dashboardCanonicalLayoutStore"
import { EditModeToolbar } from "./EditModeToolbar"
import { GridChangeConfirmationDialog } from "./GridChangeConfirmationDialog"
import type { CanonicalLayout, DashboardWidget } from "../model/dashboardLayout"
import type { PixelRect } from "../utils/dashboardSpacing"
import type { WidgetPlacement } from "../utils/dashboardWidgetActions"

export interface DashboardCanonicalEditorProps {
  /** When omitted, loaded once via MT-15's `loadInitialCanonicalLayout`
   * (AC2's production load path) instead of a caller-supplied fixture. */
  layout?: CanonicalLayout
  /** Pixel size per grid unit for rendering only -- a placement detail, not
   * a visual-design decision; MT-07 owns box/guide geometry correctness,
   * not final visual polish. */
  gridPixelConfig?: GridPixelConfig
  /** MT-09's production save/submission boundary (Section 8, AC5/AC6/AC11).
   * When omitted, defaults to MT-15's `createLocalCanonicalLayoutSubmit` --
   * the same store `layout` above loads from when it too is omitted -- so
   * Save actually persists rather than rejecting loudly. */
  submitSave?: (layout: CanonicalLayout) => Promise<void>
  /** Storage for the default load/save wiring above only; ignored when both
   * `layout` and `submitSave` are supplied explicitly. Defaults to
   * `window.localStorage`, the same default `dashboardCanonicalLayoutStore.ts`'s
   * own functions already use. Tests inject an isolated in-memory `Storage`. */
  storage?: Storage
}

const DEFAULT_GRID_PIXEL_CONFIG: GridPixelConfig = { columnWidthPx: 320, rowHeightPx: 240 }

export interface CanonicalWidgetGridProps {
  layout: CanonicalLayout
  editMode: boolean
  gridPixelConfig?: GridPixelConfig
  /** MT-08 (Section 7.3): when set, marks that widget's box as the active
   * insertion slot's placeholder ("visibly represented by a placeholder or
   * marker", AC3) instead of the normal dashed edit guide. The candidate is
   * already a real widget entry in `layout.widgets` by the time it's
   * rendered (Section 7.1: preview writes directly into `draftLayout`), so
   * this only changes which marker its existing box gets -- never a second
   * geometry calculation. */
  insertionCandidateId?: string | null
  /** MT-16 AC6 (Section 9/12): a keyboard-accessible equivalent to
   * drag/resize. Reuses `useDashboardEditor`'s existing `updateDraftWidget`
   * -- MT-02's canonical geometry-mutation primitive, already
   * validation-gated by `updateWidgetGeometry` -- rather than a second
   * mutation path; an invalid keyboard move/resize is silently rejected the
   * same way an invalid drag/resize already is. Omit to render widgets
   * without keyboard move/resize (e.g. view mode). */
  onUpdateWidget?: (widgetId: string, patch: Partial<WidgetPlacement>) => void
}

interface CanonicalWidgetBoxProps {
  widget: DashboardWidget
  rect: PixelRect
  editMode: boolean
  isInsertionCandidate: boolean
  onUpdateWidget?: (widgetId: string, patch: Partial<WidgetPlacement>) => void
}

/** MT-16 AC6: Arrow keys move by one grid unit; Shift+Left/Right resizes
 * width by one column; Shift+Up/Down switches height between the two
 * supported values (Section 5.2's `0.5X`/`1X`). Every resulting patch goes
 * through the same validated `onUpdateWidget` (`updateDraftWidget` ->
 * `updateWidgetGeometry` -> `validateLayout`) a mouse drag/resize would use,
 * so an invalid move/resize (overlap, out-of-bounds, unsupported size) is
 * rejected exactly like a rejected drag (MT-05 AC11: "restores the last
 * valid draft coordinates") -- nothing here decides validity itself. */
function handleWidgetKeyDown(event: KeyboardEvent<HTMLDivElement>, widget: DashboardWidget, onUpdateWidget: (widgetId: string, patch: Partial<WidgetPlacement>) => void) {
  switch (event.key) {
    case "ArrowLeft":
      event.preventDefault()
      onUpdateWidget(widget.widgetId, event.shiftKey ? { width: Math.max(1, widget.width - 1) } : { x: widget.x - 1 })
      return
    case "ArrowRight":
      event.preventDefault()
      onUpdateWidget(widget.widgetId, event.shiftKey ? { width: widget.width + 1 } : { x: widget.x + 1 })
      return
    case "ArrowUp":
      event.preventDefault()
      onUpdateWidget(widget.widgetId, event.shiftKey ? { height: 0.5 } : { y: widget.y - 1 })
      return
    case "ArrowDown":
      event.preventDefault()
      onUpdateWidget(widget.widgetId, event.shiftKey ? { height: 1 } : { y: widget.y + 1 })
      return
  }
}

function CanonicalWidgetBox({
  widget,
  rect,
  editMode,
  isInsertionCandidate,
  onUpdateWidget,
}: CanonicalWidgetBoxProps) {
  // MT-16 AC6: only interactive while editing and only when a caller wired
  // up the mutation callback.
  const keyboardMoveResizeEnabled = editMode && !isInsertionCandidate && onUpdateWidget !== undefined

  return (
    <div
      data-testid="canonical-widget-box"
      data-widget-id={widget.widgetId}
      tabIndex={keyboardMoveResizeEnabled ? 0 : undefined}
      aria-label={keyboardMoveResizeEnabled ? `${widget.widgetType} widget. Use arrow keys to move, Shift+arrow keys to resize.` : undefined}
      onKeyDown={keyboardMoveResizeEnabled ? (event) => handleWidgetKeyDown(event, widget, onUpdateWidget) : undefined}
      style={{
        position: "absolute",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        boxSizing: "border-box",
      }}
    >
      {isInsertionCandidate && (
        <div
          data-testid="insertion-placeholder"
          style={{
            position: "absolute",
            left: "0px",
            top: "0px",
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            boxSizing: "border-box",
            borderStyle: "dashed",
            borderWidth: "1px",
          }}
        />
      )}
      {editMode && !isInsertionCandidate && (
        <div
          data-testid="canonical-edit-guide"
          style={{
            position: "absolute",
            left: "0px",
            top: "0px",
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            boxSizing: "border-box",
            borderStyle: "dashed",
            borderWidth: "1px",
          }}
        />
      )}
    </div>
  )
}

/** The actual production widget-list renderer for the canonical model
 * (AC13): keyed by `widget.widgetId`, never array index, so React's
 * reconciliation follows widget identity across any reordering the layout
 * ever undergoes (e.g. MT-08's insertion-slot preview) instead of
 * mismatching a moved widget's DOM node with a different widget's data.
 * Factored out of `DashboardCanonicalEditor` so it can be exercised
 * directly with an arbitrary `layout` prop -- the stateful editor hook
 * intentionally owns its own committed layout once mounted and does not
 * resync it from prop changes, which isn't what AC13 is about anyway. */
export function CanonicalWidgetGrid({
  layout,
  editMode,
  gridPixelConfig = DEFAULT_GRID_PIXEL_CONFIG,
  insertionCandidateId = null,
  onUpdateWidget,
}: CanonicalWidgetGridProps) {
  // MT-16 AC1-AC4 (Section 11): the *rendered pixel position* of every
  // widget reflows with the real viewport; `widget` itself (identity,
  // keyboard move/resize, comparison config) below is still the real
  // canonical/draft object, never the reflowed one -- editing always
  // happens in real grid coordinates regardless of viewport width.
  const breakpoint = useBreakpoint()
  const responsiveLayout = reflowLayoutForBreakpoint(layout, breakpoint)
  const reflowedById = new Map(responsiveLayout.widgets.map((widget) => [widget.widgetId, widget]))

  return (
    <div
      data-testid="canonical-widget-grid"
      data-breakpoint={breakpoint}
      style={{
        position: "relative",
        // MT-16 AC2/AC3 correction: a `position: relative` container with
        // only absolutely-positioned children has no intrinsic size in any
        // real browser (confirmed by real Playwright measurement -- jsdom
        // never computes real box heights, so no prior test caught this).
        // Without an explicit size, "no overflow past the grid boundary"
        // has nothing real to measure against.
        width: responsiveLayout.columns * gridPixelConfig.columnWidthPx,
        height: responsiveLayout.rows * gridPixelConfig.rowHeightPx,
      }}
    >
      {layout.widgets.map((widget) => {
        const rect = computeWidgetPixelRect(reflowedById.get(widget.widgetId) ?? widget, gridPixelConfig)
        const isInsertionCandidate = widget.widgetId === insertionCandidateId
        return (
          <CanonicalWidgetBox
            key={widget.widgetId}
            widget={widget}
            rect={rect}
            editMode={editMode}
            isInsertionCandidate={isInsertionCandidate}
            onUpdateWidget={onUpdateWidget}
          />
        )
      })}
    </div>
  )
}

export function DashboardCanonicalEditor({ layout: layoutProp, gridPixelConfig, submitSave, storage }: DashboardCanonicalEditorProps) {
  // Lazy `useState` initializers run exactly once, on this component's own
  // mount -- the same "fresh page/session" semantics a real reload has, and
  // why a remount (not a prop change) is what re-reads storage (AC1).
  const [initialLayout] = useState(() => layoutProp ?? loadInitialCanonicalLayout(storage))
  const [resolvedSubmitSave] = useState(() => submitSave ?? createLocalCanonicalLayoutSubmit(storage))
  const {
    layout,
    draftLayout,
    editMode,
    isDirty,
    draftValidation,
    enterEditMode,
    cancel,
    restoreDefault,
    save,
    gridChangeConfirmation,
    confirmGridChange,
    cancelGridChangeConfirmation,
    insertionCandidate,
    updateDraftWidget,
  } = useDashboardEditor(initialLayout, resolvedSubmitSave)
  const displayedLayout = editMode ? draftLayout : layout

  return (
    <div className="dashboard-canonical-editor">
      <EditModeToolbar
        editMode={editMode}
        isDirty={isDirty}
        onEnterEditMode={enterEditMode}
        onSave={save}
        onCancel={cancel}
        onResetToDefault={restoreDefault}
        resetToDefaultLabel="Restore Default"
      />

      <CanonicalWidgetGrid
        layout={displayedLayout}
        editMode={editMode}
        gridPixelConfig={gridPixelConfig}
        insertionCandidateId={insertionCandidate?.widgetId}
        onUpdateWidget={updateDraftWidget}
      />

      {/* MT-16 AC11 (Section 12: "Announce the targeted insertion
       * position ... to assistive technology"): the candidate is already
       * a real entry in `draftLayout.widgets` by the time it renders
       * (MT-08's own docstring), so its 1-based position among the
       * currently displayed widgets is the same "position N of M" a
       * sighted user already sees from where the placeholder sits. */}
      <span data-testid="insertion-announcement" className="sr-only" role="status" aria-live="polite">
        {insertionCandidate &&
          (() => {
            const index = displayedLayout.widgets.findIndex((widget) => widget.widgetId === insertionCandidate.widgetId)
            return index === -1 ? null : `Inserting new widget at position ${index + 1} of ${displayedLayout.widgets.length}.`
          })()}
      </span>

      {gridChangeConfirmation && (
        <GridChangeConfirmationDialog
          confirmation={gridChangeConfirmation}
          disabled={!draftValidation.valid}
          onCancel={cancelGridChangeConfirmation}
          onConfirm={confirmGridChange}
        />
      )}
    </div>
  )
}
