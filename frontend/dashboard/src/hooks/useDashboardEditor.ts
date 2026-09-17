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
 */
import { useCallback, useMemo, useRef, useState } from "react"
import { buildDefaultLayout } from "../lib/dashboardDefaultLayout"
import { createWidgetId, updateWidgetGeometry, type WidgetPlacement } from "../lib/dashboardWidgetActions"
import { computeRowInsertionPreview, type InsertionCandidate } from "../lib/dashboardInsertionPreview"
import { computeAffectedWidgetIds, submitLayoutSave } from "../lib/dashboardLayoutSave"
import { validateLayout } from "../lib/dashboardLayoutValidation"
import type { CanonicalLayout, DashboardWidget, GridSize, LayoutValidationResult } from "../types/dashboardLayout"

export interface GridChangeConfirmation {
  currentGrid: GridSize
  targetGrid: GridSize
  affectedWidgetIds: string[]
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
  /** Mutates only the draft's geometry for one widget, reusing MT-02's canonical mutation primitive (AC8). */
  updateDraftWidget: (widgetId: string, patch: Partial<WidgetPlacement>) => void
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

  const updateDraftWidget = useCallback((widgetId: string, patch: Partial<WidgetPlacement>) => {
    setDraftLayout((current) => updateWidgetGeometry(current, widgetId, patch).layout)
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
    insertionCandidate,
    beginInsertion,
    previewInsertionAtSlot,
    cancelInsertion,
    commitInsertion,
  }
}
