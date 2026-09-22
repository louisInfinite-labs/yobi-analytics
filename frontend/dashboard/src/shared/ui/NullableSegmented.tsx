import { Segmented } from "antd"

const ALL_VALUE = "__all__"

interface NullableSegmentedProps<T extends string> {
  label: string
  value: T | null
  options: { value: T; label: string }[]
  onChange: (value: T | null) => void
}

/** A single-select Segmented row with a built-in "All" (null) option --
 * shared by the analytics dashboard's Branch/ChannelType/ContentFormat/
 * LifecycleStage/Organization filters, which otherwise duplicated the same
 * `__all__` sentinel and value-mapping logic. */
export function NullableSegmented<T extends string>({ label, value, options, onChange }: NullableSegmentedProps<T>) {
  return (
    <div className="filter-row">
      <span className="filter-row__label">{label}</span>
      <Segmented
        value={value ?? ALL_VALUE}
        onChange={(next) => onChange(next === ALL_VALUE ? null : (next as T))}
        options={[{ label: "All", value: ALL_VALUE }, ...options]}
      />
    </div>
  )
}
