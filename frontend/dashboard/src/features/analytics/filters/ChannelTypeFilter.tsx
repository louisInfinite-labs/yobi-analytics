import type { ChannelType } from "../../../entities/creator/model/domain"
import { NullableSegmented } from "../../../shared/ui/NullableSegmented"

const OPTIONS: { value: ChannelType; label: string }[] = [
  { value: "member", label: "Member" },
  { value: "group", label: "Group" },
  { value: "staff", label: "Staff" },
]

interface ChannelTypeFilterProps {
  value: ChannelType | null
  onChange: (value: ChannelType | null) => void
}

/** Member / Group / Staff single-select filter. */
export function ChannelTypeFilter({ value, onChange }: ChannelTypeFilterProps) {
  return <NullableSegmented label="Channel Type" value={value} onChange={onChange} options={OPTIONS} />
}
