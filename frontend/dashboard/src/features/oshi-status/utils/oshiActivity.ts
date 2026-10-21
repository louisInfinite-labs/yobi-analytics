import type { RecentVideo } from "../../../shared/media/model/recentVideo"
import type { NewContentCandidate } from "../../../shared/newContent/newContentTracking"
import type { NewContentEligibility } from "../../home-room/data/oshiVideos"
import { formatClockTime, type TimeFormat } from "../../../shared/i18n/model/timeFormat"

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

/** Clock time for something published today, MM/DD otherwise. */
export function formatActivityTime(iso: string, now: Date, timeFormat: TimeFormat = "24h"): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  const sameDay =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  if (sameDay) return formatClockTime(date, timeFormat)
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`
}

/** The 尚未觀看 totals: every distinct NEW, unopened video once -- the backend's exact eligibility for the WHOLE ALL list (first discovered
 * since the first visit), minus what this browser has opened or watched while live, plus any loaded row the shared NEW judgement also flags
 * (so every NEW badge counts exactly once even if the eligibility is briefly behind). A livestream archive is a livestream; everything else --
 * an upload AND a record with no contentType yet, whose stored value is never changed -- is a video, the same way the Video List already
 * presents it. Set-based by videoId, so a video can never count twice and opening it can never decrement twice. */
function classifyUnwatched(
  eligibility: NewContentEligibility | undefined,
  loaded: RecentVideo[],
  state: { isNew: (candidate: NewContentCandidate, now: Date) => boolean; isUnseen: (videoId: string) => boolean },
  now: Date,
): Map<string, "video" | "livestream"> {
  const kinds = new Map<string, "video" | "livestream">()
  const add = (ids: string[], kind: "video" | "livestream") => {
    for (const videoId of ids) if (!kinds.has(videoId) && state.isUnseen(videoId)) kinds.set(videoId, kind)
  }
  add(eligibility?.videoIds ?? [], "video")
  add(eligibility?.unclassifiedIds ?? [], "video")
  add(eligibility?.livestreamIds ?? [], "livestream")
  for (const row of loaded) {
    if (kinds.has(row.videoId)) continue
    const candidate = { videoId: row.videoId, publishedAt: row.publishedAt, eventAt: row.eventAt, discoveredAt: row.discoveredAt, contentFormat: row.contentFormat }
    if (state.isNew(candidate, now)) kinds.set(row.videoId, row.contentFormat === "live_archive" ? "livestream" : "video")
  }
  return kinds
}

export function countUnwatched(
  eligibility: NewContentEligibility | undefined,
  loaded: RecentVideo[],
  state: { isNew: (candidate: NewContentCandidate, now: Date) => boolean; isUnseen: (videoId: string) => boolean },
  now: Date,
): { videos: number; livestreams: number } {
  const values = [...classifyUnwatched(eligibility, loaded, state, now).values()]
  return { videos: values.filter((kind) => kind === "video").length, livestreams: values.filter((kind) => kind === "livestream").length }
}

/** The ids behind the 尚未觀看 影片 count: exactly the videos countUnwatched counts as videos (never a livestream archive), so marking them seen takes that
 * count to zero and leaves every livestream's NEW state alone. */
export function unwatchedVideoIds(
  eligibility: NewContentEligibility | undefined,
  loaded: RecentVideo[],
  state: { isNew: (candidate: NewContentCandidate, now: Date) => boolean; isUnseen: (videoId: string) => boolean },
  now: Date,
): string[] {
  return [...classifyUnwatched(eligibility, loaded, state, now)].filter(([, kind]) => kind === "video").map(([videoId]) => videoId)
}
