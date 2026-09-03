import type { Period } from "../types/domain"

const PERIODS: { value: Period; label: string }[] = [
  { value: "1d", label: "Today" },
  { value: "7d", label: "7 Day" },
  { value: "30d", label: "30 Day" },
]

interface DateRangeTabsProps {
  value: Period
  onChange: (period: Period) => void
}

export function DateRangeTabs({ value, onChange }: DateRangeTabsProps) {
  return (
    <div role="group" aria-label="Growth period" style={{ display: "flex", gap: 4 }}>
      {PERIODS.map((p) => (
        <button
          key={p.value}
          type="button"
          aria-pressed={value === p.value}
          className="soft-button"
          onClick={() => onChange(p.value)}
        >
          {p.label}
        </button>
      ))}
    </div>
  )
}
