import { NotificationToggle } from "../../../notifications/components/NotificationToggle"

/** Page title and the theme/notification controls.
 *
 * R9 (org-trending retirement): the period/time-zone/last-updated/data-source
 * controls this header used to show were page-level concepts belonging to
 * the old shared org-wide fetch (DateRangeTabs, DataSourceToggle). Each
 * widget now owns its own independent fetch, metric selection, and
 * freshness -- there is no single page-level value left to show here. */
export function DashboardHeader() {
  return (
    <header className="dashboard-header">
      <div className="dashboard-header__title-group">
        <h1 className="dashboard-header__title">Yobi Analytics</h1>
      </div>
      <div className="dashboard-header__controls">
        <NotificationToggle />
      </div>
    </header>
  )
}
