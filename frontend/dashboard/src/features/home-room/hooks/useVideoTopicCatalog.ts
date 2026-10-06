/** Home Oshi Videos' own single-load fetch of the backend topic catalog
 * (GET /topics, data/videoTopics.ts's fetchVideoTopics). Same small pattern
 * as Dashboard's useChartCatalog (features/dashboard/catalog/hooks/
 * useChartCatalog.ts, MT-04 "Chart Catalog Single-Load Behavior"): load once
 * per mounted instance, reuse that result for every consumer, and issue
 * exactly one additional request on an explicit retry() -- never a second
 * request just because a re-render happened. Topic taxonomy is not
 * fast-changing data, so there is no polling here either.
 *
 * A separate hook rather than generalizing useChartCatalog: that hook's
 * shape is pinned to Dashboard's own MT-04 contract (a Dashboard-owned
 * file), and this is Home's own feature-owned copy of the same otherwise-
 * identical state machine, not a second implementation of a different idea.
 *
 * A single request-in-flight promise, cached in a ref across the whole
 * component lifetime, is what keeps repeated effect invocations (React
 * Strict Mode's mount/cleanup/mount double-invoke, or any unrelated
 * re-render) from issuing a second request. */
import { useCallback, useEffect, useRef, useState } from "react"
import type { BackendVideoTopic } from "../model/videoTopicCatalog"

export type VideoTopicCatalogState =
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "success"; topics: BackendVideoTopic[] }

export interface UseVideoTopicCatalogResult {
  state: VideoTopicCatalogState
  /** Issues exactly one additional request, replacing whatever request is currently cached. */
  retry: () => void
}

export function useVideoTopicCatalog(fetchTopics: () => Promise<BackendVideoTopic[]>): UseVideoTopicCatalogResult {
  const [state, setState] = useState<VideoTopicCatalogState>({ status: "loading" })
  const [retryToken, setRetryToken] = useState(0)
  const requestRef = useRef<Promise<BackendVideoTopic[]> | null>(null)

  useEffect(() => {
    let cancelled = false

    if (!requestRef.current) {
      requestRef.current = fetchTopics()
    }
    // A retry from the error state must show loading again; a Strict Mode
    // replay of an already-succeeded mount must not flash loading over
    // data that's already on screen.
    setState((current) => (current.status === "success" ? current : { status: "loading" }))

    requestRef.current.then(
      (topics) => {
        if (!cancelled) setState({ status: "success", topics })
      },
      (err: unknown) => {
        if (!cancelled) setState({ status: "error", error: err instanceof Error ? err : new Error(String(err)) })
      },
    )

    return () => {
      cancelled = true
    }
    // Intentionally keyed only on retryToken: a new fetchTopics identity
    // (e.g. from a parent re-render) must not by itself trigger a reload --
    // only an explicit retry() may start a new request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryToken])

  const retry = useCallback(() => {
    requestRef.current = null
    setRetryToken((token) => token + 1)
  }, [])

  return { state, retry }
}
