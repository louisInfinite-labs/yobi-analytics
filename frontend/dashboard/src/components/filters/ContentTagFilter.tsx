import { CONTENT_TAG_LABELS, type ContentTagKey } from "../../types/domain"

const OPTIONS = Object.keys(CONTENT_TAG_LABELS) as ContentTagKey[]

interface ContentTagFilterProps {
  selected: ContentTagKey[]
  onToggle: (tag: ContentTagKey) => void
}

/** Video content topic tags — independent of creator generation/unit tags
 * (dashboard_ui_direction_en.md section 5). Multi-select, OR within this
 * dimension, AND with every other filter dimension. */
export function ContentTagFilter({ selected, onToggle }: ContentTagFilterProps) {
  return (
    <div className="filter-row">
      <span className="filter-row__label">Content Tags</span>
      <div className="filter-chip-group">
        {OPTIONS.map((tag) => (
          <button key={tag} type="button" className="filter-chip" aria-pressed={selected.includes(tag)} onClick={() => onToggle(tag)}>
            {CONTENT_TAG_LABELS[tag]}
          </button>
        ))}
      </div>
    </div>
  )
}
