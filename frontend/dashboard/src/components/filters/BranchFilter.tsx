import { BRANCH_LABELS, type BranchKey } from "../../types/domain"

interface BranchFilterProps {
  value: BranchKey | null
  options: BranchKey[]
  onChange: (value: BranchKey | null) => void
}

/** Options are already narrowed to the selected organization by the caller
 * (dashboard_ui_direction_en.md: "narrow the valid child choices"). */
export function BranchFilter({ value, options, onChange }: BranchFilterProps) {
  if (options.length === 0) return null

  return (
    <div className="filter-row">
      <span className="filter-row__label">Branch</span>
      <div className="filter-chip-group">
        <button type="button" className="filter-chip" aria-pressed={value === null} onClick={() => onChange(null)}>
          All
        </button>
        {options.map((branch) => (
          <button key={branch} type="button" className="filter-chip" aria-pressed={value === branch} onClick={() => onChange(branch)}>
            {BRANCH_LABELS[branch]}
          </button>
        ))}
      </div>
    </div>
  )
}
