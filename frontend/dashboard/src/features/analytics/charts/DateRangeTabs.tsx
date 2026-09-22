import { Segmented } from "antd"
import type { Period } from "../../../entities/creator/model/domain"

const PERIODS: { value: Period; label: string }[] = [
  { value: "1d", label: "Today" },
  { value: "7d", label: "7 Day" },
  { value: "30d", label: "30 Day" },
]

interface DateRangeTabsProps {
  value: Period
  onChange: (period: Period) => void
}

/** Today / 7 Day / 30 Day period toggle group driving the whole page's growth window. */
export function DateRangeTabs({ value, onChange }: DateRangeTabsProps) {
  return (
    <div role="group" aria-label="Growth period">
      <Segmented
        value={value}
        onChange={(next) => onChange(next as Period)}
        options={PERIODS.map((p) => ({ label: p.label, value: p.value }))}
      />
    </div>
  )
}
