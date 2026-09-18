import { useState } from "react"
import { useOrderedCreatorSelection } from "../hooks/useOrderedCreatorSelection"
import { ComparisonOrderBadge } from "./ComparisonOrderBadge"
import { creatorMatchesSearch, groupCreatorsForDock } from "../lib/dockCreatorOrder"
import type { MockCreator } from "../data/mockCreators"

export interface CreatorComparisonPickerProps {
  /** The existing Creator List's own data (production: `mockCreators`) --
   * injected rather than owned here, the same dependency-injection
   * convention `useChartCatalog`'s `fetchCatalog` and `useDashboardEditor`'s
   * `submitSave` already use. `channelId` is reused directly as the stable
   * comparison `creatorId` (Section 3.4) -- it is already a stable, unique
   * per-creator identifier, so no new field or mapping table is needed on
   * `MockCreator` itself. */
  creators: MockCreator[]
  /** The target widget's currently configured comparison creator ids, in
   * order -- seeds this picker's own local selection (AC3). Never read from
   * the application's active/current creator. */
  initialSelectedIds: readonly string[]
  onCancel: () => void
  onApply: (creatorIds: string[]) => void
}

/** MT-11 "Flow 1: In-Widget Creator Picker" (Section 3.4 Flow 1). Reuses the
 * existing Creator List's own order and search-filter functions --
 * `groupCreatorsForDock`/`creatorMatchesSearch` (`dockCreatorOrder.ts`, the
 * same module `CreatorStatusList` itself calls) -- so this picker's ordering
 * and matching are identical to the production Creator List's, not a second
 * reimplementation. `CreatorStatusList` itself is not reused directly: it is
 * a single-select Home/Dock component wired to live status, favorites, and
 * Oshi-switch confirmation, none of which apply to a comparison picker, and
 * changing it to support multi-select would risk exactly the Home/Dock
 * behavior this correction is required to preserve. Presenting the existing
 * list's data through a new dialog/panel here matches Section 3.4 Flow 1's
 * own wording: "opens the existing Creator List using the project's
 * established dialog, drawer, or panel pattern."
 *
 * The caller mounts this only while open, so every open is a fresh mount
 * seeded from `initialSelectedIds` -- this is what makes the in-progress
 * selection isolated local/pending state (AC6: "Cancelling the picker leaves
 * the previous comparison configuration unchanged"). Nothing here writes
 * anywhere until `onApply` is actually called; unmounting on Cancel simply
 * discards this component's own local state.
 *
 * Reuses MT-10's `useOrderedCreatorSelection` (click-order selection,
 * renumbering, duplicate rejection, two-creator minimum) and
 * `ComparisonOrderBadge` (the order-badge component) rather than
 * reimplementing either. Follows this project's existing hand-rolled dialog
 * convention (backdrop + `role="dialog"` `aria-modal`, a secondary Cancel and
 * a primary confirm action -- see `GridChangeConfirmationDialog`), since no
 * shared, generic Dialog/Modal component exists to reuse instead. Like that
 * dialog, this deliberately does not implement focus-trapping, `Escape`-to-
 * close, or focus restoration on close -- those are explicit MT-16
 * acceptance criteria, not MT-11's. */
export function CreatorComparisonPicker({ creators, initialSelectedIds, onCancel, onApply }: CreatorComparisonPickerProps) {
  const selection = useOrderedCreatorSelection(initialSelectedIds)
  const [query, setQuery] = useState("")

  const orderedCreators = groupCreatorsForDock(creators).flatMap((group) => group.creators)
  const visibleCreators = orderedCreators.filter((creator) => creatorMatchesSearch(creator, query))

  return (
    <div
      className="creator-comparison-picker__backdrop"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label="Select Creators"
    >
      <div className="creator-comparison-picker__panel" onClick={(event) => event.stopPropagation()}>
        <input
          type="search"
          className="creator-comparison-picker__search"
          aria-label="Search creators"
          placeholder="Search creators"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ul className="creator-comparison-picker__list">
          {visibleCreators.map((creator) => {
            const order = selection.orderOf(creator.channelId)
            return (
              <li key={creator.channelId}>
                <button
                  type="button"
                  className="creator-comparison-picker__creator soft-button"
                  aria-pressed={order !== null}
                  aria-label={creator.channelName}
                  onClick={() => selection.toggle(creator.channelId)}
                >
                  <span className="creator-comparison-picker__avatar">
                    <span aria-hidden="true">{creator.channelName.charAt(0)}</span>
                    {order !== null && <ComparisonOrderBadge order={order} />}
                  </span>
                  <span aria-hidden="true">{creator.channelName}</span>
                </button>
              </li>
            )
          })}
        </ul>
        <div className="creator-comparison-picker__actions">
          <button type="button" className="soft-button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="soft-button soft-button--primary"
            disabled={!selection.canCompare}
            onClick={() => onApply(selection.orderedIds)}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  )
}
