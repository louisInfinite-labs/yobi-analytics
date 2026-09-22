import { useMemo, useState } from "react"
import { useDraggable } from "@dnd-kit/core"
import { Button, Checkbox, Input } from "antd"
import { Check, Search, Users, X } from "lucide-react"
import { BRANCH_LABELS } from "../../../../entities/creator/model/domain"
import { CreatorAvatar } from "../../../analytics/charts/CreatorAvatar"
import { creatorMatchesSearch, groupCreatorsForDockWithSubgroups } from "../../../../entities/creator/utils/dockCreatorOrder"
import { GAMERS_GROUP_LABEL_KEY, OTHER_GROUP_LABEL_KEY, hololiveGroupDisplayLabel } from "../../../../entities/creator/utils/hololiveSubgrouping"
import type { MockCreator } from "../../../../entities/creator/data/mockCreators"
import { useFavoriteCreators } from "../../../favorites/hooks/useFavoriteCreators"
import { ComparisonOrderBadge } from "./ComparisonOrderBadge"

function DraggableCreatorCell({ creator, selectedIds, order, onToggle, onEnsureSelected, available }: {
  creator: MockCreator
  selectedIds: readonly string[]
  order: number | null
  onToggle: () => void
  onEnsureSelected: () => void
  available: boolean
}) {
  const checkboxId = `comparison-member-${creator.channelId}`
  const draggedIds = order === null ? [...selectedIds, creator.channelId] : selectedIds
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: creator.channelId,
    data: { creatorId: creator.channelId, creatorIds: draggedIds },
    disabled: !available,
  })
  return (
    <div className="member-selector__row" data-selected={order !== null || undefined}>
      <Checkbox id={checkboxId} checked={order !== null} disabled={!available} onChange={onToggle} aria-label={`Select ${creator.channelName}`} />
      <button
        type="button"
        ref={setNodeRef}
        {...listeners}
        {...attributes}
        onPointerDownCapture={onEnsureSelected}
        className="member-selector__drag-surface"
        aria-label={creator.channelName}
        aria-pressed={isDragging}
        disabled={!available}
        title={!available ? "No data available" : order === null ? `Drag ${creator.channelName}` : `Drag ${selectedIds.length} selected members`}
      >
        <span className="member-selector__avatar" aria-hidden="true">
          <CreatorAvatar channelId={creator.channelId} channelName={creator.channelName} size="medium" />
          {order !== null && <ComparisonOrderBadge order={order} />}
        </span>
        <span className="member-selector__name">{creator.channelName}<small>{available ? "Available" : "No data"}</small></span>
      </button>
    </div>
  )
}

export interface DraggableCreatorListProps {
  /** The existing Creator List's own data (production: `mockCreators`) --
   * same reuse convention `CreatorComparisonPicker`/`ComparisonMappingDialog`
   * already established (`channelId` as the stable comparison `creatorId`,
   * ordering via `groupCreatorsForDock`). */
  creators: MockCreator[]
  availableCreatorIds?: ReadonlySet<string>
  initiallyOpen?: boolean
  dragging?: boolean
  selectedIds?: string[]
  onSelectedIdsChange?: (creatorIds: string[]) => void
}

/** MT-13 "Flow 3: Drag Creator Cell into Chart" (Section 3.4 Flow 3, step 1:
 * "open the Creator List first"). Read-only: dragging a cell never reorders
 * or mutates `creators` (AC9). Must be rendered inside a `@dnd-kit/core`
 * `DndContext` to be draggable; a caller composes that context together with
 * a droppable target (`CanonicalWidgetGrid`). */
function subgroupLabel(label: string, branch: MockCreator["branch"]): string {
  if (label === GAMERS_GROUP_LABEL_KEY) return "ゲーマーズ"
  if (label === OTHER_GROUP_LABEL_KEY) return "Other"
  return hololiveGroupDisplayLabel(label, branch)
}

export function DraggableCreatorList({
  creators,
  availableCreatorIds,
  initiallyOpen = true,
  dragging = false,
  selectedIds: controlledSelectedIds,
  onSelectedIdsChange,
}: DraggableCreatorListProps) {
  const { favorites } = useFavoriteCreators()
  const [open, setOpen] = useState(initiallyOpen)
  const [query, setQuery] = useState("")
  const [localSelectedIds, setLocalSelectedIds] = useState<string[]>([])
  const selectedIds = controlledSelectedIds ?? localSelectedIds
  const setSelectedIds = (next: string[] | ((current: string[]) => string[])) => {
    const resolved = typeof next === "function" ? next(selectedIds) : next
    if (controlledSelectedIds === undefined) setLocalSelectedIds(resolved)
    onSelectedIdsChange?.(resolved)
  }
  const groups = useMemo(() => groupCreatorsForDockWithSubgroups(creators), [creators])
  const creatorById = useMemo(() => new Map(creators.map((creator) => [creator.channelId, creator])), [creators])
  const favoriteCreators = useMemo(
    () => creators.filter((creator) => favorites.has(creator.channelId) && creatorMatchesSearch(creator, query)),
    [creators, favorites, query],
  )
  const favoriteIds = useMemo(() => new Set(favoriteCreators.map((creator) => creator.channelId)), [favoriteCreators])
  const visibleGroups = groups
    .map((group) => ({
      ...group,
      subgroups: group.subgroups
        .map((subgroup) => ({
          ...subgroup,
          creators: subgroup.creators.filter(
            (creator) => !favoriteIds.has(creator.channelId) && creatorMatchesSearch(creator, query),
          ),
        }))
        .filter((subgroup) => subgroup.creators.length > 0),
    }))
    .filter((group) => group.subgroups.length > 0)
  const toggle = (creatorId: string) => {
    const isSelected = selectedIds.includes(creatorId)
    if (!isSelected && availableCreatorIds && !availableCreatorIds.has(creatorId)) return
    setSelectedIds((current) => current.includes(creatorId) ? current.filter((id) => id !== creatorId) : [...current, creatorId])
  }
  const renderRow = (creator: MockCreator) => (
    <DraggableCreatorCell
      key={creator.channelId}
      creator={creator}
      selectedIds={selectedIds}
      order={selectedIds.includes(creator.channelId) ? selectedIds.indexOf(creator.channelId) + 1 : null}
      onToggle={() => toggle(creator.channelId)}
      onEnsureSelected={() => {
        if (!selectedIds.includes(creator.channelId)) setSelectedIds([...selectedIds, creator.channelId])
      }}
      available={!availableCreatorIds || availableCreatorIds.has(creator.channelId)}
    />
  )

  return (
    <>
      <Button icon={<Users size={16} />} onClick={() => setOpen(true)}>
        Members{selectedIds.length > 0 ? ` (${selectedIds.length})` : ""}
      </Button>
      {open && (
        <aside className={`member-selector${dragging ? " member-selector--dragging" : ""}`} aria-label="Chart members">
          <header className="member-selector__header">
            <div>
              <strong>Members</strong>
              <span>Select one or more, then drag from an avatar or name onto a compatible chart.</span>
            </div>
            <Button type="text" shape="circle" icon={<X size={17} />} aria-label="Close member selector" onClick={() => setOpen(false)} />
          </header>
          <div className="member-selector__search">
            <Input prefix={<Search size={15} />} allowClear value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search members" aria-label="Search members" />
          </div>
          {selectedIds.length > 0 && (
            <div className="member-selector__selection" aria-label="Selected members">
              <div className="member-selector__selection-header">
                <strong>{selectedIds.length} selected</strong>
                <Button type="link" size="small" onClick={() => setSelectedIds([])}>Clear</Button>
              </div>
              <div className="member-selector__selection-list">
                {selectedIds.map((id, index) => (
                  <button key={id} type="button" onClick={() => toggle(id)} title="Remove from selection">
                    <span>{index + 1}</span>{creatorById.get(id)?.channelName ?? id}<X size={12} aria-hidden="true" />
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="member-selector__results">
            {favoriteCreators.length > 0 && (
              <section>
                <h3>Favorites</h3>
                {favoriteCreators.map(renderRow)}
              </section>
            )}
            {visibleGroups.map((group) => (
              <section key={group.branch}>
                <h3>{BRANCH_LABELS[group.branch]}</h3>
                {group.subgroups.map((subgroup) => (
                  <div key={subgroup.label ?? "all"} className="member-selector__subgroup">
                    {subgroup.label && <h4>{subgroupLabel(subgroup.label, group.branch)}</h4>}
                    {subgroup.creators.map(renderRow)}
                  </div>
                ))}
              </section>
            ))}
            {favoriteCreators.length === 0 && visibleGroups.length === 0 && <p className="member-selector__empty">No members found.</p>}
          </div>
          <footer className="member-selector__footer"><Check size={14} /> Each chart keeps its own member selection.</footer>
        </aside>
      )}
    </>
  )
}
