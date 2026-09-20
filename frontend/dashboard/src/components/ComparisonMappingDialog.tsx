import { useRef } from "react"
import { ComparisonOrderBadge } from "./ComparisonOrderBadge"
import { useModalFocus } from "../hooks/useModalFocus"
import { groupCreatorsForDock } from "../lib/dockCreatorOrder"
import type { MockCreator } from "../data/mockCreators"
import type { ComparisonMappingResult } from "../lib/dashboardComparisonMapping"
import type { ComparisonItem } from "../types/dashboardComparisonCatalog"

export interface ComparisonMappingDialogProps {
  /** The existing Creator List's own data (production: `mockCreators`) --
   * same reuse convention `CreatorComparisonPicker` (MT-11) already
   * established: `channelId` is the stable comparison `creatorId`, and
   * ordering reuses `groupCreatorsForDock` rather than a second
   * reimplementation. */
  creators: MockCreator[]
  /** Backend-supported comparison items (Section 3.4: "Load available
   * comparison items from a backend-supported definition... Do not invent
   * frontend-only items."). Injected -- the same GAP-3-shaped gap as the
   * chart catalog; see ../types/dashboardComparisonCatalog.ts. */
  availableComparisonItems: ComparisonItem[]
  orderedCreatorIds: string[]
  onToggleCreator: (creatorId: string) => void
  orderedItemIds: string[]
  onToggleItem: (comparisonItemId: string) => void
  preview: ComparisonMappingResult
  canSave: boolean
  isSaving: boolean
  error: string | null
  onSave: () => void
  onCancel: () => void
}

/** MT-12 "Flow 2: Creator List Selection and widget[0]-First Save" (Section
 * 3.4 Flow 2). Follows this project's existing hand-rolled dialog convention
 * (backdrop + `role="dialog"` `aria-modal`, secondary Cancel + primary
 * confirm -- see `GridChangeConfirmationDialog`, `CreatorComparisonPicker`).
 * Purely presentational: all selection/mapping/save state lives in
 * `useComparisonMappingDialog`, so this component never itself decides
 * when a mutation is valid. Rendering the mapping preview (`preview.assignments`)
 * is read-only -- `preview` is a pure computation (`computeComparisonMapping`),
 * so simply displaying it can never mutate Dashboard state (AC12). */
export function ComparisonMappingDialog({
  creators,
  availableComparisonItems,
  orderedCreatorIds,
  onToggleCreator,
  orderedItemIds,
  onToggleItem,
  preview,
  canSave,
  isSaving,
  error,
  onSave,
  onCancel,
}: ComparisonMappingDialogProps) {
  const orderedCreators = groupCreatorsForDock(creators).flatMap((group) => group.creators)
  const itemLabelById = new Map(availableComparisonItems.map((item) => [item.comparisonItemId, item.label]))
  const panelRef = useRef<HTMLDivElement>(null)
  useModalFocus(panelRef, onCancel)

  return (
    <div className="comparison-mapping-dialog__backdrop" onClick={onCancel} role="dialog" aria-modal="true" aria-label="Add Comparison Charts">
      <div ref={panelRef} className="comparison-mapping-dialog__panel" onClick={(event) => event.stopPropagation()}>
        <section aria-label="Creators">
          <ul className="comparison-mapping-dialog__creator-list">
            {orderedCreators.map((creator) => {
              const order = orderedCreatorIds.indexOf(creator.channelId)
              const isSelected = order !== -1
              return (
                <li key={creator.channelId}>
                  <button
                    type="button"
                    className="comparison-mapping-dialog__creator soft-button"
                    aria-pressed={isSelected}
                    aria-label={creator.channelName}
                    onClick={() => onToggleCreator(creator.channelId)}
                  >
                    <span className="creator-comparison-picker__avatar">
                      <span aria-hidden="true">{creator.channelName.charAt(0)}</span>
                      {isSelected && <ComparisonOrderBadge order={order + 1} />}
                    </span>
                    <span aria-hidden="true">{creator.channelName}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>

        <section aria-label="Comparison items">
          <ul className="comparison-mapping-dialog__item-list">
            {availableComparisonItems.map((item) => (
              <li key={item.comparisonItemId}>
                <button
                  type="button"
                  className="soft-button"
                  aria-pressed={orderedItemIds.includes(item.comparisonItemId)}
                  onClick={() => onToggleItem(item.comparisonItemId)}
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section aria-label="Mapping preview" data-testid="comparison-mapping-preview">
          <ul>
            {preview.assignments.map((assignment) => (
              <li key={assignment.widgetId} data-testid="comparison-mapping-row">
                {itemLabelById.get(assignment.comparisonItemId) ?? assignment.comparisonItemId} {"→"} widget[{assignment.widgetIndex}]
              </li>
            ))}
          </ul>
          {!preview.ok && orderedItemIds.length > 0 && (
            <p role="alert">Not enough space on the Dashboard for all selected comparison items.</p>
          )}
        </section>

        {error && <p role="alert">{error}</p>}

        <div className="comparison-mapping-dialog__actions">
          <button type="button" className="soft-button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="soft-button soft-button--primary" disabled={!canSave || isSaving} onClick={onSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
