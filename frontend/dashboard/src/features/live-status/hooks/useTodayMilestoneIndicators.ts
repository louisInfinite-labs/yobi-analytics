import { useEffect, useMemo, useState } from "react"
import { getCachedAllCreatorMilestones, loadAllCreatorMilestones, type AllCreatorMilestones } from "../../oshi-status/data/allCreatorMilestones"
import { useJstDayStart } from "../../../shared/time/jstDay"
import { computeTodayIndicators, type MilestoneIndicatorKind } from "../model/milestoneToday"

/** Today (JST) birthday / debut-anniversary indicators for the Live Status roster, keyed by canonical creatorId; creators with no event today are absent.
 * The dates come from ONE shared bulk read (see allCreatorMilestones); the indicators are recomputed only when the JST day changes (or the tab returns),
 * never per second and never per creator.
 *
 * The dates are loaded when this list mounts, and a stale copy (older than an hour) is revalidated the next time it is needed again: when the list mounts
 * again, or the tab becomes visible / the window regains focus / the page is restored. There is no polling, and neither a countdown tick nor JST midnight
 * triggers a request. Data already held keeps showing while revalidating and if revalidation fails; with nothing held (loading, or unreadable) the map is
 * empty: nothing is shown and nothing is invented. */
export function useTodayMilestoneIndicators(): Record<string, MilestoneIndicatorKind> {
  const dayStart = useJstDayStart()
  const [loaded, setLoaded] = useState<AllCreatorMilestones | null>(() => getCachedAllCreatorMilestones())

  useEffect(() => {
    let cancelled = false
    const revalidate = () => {
      loadAllCreatorMilestones()
        .then((result) => {
          if (!cancelled) setLoaded((previous) => (previous === result ? previous : result))
        })
        .catch(() => {
          // Nothing held and unreadable: no indicators (never a guess). The loader holds off retrying for a while.
        })
    }
    const onVisible = () => {
      if (document.visibilityState !== "hidden") revalidate()
    }
    revalidate()
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("focus", revalidate)
    window.addEventListener("pageshow", revalidate)
    return () => {
      cancelled = true
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("focus", revalidate)
      window.removeEventListener("pageshow", revalidate)
    }
  }, [])

  return useMemo(() => (loaded ? computeTodayIndicators(loaded, dayStart) : {}), [loaded, dayStart])
}