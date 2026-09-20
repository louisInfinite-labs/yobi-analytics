import { useCallback, useMemo, useState } from "react"
import {
  canStartComparison,
  comparisonOrderOf,
  dedupePreservingOrder,
  toggleCreatorSelection,
} from "../utils/creatorComparisonOrder"

export interface OrderedCreatorSelection {
  /** Selected creator ids, in click order (index 0 is comparison order 1). */
  orderedIds: string[]
  /** Selects an unselected creator (appended to the end) or deselects an
   * already-selected one (MT-10 AC1, AC4, AC5). */
  toggle: (creatorId: string) => void
  /** 1-based comparison order for `creatorId`, or `null` if unselected. */
  orderOf: (creatorId: string) => number | null
  /** MT-10 AC8: true once at least two distinct creators are selected. */
  canCompare: boolean
}

/** MT-10 "Ordered Creator Selection and Badges" as local, per-instance React
 * state -- deliberately not a shared/persisted store like
 * useFavoriteCreators/useSelectedCreator (../hooks/useFavoriteCreators.ts,
 * ../hooks/useSelectedCreator.ts): each mounted instance (e.g. one future
 * in-widget comparison picker) owns its own independent selection, seeded
 * once from whatever creatorIds that specific caller already has (MT-10 has
 * no widget/persistence ownership of its own -- see
 * ../lib/creatorComparisonOrder.ts's header). Toggling this selection never
 * reads or writes useSelectedCreator's shared "active Oshi" store, which is
 * what keeps MT-10 AC10 ("Creator selection does not change the
 * application's active creator") true by construction rather than by
 * convention. */
export function useOrderedCreatorSelection(initialCreatorIds: readonly string[] = []): OrderedCreatorSelection {
  const [orderedIds, setOrderedIds] = useState<string[]>(() => dedupePreservingOrder(initialCreatorIds))

  const toggle = useCallback((creatorId: string) => {
    setOrderedIds((previous) => toggleCreatorSelection(previous, creatorId))
  }, [])

  const orderOf = useCallback((creatorId: string) => comparisonOrderOf(orderedIds, creatorId), [orderedIds])

  const canCompare = useMemo(() => canStartComparison(orderedIds), [orderedIds])

  return { orderedIds, toggle, orderOf, canCompare }
}
