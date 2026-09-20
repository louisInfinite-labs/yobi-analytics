import type { Period } from "../../../../entities/creator/model/domain"
import { formatTimeInZone } from "../../../../shared/i18n/format"
import { DataSourceToggle, type DataSource } from "../../../analytics/charts/DataSourceToggle"
import { DateRangeTabs } from "../../../analytics/charts/DateRangeTabs"
import { NotificationToggle } from "../../../notifications/components/NotificationToggle"
import { ThemeSelector } from "../../../../shared/theme/ThemeSelector"
import { TimeZoneSelector } from "../../../../shared/i18n/components/TimeZoneSelector"
import { UpcomingDisplaySettings } from "../../../live-status/components/UpcomingDisplaySettings"

interface DashboardHeaderProps {
  lastUpdatedAt: string
  timeZone: string
  onTimeZoneChange: (zone: string) => void
  period: Period
  onPeriodChange: (period: Period) => void
  dataSource: DataSource
  onDataSourceChange: (next: DataSource) => void
}

/** Page title, last-updated time, and the period/time-zone/theme controls. */
export function DashboardHeader({
  lastUpdatedAt,
  timeZone,
  onTimeZoneChange,
  period,
  onPeriodChange,
  dataSource,
  onDataSourceChange,
}: DashboardHeaderProps) {
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
        <DataSourceToggle value={dataSource} onChange={onDataSourceChange} />
        <ThemeSelector />
        <UpcomingDisplaySettings />
        <NotificationToggle />
      </div>
    </header>
  )
}
