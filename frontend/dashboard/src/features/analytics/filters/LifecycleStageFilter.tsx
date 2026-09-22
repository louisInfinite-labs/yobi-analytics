import { LIFECYCLE_STAGE_LABELS, type LifecycleStage } from "../../../entities/creator/model/domain"
import { NullableSegmented } from "../../../shared/ui/NullableSegmented"

const OPTIONS: LifecycleStage[] = ["active", "pre_debut", "graduated", "retired"]

interface LifecycleStageFilterProps {
  value: LifecycleStage | null
  onChange: (value: LifecycleStage | null) => void
}

/** The visible "graduated" chip is this filter set to "graduated" — it never
 * replaces a creator's organization/branch/tag memberships, only adds this
 * independent status dimension (dashboard_ui_direction_en.md section 9). */
export function LifecycleStageFilter({ value, onChange }: LifecycleStageFilterProps) {
  return (
    <NullableSegmented
      label="Lifecycle"
      value={value}
      onChange={onChange}
      options={OPTIONS.map((stage) => ({ label: LIFECYCLE_STAGE_LABELS[stage], value: stage }))}
    />
  )
}
