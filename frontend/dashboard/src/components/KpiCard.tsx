import type { ReactNode } from "react"
import { formatCompactNumber } from "../lib/format"
import { GrowthBadge } from "./GrowthBadge"

interface KpiCardProps {
  label: string
  value: number | string
  growthPercent?: number | null
  sub?: ReactNode
  formatAsCompactNumber?: boolean
}

export function KpiCard({ label, value, growthPercent, sub, formatAsCompactNumber = true }: KpiCardProps) {
  const displayValue = typeof value === "number" && formatAsCompactNumber ? formatCompactNumber(value) : value

  return (
    <div className="card kpi-card">
      <span className="kpi-card__label">{label}</span>
      <span className="kpi-card__value">{displayValue}</span>
      <div className="kpi-card__sub">
        {growthPercent !== undefined && <GrowthBadge percent={growthPercent} label={label} />}
        {sub}
      </div>
    </div>
  )
}
