import { useEffect, useRef, useState } from "react"
import { isHistoricalDataUnavailable } from "../../../shared/api/apiClient"
import { fetchOshiStatus, type OshiStatusData } from "../data/oshiStatus"

interface OshiStatusResult {
  /** The creator + since this result belongs to -- a result is only ever shown for ITS OWN key. */
  key: string
  data: OshiStatusData | null
  error: Error | null
}

export interface OshiStatusState {
  data: OshiStatusData | null
  loading: boolean
  error: Error | null
}

/** Oshi Status data for the CURRENT creator (`creatorId` = canonical id, undefined when the creator
 * has none -- then nothing is fetched). `since` is the browser's stored previous-visit time.
 *
 * Same stale-response rules as useOshiVideos: the stored result is keyed by creator + since and only
 * returned for the CURRENT key, so a previous creator's status never shows after a switch, and a
 * response that resolves after the key changed is dropped by a generation check. A failed request
 * yields no data (the panel shows its empty placeholders), never another creator's numbers. */
export function useOshiStatus(creatorId: string | undefined, since: Date | null): OshiStatusState {
  const sinceKey = since ? since.toISOString() : ""
  const key = creatorId ? `${creatorId}|${sinceKey}` : null
  const [result, setResult] = useState<OshiStatusResult | null>(null)
  const generationRef = useRef(0)

  useEffect(() => {
    const generation = ++generationRef.current
    if (!creatorId || key === null) return

    fetchOshiStatus(creatorId, sinceKey ? new Date(sinceKey) : null)
      .then((data) => {
        if (generation === generationRef.current) setResult({ key, data, error: null })
      })
      .catch((err: unknown) => {
        if (generation === generationRef.current) {
          // A creator with no available historical catalog shows the panel's empty placeholders, not an error.
          const error = isHistoricalDataUnavailable(err) ? null : err instanceof Error ? err : new Error(String(err))
          setResult({ key, data: null, error })
        }
      })
  }, [creatorId, sinceKey, key])

  if (key === null) return { data: null, loading: false, error: null }
  const current = result && result.key === key ? result : null
  return { data: current ? current.data : null, loading: current === null, error: current ? current.error : null }
}
