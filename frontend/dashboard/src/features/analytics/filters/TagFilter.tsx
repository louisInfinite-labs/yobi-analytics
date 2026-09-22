import type { BranchKey, GroupKey } from "../../../entities/creator/model/domain"
import { hololiveGroupDisplayLabel } from "../../../entities/creator/utils/hololiveSubgrouping"

interface TagFilterProps {
  selected: GroupKey[]
  options: GroupKey[]
  onToggle: (key: GroupKey) => void
  branch: BranchKey | null
}

/** Creator generation/unit/staff-grouping multi-select (Creator Master's
 * groupKey) — OR matching within this dimension. A creator may carry more
 * than one tag (e.g. a numbered generation tag plus a unit tag like Gamers). */
export function TagFilter({ selected, options, onToggle, branch }: TagFilterProps) {
  if (options.length === 0) return null

  return (
    <div className="filter-row">
      <span className="filter-row__label">Generation / Unit</span>
      <div className="filter-chip-group">
        {options.map((tag) => (
          <button key={tag} type="button" className="filter-chip" aria-pressed={selected.includes(tag)} onClick={() => onToggle(tag)}>
            {hololiveGroupDisplayLabel(tag, branch)}
          </button>
        ))}
      </div>
    </div>
  )
}
