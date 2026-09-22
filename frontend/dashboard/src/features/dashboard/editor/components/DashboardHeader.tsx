import type { Period } from "../../../../entities/creator/model/domain"
import { formatTimeInZone } from "../../../../shared/i18n/format"
import { DataSourceToggle, type DataSource } from "../../../analytics/charts/DataSourceToggle"
import { DateRangeTabs } from "../../../analytics/charts/DateRangeTabs"
import { NotificationToggle } from "../../../notifications/components/NotificationToggle"

interface DashboardHeaderProps {
  lastUpdatedAt: string
  timeZone: string
  period: Period
  onPeriodChange: (period: Period) => void
  dataSource: DataSource
  onDataSourceChange: (next: DataSource) => void
}

/** Page title, last-updated time, and the period/time-zone/theme controls. */
export function DashboardHeader({
  lastUpdatedAt,
  timeZone,
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
        <DataSourceToggle value={dataSource} onChange={onDataSourceChange} />
        <NotificationToggle />
      </div>
    </header>
  )
}
