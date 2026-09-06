import { apiRequest } from "./apiClient"
import type { DailyVideoStat, OrganizationKey, Period } from "../types/domain"

/** One row of `GET /organizations/{organization}/trending`'s `results` array
 * (src/read_api.py's `_ranked_entry_to_dict`) — the real backend's shape,
 * not the frontend's DailyVideoStat shape. Any field the backend doesn't
 * send is nullable here even where DailyVideoStat requires it, so a real
 * response gap fails typecheck-visibly at the adapter boundary instead of
 * silently becoming `undefined` deep in a component. */
interface TrendingResultRow {
  videoId: string
  title: string | null
  creatorId: string | null
  channelName: string | null
  organization: string | null
  branch: string | null
  groupKey: string | null
  channelType: string | null
  lifecycleStage: string | null
  latestViewCount: number
  lastUpdatedAt: string | null
  growth: number
  growthPercent: number | null
  status: "ok" | "pending" | "not_available"
}

interface TrendingResponse {
  timeZone: string
  reportDate: string
  comparisonDate: string
  period: Period
  organization: string
  results: TrendingResultRow[]
}

/** The real API's trending response has no content-classification fields yet
 * (dashboard_ui_direction.md §8: "Until the Read API exposes `contentTags`,
 * frontend mocks must include realistic tag combinations") — every live row
 * gets this same placeholder rather than a guessed value, so the content
 * tag/format filters visibly show "no data" for live rows instead of
 * fabricating a match. */
function toDailyVideoStat(row: TrendingResultRow, reportDate: string): DailyVideoStat {
  return {
    date: reportDate,
    channelId: row.creatorId ?? "",
    channelName: row.channelName ?? "Unknown channel",
    organization: (row.organization ?? "hololive") as OrganizationKey,
    branch: (row.branch ?? "holo_jp") as DailyVideoStat["branch"],
    groupKey: row.groupKey ? [row.groupKey] : [],
    channelType: (row.channelType ?? "member") as DailyVideoStat["channelType"],
    lifecycleStage: (row.lifecycleStage ?? "active") as DailyVideoStat["lifecycleStage"],
    videoId: row.videoId,
    videoTitle: row.title ?? "(untitled)",
    contentFormat: "unknown",
    contentTags: [],
    totalViews: row.latestViewCount,
    dailyIncrease: row.growth,
    growthPercent: row.growthPercent,
    collectedAt: row.lastUpdatedAt ?? reportDate,
    status: row.status,
  }
}

const LIVE_ORGANIZATIONS: OrganizationKey[] = ["hololive", "vspo"]

/** Fetch real trending data for every organization and merge it into one
 * list shaped like the mock fixture, so the rest of the dashboard's
 * filter/derive pipeline needs no live-vs-mock branching downstream of this
 * call. One request per organization because Roadmap 6's bounded-reads
 * design has no single "every organization" endpoint (see read_api.py's
 * get_organization_trending — it always scopes to one). */
export async function fetchLiveAnalytics(
  reportDate: string,
  period: Period,
  timeZone: string,
): Promise<{ results: DailyVideoStat[]; comparisonDate: string; lastUpdatedAt: string | null }> {
  const responses = await Promise.all(
    LIVE_ORGANIZATIONS.map((organization) =>
      apiRequest<TrendingResponse>(
        `/organizations/${organization}/trending?${new URLSearchParams({
          reportDate,
          period,
          timeZone,
          limit: "100",
        })}`,
      ),
    ),
  )

  const results = responses.flatMap((response) => response.results.map((row) => toDailyVideoStat(row, reportDate)))
  const comparisonDate = responses[0]?.comparisonDate ?? reportDate
  const lastUpdatedTimestamps = responses.map((r) => r.results[0]?.lastUpdatedAt).filter((v): v is string => v != null)
  const lastUpdatedAt = lastUpdatedTimestamps.length > 0 ? lastUpdatedTimestamps.sort()[0] : null

  return { results, comparisonDate, lastUpdatedAt }
}
