/** MT-14 "Comparison Data and Render States" (Section 3.4 "Comparison data").
 *
 * Pure pivot from ordered per-creator point lists into shared chart rows
 * keyed by `label`, in first-seen label order. A creator missing a point for
 * a given label simply leaves that key absent on the row rather than a
 * fabricated `0` -- Guidelines Section 3.4: "Do not fabricate missing
 * creators, metrics, time ranges, or values in the frontend." `<Line
 * connectNulls={false}>` (the Recharts default) renders a gap there instead
 * of a false zero.
 */
import type { ComparisonSeriesPoint } from "../types/dashboardComparisonData"

export interface ComparisonChartRow {
  label: string
  [creatorId: string]: string | number
}

export interface OkComparisonSeries {
  creatorId: string
  points: readonly ComparisonSeriesPoint[]
}

export function buildComparisonChartRows(okResults: readonly OkComparisonSeries[]): ComparisonChartRow[] {
  const labelOrder: string[] = []
  const rowsByLabel = new Map<string, ComparisonChartRow>()

  for (const result of okResults) {
    for (const point of result.points) {
      let row = rowsByLabel.get(point.label)
      if (!row) {
        row = { label: point.label }
        rowsByLabel.set(point.label, row)
        labelOrder.push(point.label)
      }
      row[result.creatorId] = point.value
    }
  }

  return labelOrder.map((label) => rowsByLabel.get(label)!)
}
