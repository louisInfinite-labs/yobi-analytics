import { useEffect, useState, type ReactNode } from "react"
import { ApiError, describeApiFailure } from "../../../shared/api/apiClient"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { EmptyState } from "../../../shared/ui/states/EmptyState"
import { ErrorState } from "../../../shared/ui/states/ErrorState"
import { LoadingState } from "../../../shared/ui/states/LoadingState"
import { fetchVideoRanking, type VideoRankingMetric, type VideoRankingResponse } from "../utils/videoRanking"
import { StaleDataNotice } from "./StaleDataNotice"

const METRICS: { value: VideoRankingMetric; label: string }[] = [
  { value: "total", label: "Total" },
  { value: "1d", label: "1D" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
]

/** R9's "Creator Video Ranking" widget: renders exactly one creator's own
 * videos, ranked by the backend (GET /creators/{creatorId}/videos/ranking) --
 * never a merged cross-creator list, and never re-sorted/re-derived here.
 * `creatorId` is null until a creator is dropped onto this widget (Phase 3's
 * "0 creatorIds -> unconfigured state" rule); this component owns its own
 * fetch entirely, independent of every other widget on the page. */
export function CreatorVideoRankingWidget({ creatorId }: { creatorId: string | null }) {
  const [locale] = useLocale()
  const [metric, setMetric] = useState<VideoRankingMetric>("total")
  const [data, setData] = useState<VideoRankingResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [notReady, setNotReady] = useState(false)

  useEffect(() => {
    if (!creatorId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setNotReady(false)
    fetchVideoRanking(creatorId, metric)
      .then((response) => {
        if (!cancelled) setData(response)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.code === "RANKING_NOT_READY") {
          setNotReady(true)
          return
        }
        setError(err instanceof Error ? err : new Error(String(err)))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [creatorId, metric])

  if (!creatorId) {
    return <EmptyState message="Drag a creator onto this widget to configure it." />
  }

  let body: ReactNode
  if (loading) {
    body = <LoadingState rows={5} />
  } else if (error) {
    const { code, description } = describeApiFailure(error, locale)
    body = <ErrorState message={description} code={code} />
  } else if (notReady) {
    body = <EmptyState message="This creator's video ranking has not been computed yet." />
  } else if (!data || data.rows.length === 0) {
    body = <EmptyState message="No ranked videos for this creator yet." />
  } else {
    body = (
      <ol className="creator-video-ranking-widget__list">
        {data.rows.map((row) => (
          <li key={row.videoId} className="creator-video-ranking-widget__row">
            <span className="creator-video-ranking-widget__rank">{row.rank}</span>
            {row.thumbnailUrl ? (
              <img src={row.thumbnailUrl} alt="" className="creator-video-ranking-widget__thumb" />
            ) : (
              <span
                className="creator-video-ranking-widget__thumb creator-video-ranking-widget__thumb--placeholder"
                aria-hidden="true"
              />
            )}
            <span className="creator-video-ranking-widget__title">{row.title ?? row.videoId}</span>
            <span className="creator-video-ranking-widget__value">
              {metric === "total" ? row.currentViewCount.toLocaleString() : `+${(row.absoluteGrowth ?? 0).toLocaleString()}`}
            </span>
          </li>
        ))}
      </ol>
    )
  }

  return (
    <div className="card creator-video-ranking-widget" style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div className="creator-video-ranking-widget__controls" role="group" aria-label="Metric">
        {METRICS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            className={value === metric ? "soft-button soft-button--active" : "soft-button"}
            onClick={() => setMetric(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {body}
      {data && <StaleDataNotice lastUpdatedAt={data.generatedAt} />}
    </div>
  )
}
