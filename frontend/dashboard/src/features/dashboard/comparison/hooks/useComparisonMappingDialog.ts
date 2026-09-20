/** MT-12 "Flow 2: Creator List Selection and widget[0]-First Save"
 * (frontend/dashboard/DASHBOARD_LAYOUT_GUIDELINES.md, Section 3.4 Flow 2).
 *
 * Owns Flow 2's own dialog state: ordered creator/item selection and the
 * Save transaction. Deliberately independent of `useDashboardEditor`
 * (../hooks/useDashboardEditor.ts) and takes `canonicalLayout` -- never
 * `draftLayout` -- as its only layout input, which is what keeps an
 * unrelated, unsaved Dashboard draft edit out of the comparison transaction
 * by construction (MT-12 AC14) rather than by convention. `save()` never
 * calls `useDashboardEditor`'s `save`/`submitLayoutSave`; it calls its own
 * injected `submitTransaction` through `submitComparisonTransaction`
 * (../lib/dashboardComparisonMapping.ts), matching Section 3.4's "Flow 2
 * uses its own explicit dialog Save as the atomic persistence boundary."
 *
 * Creator and comparison-item selection reuse the same generic ordered-
 * selection primitives MT-10 established (`toggleCreatorSelection`,
 * `dedupePreservingOrder` in ../lib/creatorComparisonOrder.ts) rather than
 * reimplementing click-order/dedupe logic twice. `useOrderedCreatorSelection`
 * itself is not reused directly for items: it bakes in a two-creator
 * minimum (`canStartComparison`) that does not apply to comparison items,
 * whose own minimum is one (Section 3.4 Flow 2 step 4).
 */
import { useCallback, useMemo, useState } from "react"
import { dedupePreservingOrder, toggleCreatorSelection } from "../utils/creatorComparisonOrder"
import { computeComparisonMapping, submitComparisonTransaction, type ComparisonMappingResult } from "../utils/dashboardComparisonMapping"
import type { CanonicalLayout } from "../../editor/model/dashboardLayout"

export const MIN_COMPARISON_CREATORS = 2
export const MIN_COMPARISON_ITEMS = 1

export interface UseComparisonMappingDialogResult {
  isOpen: boolean
  /** Opens the dialog with a fresh, empty selection (Section 3.4 Flow 2
   * starts from the Creator List, not from any widget's existing config). */
  open: () => void
  /** Closes the dialog without submitting anything. */
  close: () => void
  orderedCreatorIds: string[]
  toggleCreator: (creatorId: string) => void
  orderedItemIds: string[]
  toggleItem: (comparisonItemId: string) => void
  /** Recomputed from the current `canonicalLayout` and current selection on
   * every render -- side-effect free, safe to render directly as the
   * mapping preview (AC12). */
  preview: ComparisonMappingResult
  /** Section 3.4 Flow 2 step 4: at least two distinct creators and at least
   * one valid comparison item, and the mapping itself must have capacity
   * (AC11: a mapping that needs a widget with no valid slot also disables Save). */
  canSave: boolean
  save: () => Promise<void>
  isSaving: boolean
  error: string | null
}

export function useComparisonMappingDialog(
  canonicalLayout: CanonicalLayout,
  submitTransaction: (layout: CanonicalLayout) => Promise<void>,
  onCommitted: (layout: CanonicalLayout) => void,
): UseComparisonMappingDialogResult {
  const [isOpen, setIsOpen] = useState(false)
  const [orderedCreatorIds, setOrderedCreatorIds] = useState<string[]>([])
  const [orderedItemIds, setOrderedItemIds] = useState<string[]>([])
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const open = useCallback(() => {
    setOrderedCreatorIds([])
    setOrderedItemIds([])
    setError(null)
    setIsOpen(true)
  }, [])

  const close = useCallback(() => setIsOpen(false), [])

  const toggleCreator = useCallback((creatorId: string) => {
    setOrderedCreatorIds((current) => toggleCreatorSelection(current, creatorId))
  }, [])

  const toggleItem = useCallback((comparisonItemId: string) => {
    setOrderedItemIds((current) => toggleCreatorSelection(current, comparisonItemId))
  }, [])

  const preview = useMemo(
    () => computeComparisonMapping(canonicalLayout, orderedCreatorIds, orderedItemIds),
    [canonicalLayout, orderedCreatorIds, orderedItemIds],
  )

  const canSave =
    dedupePreservingOrder(orderedCreatorIds).length >= MIN_COMPARISON_CREATORS &&
    dedupePreservingOrder(orderedItemIds).length >= MIN_COMPARISON_ITEMS &&
    preview.ok

  const save = useCallback(async () => {
    if (!canSave) return
    setIsSaving(true)
    setError(null)
    const outcome = await submitComparisonTransaction(preview, submitTransaction)
    setIsSaving(false)
    if (outcome.committed && outcome.layout) {
      onCommitted(outcome.layout)
      setIsOpen(false) // AC15
      return
    }
    if (outcome.error) setError(outcome.error.message)
  }, [canSave, preview, submitTransaction, onCommitted])

  return {
    isOpen,
    open,
    close,
    orderedCreatorIds,
    toggleCreator,
    orderedItemIds,
    toggleItem,
    preview,
    canSave,
    save,
    isSaving,
    error,
  }
}
