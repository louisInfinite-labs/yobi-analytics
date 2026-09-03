import type { ChannelType } from "../../types/domain"

const OPTIONS: { value: ChannelType; label: string }[] = [
  { value: "member", label: "Member" },
  { value: "group", label: "Group" },
  { value: "staff", label: "Staff" },
]

interface ChannelTypeFilterProps {
  value: ChannelType | null
  onChange: (value: ChannelType | null) => void
}

export function ChannelTypeFilter({ value, onChange }: ChannelTypeFilterProps) {
  return (
    <div className="filter-row">
      <span className="filter-row__label">Channel Type</span>
      <div className="filter-chip-group">
        <button type="button" className="filter-chip" aria-pressed={value === null} onClick={() => onChange(null)}>
          All
        </button>
        {OPTIONS.map((opt) => (
          <button key={opt.value} type="button" className="filter-chip" aria-pressed={value === opt.value} onClick={() => onChange(opt.value)}>
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}
