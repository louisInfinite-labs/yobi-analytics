/** MT-10 "Ordered Creator Selection and Badges"
 * (DASHBOARD_LAYOUT_GUIDELINES.md Section 3.4, DASHBOARD_LAYOUT_IMPLEMENTATION_TASKS.md MT-10).
 *
 * Pure ordered-selection semantics only: click order -> ordered,
 * deduplicated `creatorId` list. Comparison order is the array's own
 * position (index + 1), so "renumber the remaining creators consecutively"
 * after a deselection (Section 3.4) falls out of a plain `filter` -- there
 * is no separate order counter that could drift from the array itself.
 *
 * Deliberately scoped to selection order alone. Attaching this order to a
 * specific Dashboard widget (`DashboardWidget`/`CreatorComparisonConfig`,
 * ../types/dashboardLayout.ts), an in-widget picker UI reusing the existing
 * Creator List, catalog-driven comparison-widget-type detection, and
 * persistence are a different production surface that MT-10's own
 * acceptance criteria (DASHBOARD_LAYOUT_IMPLEMENTATION_TASKS.md MT-10 AC1-10)
 * do not require and are not built here -- see that microtask's dependents
 * (MT-11 onward) for that ownership.
 */

export const MIN_COMPARISON_CREATORS = 2

/** Adds `creatorId` to the end of `orderedIds` if not already present.
 * Idempotent: calling this twice in a row with the same id never produces a
 * duplicate entry (MT-10 AC7 "Duplicate creator selection is rejected"). */
export function addCreatorToOrder(orderedIds: readonly string[], creatorId: string): string[] {
  if (orderedIds.includes(creatorId)) return [...orderedIds]
  return [...orderedIds, creatorId]
}

/** Removes `creatorId` from `orderedIds`. Every remaining id's comparison
 * order is simply its new array position, so filtering out one entry is the
 * entire renumbering step (MT-10 AC4: "Deselecting B produces A(1) and
 * C(2)") -- there is no separate order field that could disagree with the
 * array. */
export function removeCreatorFromOrder(orderedIds: readonly string[], creatorId: string): string[] {
  return orderedIds.filter((id) => id !== creatorId)
}

/** Click-order toggle: selects an unselected creator by appending it to the
 * end, or deselects an already-selected one. Reselecting a previously
 * deselected creator therefore appends it to the end rather than restoring
 * its old position (MT-10 AC5: "Reselecting B produces A(1), C(2), and
 * B(3)"), because selection is a plain remove-then-add, never an in-place
 * reinsertion. */
export function toggleCreatorSelection(orderedIds: readonly string[], creatorId: string): string[] {
  return orderedIds.includes(creatorId)
    ? removeCreatorFromOrder(orderedIds, creatorId)
    : addCreatorToOrder(orderedIds, creatorId)
}

/** 1-based comparison order for `creatorId` within `orderedIds`, or `null`
 * when it is not currently selected. */
export function comparisonOrderOf(orderedIds: readonly string[], creatorId: string): number | null {
  const index = orderedIds.indexOf(creatorId)
  return index === -1 ? null : index + 1
}

/** MT-10 AC8: comparison requires at least two distinct selected creators. */
export function canStartComparison(orderedIds: readonly string[]): boolean {
  return orderedIds.length >= MIN_COMPARISON_CREATORS
}

/** Removes duplicates from a candidate initial/seed id list while preserving
 * first-occurrence order, for callers seeding selection from an already
 * saved (and therefore already-validated) id list. */
export function dedupePreservingOrder(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}
