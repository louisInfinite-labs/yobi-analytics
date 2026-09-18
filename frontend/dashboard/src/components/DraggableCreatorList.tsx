import { useDraggable } from "@dnd-kit/core"
import { groupCreatorsForDock } from "../lib/dockCreatorOrder"
import type { MockCreator } from "../data/mockCreators"

function DraggableCreatorCell({ creator }: { creator: MockCreator }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: creator.channelId,
    data: { creatorId: creator.channelId },
  })
  return (
    <button
      type="button"
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className="draggable-creator-cell soft-button"
      aria-label={creator.channelName}
      aria-pressed={isDragging}
    >
      {creator.channelName}
    </button>
  )
}

export interface DraggableCreatorListProps {
  /** The existing Creator List's own data (production: `mockCreators`) --
   * same reuse convention `CreatorComparisonPicker`/`ComparisonMappingDialog`
   * already established (`channelId` as the stable comparison `creatorId`,
   * ordering via `groupCreatorsForDock`). */
  creators: MockCreator[]
}

/** MT-13 "Flow 3: Drag Creator Cell into Chart" (Section 3.4 Flow 3, step 1:
 * "open the Creator List first"). Read-only: dragging a cell never reorders
 * or mutates `creators` (AC9). Must be rendered inside a `@dnd-kit/core`
 * `DndContext` to be draggable; a caller composes that context together with
 * a droppable target (`CanonicalWidgetGrid`). */
export function DraggableCreatorList({ creators }: DraggableCreatorListProps) {
  const orderedCreators = groupCreatorsForDock(creators).flatMap((group) => group.creators)
  return (
    <ul className="draggable-creator-list" aria-label="Creator List">
      {orderedCreators.map((creator) => (
        <li key={creator.channelId}>
          <DraggableCreatorCell creator={creator} />
        </li>
      ))}
    </ul>
  )
}
