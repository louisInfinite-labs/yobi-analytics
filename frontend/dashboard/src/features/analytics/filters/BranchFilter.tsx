import { BRANCH_LABELS, type BranchKey } from "../../../entities/creator/model/domain"
import { NullableSegmented } from "../../../shared/ui/NullableSegmented"

interface BranchFilterProps {
  value: BranchKey | null
  options: BranchKey[]
  onChange: (value: BranchKey | null) => void
}

/** Options are already narrowed to the selected organization by the caller
 * (dashboard_ui_direction_en.md: "narrow the valid child choices"). */
export function BranchFilter({ value, options, onChange }: BranchFilterProps) {
  if (options.length === 0) return null
  const sortedOptions = [...options].sort((a, b) => BRANCH_LABELS[a].localeCompare(BRANCH_LABELS[b], "en"))

  return (
    <NullableSegmented
      label="Branch"
      value={value}
      onChange={onChange}
      options={sortedOptions.map((branch) => ({ label: BRANCH_LABELS[branch], value: branch }))}
    />
  )
}
