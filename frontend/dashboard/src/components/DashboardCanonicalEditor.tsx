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
 */
import { computeWidgetPixelRect, type GridPixelConfig } from "../lib/dashboardSpacing"
import { useDashboardEditor } from "../hooks/useDashboardEditor"
import { EditModeToolbar } from "./EditModeToolbar"
import { GridChangeConfirmationDialog } from "./GridChangeConfirmationDialog"
import type { CanonicalLayout } from "../types/dashboardLayout"

export interface DashboardCanonicalEditorProps {
  layout: CanonicalLayout
  /** Pixel size per grid unit for rendering only -- a placement detail, not
   * a visual-design decision; MT-07 owns box/guide geometry correctness,
   * not final visual polish. */
  gridPixelConfig?: GridPixelConfig
  /** MT-09's production save/submission boundary (Section 8, AC5/AC6/AC11).
   * No backend endpoint or persistence strategy exists yet for the
   * canonical model (see `dashboardLayoutSave.ts`'s module docstring), so
   * this is left to whoever integrates this component into production
   * (MT-15's persistence ownership, or GAP-5's live integration) to
   * supply. Omitting it defaults to a function that rejects loudly rather
   * than silently appearing to persist anything. */
  submitSave?: (layout: CanonicalLayout) => Promise<void>
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
export function CanonicalWidgetGrid({ layout, editMode, gridPixelConfig = DEFAULT_GRID_PIXEL_CONFIG, insertionCandidateId = null }: CanonicalWidgetGridProps) {
  return (
    <div data-testid="canonical-widget-grid" style={{ position: "relative" }}>
      {layout.widgets.map((widget) => {
        const rect = computeWidgetPixelRect(widget, gridPixelConfig)
        const isInsertionCandidate = widget.widgetId === insertionCandidateId
        return (
          <div
            key={widget.widgetId}
            data-testid="canonical-widget-box"
            data-widget-id={widget.widgetId}
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
      })}
    </div>
  )
}

export function DashboardCanonicalEditor({ layout: initialLayout, gridPixelConfig, submitSave }: DashboardCanonicalEditorProps) {
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
  } = useDashboardEditor(initialLayout, submitSave)
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
      />

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
