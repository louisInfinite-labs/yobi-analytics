/** MT-04 "Chart Catalog Single-Load Behavior"
 * (frontend/dashboard/DASHBOARD_LAYOUT_GUIDELINES.md, Section 3.2).
 *
 * One catalog item as returned by the backend chart catalog endpoint --
 * the source of truth for what a user may add to the Dashboard (Section
 * 3.2: "Do not maintain a separate hard-coded frontend list that can drift
 * from the backend."). Separate from `DashboardWidget` (../types/
 * dashboardLayout.ts): a catalog item describes an addable chart
 * definition, not a placed widget instance, and carries its own stable
 * `chartDefinitionId` rather than a `widgetId`.
 */
export interface ChartCatalogItem {
  chartDefinitionId: string
  title: string
}
