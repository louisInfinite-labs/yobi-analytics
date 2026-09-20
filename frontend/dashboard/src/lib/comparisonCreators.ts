import type { ComparisonChartCreator } from "../components/ComparisonChart"

/** Resolves a widget's ordered comparison `creatorIds` to the display
 * records the chart and order list need, one per id and in exactly the given
 * order. An id missing from the roster is kept (name falls back to the id
 * itself) so it still reaches the request -- the backend, not the frontend,
 * decides whether a creator is unavailable, and no configured id is ever
 * silently dropped or reordered. */
export function resolveComparisonCreators(
  creatorIds: readonly string[],
  roster: readonly ComparisonChartCreator[],
): ComparisonChartCreator[] {
  const byId = new Map(roster.map((creator) => [creator.channelId, creator]))
  return creatorIds.map((creatorId) => {
    const known = byId.get(creatorId)
    return known ? { channelId: known.channelId, channelName: known.channelName } : { channelId: creatorId, channelName: creatorId }
  })
}
