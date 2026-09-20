/** MT-07 "Editor Shell and Draft Isolation"
 * (frontend/dashboard/DASHBOARD_LAYOUT_GUIDELINES.md, Section 6), extended
 * by MT-08 "Widget Insertion-Slot Preview" (Section 7).
 *
 * Owns `draftLayout` isolation for the canonical layout model: entering
 * edit mode clones the current committed layout into an isolated draft,
 * every draft mutation runs through the canonical `validateLayout` (Section
 * 10) via MT-02's `updateWidgetGeometry`, and only an explicit `save()`
 * ever replaces the committed layout. `cancel()` and `restoreDefault()`
 * touch only the draft.
 *
 * No network/persistence call exists anywhere in this hook -- `save()` is
 * an in-memory "editor state commit," not a "persistent storage write."
 * Confirmation-gating a forced geometry change and the actual save request
 * are MT-09's ("Grid-Change Confirmation and Atomic Save") job, not this
 * hook's; `save()` here simply commits a validated draft to local state so
 * a later microtask has something to wrap a confirmation/request around.
 *
 * GAP-1 (mounting a chart-catalog loader at a production boundary) is not
 * implemented here: the current `DASHBOARD_LAYOUT_IMPLEMENTATION_TASKS.md`
 * does not assign that ownership to MT-07 (see MT-04's "Production
 * integration ownership gaps" -- GAP-1 is recorded as unresolved, not
 * silently assigned). This hook does not call `useChartCatalog`.
 *
 * Insertion preview (MT-08) owns only the preview *mechanics*: given a
 * candidate widget (obtained through MT-02's canonical id-creation path,
 * generated once in `beginInsertion` and never regenerated as the preview
 * moves between slots) and a target slot, `previewInsertionAtSlot` writes
 * a validated candidate layout directly into `draftLayout` (Section 7.1:
 * "A and B temporarily become narrower in draftLayout"), remembering the
 * pre-insertion draft in a ref so `cancelInsertion` can restore it exactly.
 * It does not own where the candidate widget type comes from (GAP-2's
 * unresolved canonical Add-widget UI) or a real pointer-drag gesture
 * (GAP-4, also unresolved) -- callers supply `widgetType` and a `slotIndex`
 * directly.
 *
 * MT-09 "Grid-Change Confirmation and Atomic Save" (Section 8) replaces
 * MT-07's placeholder `save()` -- which was always an in-memory commit with
 * no submission concept, by MT-07's own design, "so a later microtask has
 * something to wrap a confirmation/request around" -- with the real
 * confirmation-gated, atomic submission flow: `save()` now checks whether
 * committing the draft would force any *existing* widget to move or resize
 * (`computeAffectedWidgetIds`); if so it opens `gridChangeConfirmation`
 * instead of submitting, and only `confirmGridChange()` -- or a direct
 * `save()` when nothing existing is affected -- calls the single canonical
 * `submitLayoutSave`. This is a deliberate, documented change to MT-07's
 * `save()` behavior (now asynchronous), not a silent one: MT-07's own
 * criteria never specified synchronous timing, only that canonical state
 * isn't mutated before an explicit save.
 *
 * Closes the
 * two gaps that blocked switching DashboardPage.tsx's live state from legacy
 * `useEditableLayout` onto this hook (the chosen architecture) --
 * `removeDraftWidget` (reusing `dashboardWidgetActions.ts`'s new
 * `removeWidget`, the same filter-then-`validateCandidate` shape `addWidget`
 * already uses, not a second removal model) and `addWidgetAtSlot`. Neither
 * is a catalog Add UI or a GridStack wiring change -- both are pure
 * hook-level actions a future caller (of either kind) can call.
 *
 * `addWidgetAtSlot` deliberately does NOT call `beginInsertion` then
 * `previewInsertionAtSlot` back-to-back in one synchronous function body.
 * `previewInsertionAtSlot`'s closure reads the `insertionCandidate` *state*
 * set by `beginInsertion`, and React state updates are not visible
 * synchronously within the same call -- exactly why every existing
 * test above calls them from two separate `act()` blocks. `addWidgetAtSlot`
 * instead composes the same underlying canonical building blocks those two
 * stateful actions already share (`createWidgetId`, `computeRowInsertionPreview`,
 * `validateLayout`) directly, so one synchronous call is correct without
 * depending on `insertionCandidate` state at all. `beginInsertion` /
 * `previewInsertionAtSlot` / `commitInsertion` / `cancelInsertion` are
 * unchanged and remain the live-preview (drag) path.
 *
 * Live canonical state cutover and GridStack pointer wiring:
 * `updateDraftWidget` now returns whether its patch committed. This is the
 * only behavior change to it -- given the same `widgetId`/`patch`, the
 * resulting `draftLayout` is identical to before. The synchronous boolean
 * lets `DashboardGrid.tsx`'s GridStack `dragstop`/`resizestop` handlers
 * decide, in the same tick, whether to roll GridStack's own visual node back
 * to its last valid geometry -- a rejected patch never changes `draftLayout`
 * (same object reference returned), so React's `Object.is` bailout means no
 * re-render (and no prop-driven resync) would otherwise happen for that case.
 */
import { useCallback, useMemo, useRef, useState } from "react"
import { buildDefaultLayout } from "../utils/dashboardDefaultLayout"
import { createWidgetId, removeWidget, updateWidgetGeometry, type WidgetPlacement } from "../utils/dashboardWidgetActions"
import { applyCreatorComparisonSelection } from "../../comparison/utils/dashboardComparisonWidgets"
import { dropCreatorOntoWidget } from "../../comparison/utils/dashboardCreatorDrop"
import { computeRowInsertionPreview, computeValidatedRowInsertion, type InsertionCandidate } from "../utils/dashboardInsertionPreview"
import { computeAffectedWidgetIds, submitLayoutSave } from "../utils/dashboardLayoutSave"
import { validateLayout } from "../utils/dashboardLayoutValidation"
import type { CanonicalLayout, DashboardWidget, GridSize, LayoutValidationResult } from "../model/dashboardLayout"

export interface GridChangeConfirmation {
  currentGrid: GridSize
  targetGrid: GridSize
  affectedWidgetIds: string[]
}

/** Result of one atomic `addWidgetAtSlot` call. `widgetId` is
 * `null` on rejection -- the id was never placed into `draftLayout`, so
 * there is nothing a caller could legitimately do with it. */
export interface AddWidgetAtSlotResult {
  widgetId: string | null
  accepted: boolean
}

/** No production save endpoint (or even a decided localStorage-vs-backend
 * persistence strategy) exists yet for the canonical model -- see this
 * file's module docstring. Failing loud by default means an integration
 * that forgets to supply a real `submitSave` finds out immediately instead
 * of silently appearing to "work." Acknowledgment-only (`Promise<void>`):
 * see `dashboardLayoutSave.ts`'s docstring for why the committed layout is
 * never whatever a `submit` call resolves with. */
function defaultSubmitSave(): Promise<void> {
  return Promise.reject(new Error("useDashboardEditor: no submitSave function was provided"))
}

export interface UseDashboardEditorResult {
  /** The committed/view layout -- unaffected by anything except a successful `save()`. */
  layout: CanonicalLayout
  /** The isolated editing copy; only meaningful while `editMode` is true. */
  draftLayout: CanonicalLayout
  editMode: boolean
  isDirty: boolean
  /** Section 10's canonical validator run continuously against the current draft (AC7). */
  draftValidation: LayoutValidationResult
  enterEditMode: () => void
  /** Discards the draft and restores the pre-edit snapshot (AC9). Sends no save request (AC10). */
  cancel: () => void
  /** Replaces only the draft with a fresh product-defined 2x2 default (AC11). Sends no save request (AC12). */
  restoreDefault: () => void
  /** MT-09's entry point: if committing the draft would force an existing
   * widget to move/resize, opens `gridChangeConfirmation` instead of
   * submitting (AC1); otherwise submits directly through the same
   * validation-gated path `confirmGridChange` uses. */
  save: () => Promise<void>
  /** Non-null only while a grid-change confirmation dialog should be shown (AC1, AC2). */
  gridChangeConfirmation: GridChangeConfirmation | null
  /** The dialog's primary action: submits the draft through `submitLayoutSave`. Disabled by the caller when `!draftValidation.valid` (AC9). */
  confirmGridChange: () => Promise<void>
  /** The dialog's secondary action / closing it: clears the confirmation only -- canonical state and the draft are both left exactly as they were (AC3, AC4). */
  cancelGridChangeConfirmation: () => void
  /** True only while an in-flight `submit` call from `save`/`confirmGridChange` hasn't resolved yet. */
  isSaving: boolean
  /** Set only when the most recent submission was rejected; cleared on the next save attempt. */
  saveError: string | null
  /** Mutates only the draft's geometry for one widget, reusing the
   * canonical mutation primitive (AC8). Returns whether the patch committed
   * (a GridStack pointer-gesture caller needs this synchronously to
   * decide whether to roll its own visual state back). */
  updateDraftWidget: (widgetId: string, patch: Partial<WidgetPlacement>) => boolean
  /** Removes one widget from the draft only, reusing the canonical
   * `removeWidget` (filter + `validateCandidate`, same gate every other
   * draft mutation here uses). Rejected removals (e.g. leaving an
   * unresolvable `INCOMPLETE_COLUMN` gap) leave `draftLayout` unchanged. */
  removeDraftWidget: (widgetId: string) => void
  /** MT-11 Flow 1 (Section 3.4): applies a confirmed creator selection to
   * exactly one compatible widget's draft `comparison.creatorIds`. Never
   * touches `layout` (canonical state) -- the picker's Apply action commits
   * only to the draft, same as every other draft mutation this hook owns. */
  updateDraftWidgetComparison: (widgetId: string, creatorIds: string[]) => void
  /** MT-13 Flow 3 (Section 3.4): appends a dropped creator to exactly one
   * compatible widget's draft `comparison.creatorIds`. Never touches `layout`
   * (canonical state) until the normal Dashboard Save flow runs. */
  updateDraftWidgetByCreatorDrop: (widgetId: string, creatorId: string) => void
  /** Adopts a layout Flow 2's own atomic transaction
   * already persisted as the new committed layout (and its draft baseline).
   * Only meaningful outside edit mode -- Flow 2 is offered in view mode, so
   * it can never discard an unsaved draft. */
  commitExternalLayout: (committed: CanonicalLayout) => void
  /** Non-null only while an insertion preview is active. */
  insertionCandidate: InsertionCandidate | null
  /** Creates a candidate with a stable `widgetId` (MT-02's canonical id-creation path) and snapshots the current draft to restore on cancel. */
  beginInsertion: (widgetType: string) => InsertionCandidate
  /** Computes and, if valid, applies the row-insertion preview for the given target row/slot directly to `draftLayout` (Section 7.1/7.2). Returns whether the slot was accepted; an invalid slot changes no state (AC8). */
  previewInsertionAtSlot: (existingRow: DashboardWidget[], slotIndex: number) => boolean
  /** Leaving the slot or cancelling the drag (Section 7.3): restores the pre-insertion draft and clears the candidate (AC6, AC7). */
  cancelInsertion: () => void
  /** The drop succeeds: keeps the current (already-validated) preview as the draft and clears the candidate. Draft coordinates are identical before and after (AC9). */
  commitInsertion: () => void
  /** A minimal canonical "add by widget type" bridge for a future
   * non-drag Add UI -- an explicit `existingRow`/`slotIndex` target is
   * required (no auto-computed or append-to-end placement); rejects (no
   * draft change, `widgetId: null`) exactly when the equivalent
   * `previewInsertionAtSlot` call would. See this module's own docstring
   * for why this composes `computeRowInsertionPreview`/`validateLayout`
   * directly instead of calling `beginInsertion`/`previewInsertionAtSlot`
   * back-to-back. An optional `candidateWidgetId` lets a caller that
   * already previewed the insertion (DashboardPage's derived Add preview)
   * commit under the same id instead of minting a second one. */
  addWidgetAtSlot: (widgetType: string, existingRow: DashboardWidget[], slotIndex: number, candidateWidgetId?: string) => AddWidgetAtSlotResult
}

export function useDashboardEditor(
  initialLayout: CanonicalLayout,
  submitSave: (layout: CanonicalLayout) => Promise<void> = defaultSubmitSave,
): UseDashboardEditorResult {
  const [layout, setLayout] = useState(initialLayout)
  const [draftLayout, setDraftLayout] = useState(initialLayout)
  const [editMode, setEditMode] = useState(false)

  const draftValidation = useMemo(() => validateLayout(draftLayout), [draftLayout])

  const enterEditMode = useCallback(() => {
    setDraftLayout(layout)
    setEditMode(true)
  }, [layout])

  const cancel = useCallback(() => {
    setDraftLayout(layout)
    setEditMode(false)
  }, [layout])

  const restoreDefault = useCallback(() => {
    setDraftLayout(buildDefaultLayout())
  }, [])

  const [gridChangeConfirmation, setGridChangeConfirmation] = useState<GridChangeConfirmation | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  /** The actual submission (MT-09 AC5, AC6, AC7, AC8, AC11): re-validates
   * through `submitLayoutSave` and only ever replaces `layout` on a
   * committed outcome. Shared by `save` (no confirmation needed) and
   * `confirmGridChange` (confirmation accepted) -- one path, not two. */
  const performSave = useCallback(async () => {
    setIsSaving(true)
    setSaveError(null)
    const outcome = await submitLayoutSave(draftLayout, submitSave)
    setIsSaving(false)
    setGridChangeConfirmation(null)
    if (outcome.committed && outcome.layout) {
      setLayout(outcome.layout)
      setEditMode(false)
      return
    }
    if (outcome.error) setSaveError(outcome.error.message)
  }, [draftLayout, submitSave])

  const save = useCallback(async () => {
    const affectedWidgetIds = computeAffectedWidgetIds(layout, draftLayout)
    if (affectedWidgetIds.length > 0) {
      setGridChangeConfirmation({ currentGrid: layout.grid, targetGrid: draftLayout.grid, affectedWidgetIds })
      return
    }
    await performSave()
  }, [layout, draftLayout, performSave])

  const confirmGridChange = useCallback(async () => {
    await performSave()
  }, [performSave])

  const cancelGridChangeConfirmation = useCallback(() => {
    setGridChangeConfirmation(null)
  }, [])

  const updateDraftWidget = useCallback(
    (widgetId: string, patch: Partial<WidgetPlacement>): boolean => {
      const outcome = updateWidgetGeometry(draftLayout, widgetId, patch)
      if (outcome.committed) setDraftLayout(outcome.layout)
      return outcome.committed
    },
    [draftLayout],
  )

  const removeDraftWidget = useCallback((widgetId: string) => {
    setDraftLayout((current) => removeWidget(current, widgetId).layout)
  }, [])

  const updateDraftWidgetComparison = useCallback((widgetId: string, creatorIds: string[]) => {
    setDraftLayout((current) => applyCreatorComparisonSelection(current, widgetId, creatorIds))
  }, [])

  const updateDraftWidgetByCreatorDrop = useCallback((widgetId: string, creatorId: string) => {
    setDraftLayout((current) => dropCreatorOntoWidget(current, widgetId, creatorId))
  }, [])

  const commitExternalLayout = useCallback((committed: CanonicalLayout) => {
    setLayout(committed)
    setDraftLayout(committed)
  }, [])

  const [insertionCandidate, setInsertionCandidate] = useState<InsertionCandidate | null>(null)
  const preInsertionDraftRef = useRef<CanonicalLayout | null>(null)

  const beginInsertion = useCallback(
    (widgetType: string): InsertionCandidate => {
      const candidate: InsertionCandidate = { widgetId: createWidgetId(widgetType), widgetType }
      preInsertionDraftRef.current = draftLayout
      setInsertionCandidate(candidate)
      return candidate
    },
    [draftLayout],
  )

  const previewInsertionAtSlot = useCallback(
    (existingRow: DashboardWidget[], slotIndex: number): boolean => {
      if (!insertionCandidate || !preInsertionDraftRef.current) return false
      const candidateLayout = computeRowInsertionPreview(preInsertionDraftRef.current, existingRow, insertionCandidate, slotIndex)
      if (!validateLayout(candidateLayout).valid) return false
      setDraftLayout(candidateLayout)
      return true
    },
    [insertionCandidate],
  )

  const cancelInsertion = useCallback(() => {
    if (preInsertionDraftRef.current) setDraftLayout(preInsertionDraftRef.current)
    preInsertionDraftRef.current = null
    setInsertionCandidate(null)
  }, [])

  const commitInsertion = useCallback(() => {
    preInsertionDraftRef.current = null
    setInsertionCandidate(null)
  }, [])

  const addWidgetAtSlot = useCallback(
    (widgetType: string, existingRow: DashboardWidget[], slotIndex: number, candidateWidgetId?: string): AddWidgetAtSlotResult => {
      const candidate: InsertionCandidate = { widgetId: candidateWidgetId ?? createWidgetId(widgetType), widgetType }
      const { layout: candidateLayout, valid } = computeValidatedRowInsertion(draftLayout, existingRow, candidate, slotIndex)
      if (!valid) return { widgetId: null, accepted: false }
      setDraftLayout(candidateLayout)
      return { widgetId: candidate.widgetId, accepted: true }
    },
    [draftLayout],
  )

  return {
    layout,
    draftLayout,
    editMode,
    isDirty: draftLayout !== layout,
    draftValidation,
    enterEditMode,
    cancel,
    restoreDefault,
    save,
    gridChangeConfirmation,
    confirmGridChange,
    cancelGridChangeConfirmation,
    isSaving,
    saveError,
    updateDraftWidget,
    removeDraftWidget,
    updateDraftWidgetComparison,
    updateDraftWidgetByCreatorDrop,
    commitExternalLayout,
    insertionCandidate,
    beginInsertion,
    previewInsertionAtSlot,
    cancelInsertion,
    commitInsertion,
    addWidgetAtSlot,
  }
}
