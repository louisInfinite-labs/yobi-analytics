import { useEffect, useState } from "react"
import { EMPTY_ON_THIS_DAY, fetchOnThisDay, type OnThisDayResult } from "../data/onThisDay"
import { onThisDayQueryKey, type MonthDay, type OnThisDayFilters } from "../model/onThisDay"

interface OnThisDayState {
  /** The request this state belongs to: a result is only ever shown for ITS OWN key. */
  key: string
  result: OnThisDayResult
  error: Error | null
}

/** The On-this-day memories for the current creator + date + filters. `creatorId === undefined` or `enabled === false` fetches nothing.
 * One request per distinct key, cancelled when the key changes or the view closes; there is no polling, and a response for an older key can never
 * render (loading is derived: no result for the CURRENT key yet). */
export function useOnThisDay(creatorId: string | undefined, monthDay: MonthDay, filters: OnThisDayFilters, enabled: boolean) {
  const key = creatorId ? onThisDayQueryKey(creatorId, monthDay, filters) : ""
  const [state, setState] = useState<OnThisDayState | null>(null)
  const { month, day } = monthDay
  const { topic, contentType, excludeShorts } = filters

  useEffect(() => {
    if (!enabled || !creatorId) return
    const controller = new AbortController()
    fetchOnThisDay(creatorId, { month, day }, { topic, contentType, excludeShorts }, controller.signal).then(
      (result) => setState({ key, result, error: null }),
      (error: unknown) => {
        if (controller.signal.aborted) return
        setState({ key, result: EMPTY_ON_THIS_DAY, error: error instanceof Error ? error : new Error(String(error)) })
      },
    )
    return () => controller.abort()
  }, [enabled, creatorId, month, day, topic, contentType, excludeShorts, key])

  const current = enabled && state?.key === key ? state : null
  return { loading: enabled && Boolean(creatorId) && current === null, error: current?.error ?? null, result: current?.result ?? EMPTY_ON_THIS_DAY }
}
