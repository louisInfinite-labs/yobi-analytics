import { useEffect, useState, type ReactNode } from "react"
import { mockCreators } from "../../../entities/creator/data/mockCreators"
import { ApiError, describeApiFailure } from "../../../shared/api/apiClient"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { EmptyState } from "../../../shared/ui/states/EmptyState"
import { ErrorState } from "../../../shared/ui/states/ErrorState"
import { LoadingState } from "../../../shared/ui/states/LoadingState"
import { StaleDataNotice } from "./StaleDataNotice"
import {
  fetchSubscriberLeaderboard,
  type SubscriberLeaderboardMetric,
  type SubscriberLeaderboardOrganization,
  type SubscriberLeaderboardResponse,
} from "../utils/subscriberLeaderboard"

const METRICS: { value: SubscriberLeaderboardMetric; label: string }[] = [
  { value: "total", label: "Total" },
  { value: "1d", label: "1D" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
]

const ORGANIZATIONS: { value: SubscriberLeaderboardOrganization; label: string }[] = [
  { value: "all", label: "All" },
  { value: "vspo", label: "VSPO" },
  { value: "hololive", label: "Hololive" },
]

function creatorName(creatorId: string): string {
  return mockCreators.find((creator) => creator.channelId === creatorId)?.channelName ?? creatorId
}

/** R9's "Subscriber Leaderboard" widget: renders GET /subscribers/leaderboard
 * directly, using the backend's own rank/order -- org-scoped (all/vspo/
 * hololive), never creator-scoped (this product has no single-creator
 * variant, unlike CreatorVideoRankingWidget). */
export function SubscriberLeaderboardWidget() {
  const [locale] = useLocale()
  const [metric, setMetric] = useState<SubscriberLeaderboardMetric>("total")
  const [organization, setOrganization] = useState<SubscriberLeaderboardOrganization>("all")
  const [data, setData] = useState<SubscriberLeaderboardResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [notReady, setNotReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setNotReady(false)
    fetchSubscriberLeaderboard(metric, organization)
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
  }, [metric, organization])

  let body: ReactNode
  if (loading) {
    body = <LoadingState rows={5} />
  } else if (error) {
    const { code, description } = describeApiFailure(error, locale)
    body = <ErrorState message={description} code={code} />
  } else if (notReady) {
    body = <EmptyState message="The subscriber leaderboard has not been computed yet." />
  } else if (!data || data.rows.length === 0) {
    body = <EmptyState message="No creators ranked yet." />
  } else {
    body = (
      <ol className="subscriber-leaderboard-widget__list">
        {data.rows.map((row) => (
          <li key={row.creatorId} className="subscriber-leaderboard-widget__row">
            <span className="subscriber-leaderboard-widget__rank">{row.rank}</span>
            <span className="subscriber-leaderboard-widget__name">{creatorName(row.creatorId)}</span>
            <span className="subscriber-leaderboard-widget__value">
              {metric === "total"
                ? (row.subscriberCount ?? 0).toLocaleString()
                : `+${(row.absoluteGrowth ?? 0).toLocaleString()}`}
            </span>
          </li>
        ))}
      </ol>
    )
  }

  return (
    <div className="card subscriber-leaderboard-widget" style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div className="subscriber-leaderboard-widget__controls">
        <div role="group" aria-label="Organization">
          {ORGANIZATIONS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={value === organization ? "soft-button soft-button--active" : "soft-button"}
              onClick={() => setOrganization(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div role="group" aria-label="Metric">
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
      </div>
      {body}
      {data && <StaleDataNotice lastUpdatedAt={data.generatedAt} />}
    </div>
  )
}
