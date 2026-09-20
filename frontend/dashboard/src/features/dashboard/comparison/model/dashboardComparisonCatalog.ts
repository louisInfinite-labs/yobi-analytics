/** MT-12 "Flow 2: Creator List Selection and widget[0]-First Save"
 * (frontend/dashboard/DASHBOARD_LAYOUT_GUIDELINES.md, Section 3.4 Flow 2).
 *
 * One backend-supported comparison item as selectable from Flow 2's dialog --
 * the same role `ChartCatalogItem` (../types/dashboardChartCatalog.ts) plays
 * for the chart catalog. No comparison-item catalog endpoint exists in this
 * repository (the same GAP-3-shaped gap DASHBOARD_LAYOUT_IMPLEMENTATION_TASKS.md
 * already records for the chart catalog); `comparisonItemId`/`label` mirror
 * the exact shape that document's own "Shared Deterministic Fixtures"
 * section already defines as the canonical fixture for this contract, so
 * this is the "existing comparison/catalog contract" referenced by MT-12,
 * not a new invented shape.
 */
export interface ComparisonItem {
  comparisonItemId: string
  label: string
}
