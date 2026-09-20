import { mockCreators } from "../data/mockCreators"
import { mockDailySeries } from "../data/mockDailySeries"
import type { ComparisonSource } from "../lib/dashboardComparisonSource"
import type { ComparisonItem } from "../types/dashboardComparisonCatalog"
import type { ComparisonCreatorResult } from "../types/dashboardComparisonData"

/** TEST-ONLY sample source (never imported by production code). It uses the
 * backend's real comparison item ids so fixtures match the real contract, and
 * deterministic sample values so component/page tests need no network.
 * `origin: "mock"` makes the UI label its values as sample data. */
export const FAKE_COMPARISON_ITEMS: ComparisonItem[] = [
  { comparisonItemId: "daily-view-growth", label: "Daily view growth" },
  { comparisonItemId: "total-views", label: "Total views" },
]

function stableFactor(...parts: string[]): number {
  let hash = 0
  for (const char of parts.join("|")) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return 0.05 + (hash % 40) / 100
}

function resultFor(creatorId: string, comparisonItemId: string): ComparisonCreatorResult {
  const creator = mockCreators.find((candidate) => candidate.channelId === creatorId)
  if (!creator || creator.lifecycleStage !== "active") return { status: "unavailable", creatorId }
  const factor = stableFactor(creatorId, comparisonItemId)
  return {
    status: "ok",
    creatorId,
    points: mockDailySeries.map((point) => ({ label: point.date.slice(5), value: Math.round(point.dailyIncrease * factor) })),
  }
}

export const fakeComparisonSource: ComparisonSource = {
  origin: "mock",
  loadItems: () => Promise.resolve(FAKE_COMPARISON_ITEMS.map((item) => ({ ...item }))),
  fetchData: (request) => {
    const comparisonItemId = request.comparisonItemIds[0] ?? ""
    return Promise.resolve({ creators: request.creatorIds.map((creatorId) => resultFor(creatorId, comparisonItemId)) })
  },
}
