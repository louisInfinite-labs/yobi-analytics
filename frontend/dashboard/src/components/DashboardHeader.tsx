import type { Period } from "../types/domain"
import { formatTimeInZone } from "../lib/format"
import { DateRangeTabs } from "./DateRangeTabs"
import { ThemeSelector } from "./ThemeSelector"
import { TimeZoneSelector } from "./TimeZoneSelector"

interface DashboardHeaderProps {
  lastUpdatedAt: string
  timeZone: string
  onTimeZoneChange: (zone: string) => void
  period: Period
  onPeriodChange: (period: Period) => void
}

/** Page title, last-updated time, and the period/time-zone/theme controls. */
export function DashboardHeader({ lastUpdatedAt, timeZone, onTimeZoneChange, period, onPeriodChange }: DashboardHeaderProps) {
  return (
    <header className="dashboard-header">
      <div className="dashboard-header__title-group">
        <h1 className="dashboard-header__title">Yobi Analytics</h1>
        <div className="dashboard-header__meta">
          <span>Last updated {formatTimeInZone(lastUpdatedAt, timeZone)}</span>
          <span aria-hidden="true">·</span>
          <span>{timeZone}</span>
        </div>
      </div>
      <div className="dashboard-header__controls">
        <DateRangeTabs value={period} onChange={onPeriodChange} />
        <TimeZoneSelector value={timeZone} onChange={onTimeZoneChange} />
        <ThemeSelector />
      </div>
    </header>
  )
}
