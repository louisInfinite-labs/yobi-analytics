import type { RecentVideo } from "../../../shared/media/model/recentVideo"

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export interface ActivityMetrics {
  uploads: number
  streams: number
}

export interface ActivityEntry {
  videoId: string
  title: string
  publishedAt: string
}

/** `since` exclusive, `until` inclusive -- so two adjacent windows (e.g. this
 * week vs. since-last-visit) never double-count a video published exactly on
 * their shared boundary. An unparseable publishedAt never matches. */
function publishedWithin(video: RecentVideo, since: Date, until: Date): boolean {
  const published = new Date(video.publishedAt).getTime()
  return Number.isFinite(published) && published > since.getTime() && published <= until.getTime()
}

/** Upload and completed-stream counts inside one time window, derived from
 * the two already-loaded video pools — no extra fetch, no second data flow.
 *
 * View GROWTH is deliberately absent: it means the view delta across all of
 * a creator's tracked videos in the window (a two-year-old video gaining
 * 200K views this week counts), and no channel-level time series exists in
 * this app. Summing the current viewCount of videos published in the window
 * answers a different question, so the panel shows an explicit "no data"
 * placeholder for that metric instead of substituting this one. */
export function measureActivity(uploads: RecentVideo[], streams: RecentVideo[], since: Date, until: Date): ActivityMetrics {
  const newUploads = uploads.filter((video) => publishedWithin(video, since, until))
  // live_upcoming hasn't happened yet, so it isn't a completed stream.
  const newStreams = streams.filter((video) => video.contentFormat !== "live_upcoming" && publishedWithin(video, since, until))
  return { uploads: newUploads.length, streams: newStreams.length }
}

/** Both pools merged, newest first, deduped by videoId. */
export function selectRecentActivity(uploads: RecentVideo[], streams: RecentVideo[], limit: number): ActivityEntry[] {
  const byId = new Map<string, RecentVideo>()
  for (const video of [...uploads, ...streams]) {
    if (!byId.has(video.videoId)) byId.set(video.videoId, video)
  }
  return [...byId.values()]
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
    .slice(0, limit)
    .map(({ videoId, title, publishedAt }) => ({ videoId, title, publishedAt }))
}

/** Compact metric value: 1.2K / 3.4M, matching the tight metric column. */
export function formatCompactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

/** True only once there IS a previous visit to compare against and
 * `publishedAt` falls after it (same exclusive/inclusive boundary as
 * publishedWithin, for the same double-count reason) -- a first-ever visit
 * has no baseline, so nothing is "new" yet rather than everything being. */
export function isUnseenActivity(publishedAt: string, previousVisit: Date | null, now: Date): boolean {
  if (!previousVisit) return false
  const published = new Date(publishedAt).getTime()
  return Number.isFinite(published) && published > previousVisit.getTime() && published <= now.getTime()
}

/** HH:mm for something published today, MM/DD otherwise. */
export function formatActivityTime(iso: string, now: Date): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  const sameDay =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  if (sameDay) return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`
}
