import type { GroupKey } from "../../types/domain"

interface TagFilterProps {
  selected: GroupKey[]
  options: GroupKey[]
  onToggle: (key: GroupKey) => void
}

/** Creator generation/unit/staff-grouping multi-select (Creator Master's
 * groupKey) — OR matching within this dimension. A creator may carry more
 * than one tag (e.g. "1期生" + "ゲーマーズ"). */
export function TagFilter({ selected, options, onToggle }: TagFilterProps) {
  if (options.length === 0) return null

  return (
    <div className="filter-row">
      <span className="filter-row__label">Generation / Unit</span>
      <div className="filter-chip-group">
        {options.map((tag) => (
          <button key={tag} type="button" className="filter-chip" aria-pressed={selected.includes(tag)} onClick={() => onToggle(tag)}>
            {tag}
          </button>
        ))}
      </div>
    </div>
  )
}
