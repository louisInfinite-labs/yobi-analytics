import { LIFECYCLE_STAGE_LABELS, type LifecycleStage } from "../../types/domain"

const OPTIONS: LifecycleStage[] = ["active", "pre_debut", "graduated", "retired"]

interface LifecycleStageFilterProps {
  value: LifecycleStage | null
  onChange: (value: LifecycleStage | null) => void
}

/** The visible 卒業 chip is this filter set to "graduated" — it never
 * replaces a creator's organization/branch/tag memberships, only adds this
 * independent status dimension (dashboard_ui_direction_en.md section 9). */
export function LifecycleStageFilter({ value, onChange }: LifecycleStageFilterProps) {
  return (
    <div className="filter-row">
      <span className="filter-row__label">Lifecycle</span>
      <div className="filter-chip-group">
        <button type="button" className="filter-chip" aria-pressed={value === null} onClick={() => onChange(null)}>
          All
        </button>
        {OPTIONS.map((stage) => (
          <button key={stage} type="button" className="filter-chip" aria-pressed={value === stage} onClick={() => onChange(stage)}>
            {LIFECYCLE_STAGE_LABELS[stage]}
          </button>
        ))}
      </div>
    </div>
  )
}
