/** Synthetic API fixtures for e2e/on-this-day/home-on-this-day.spec.ts. Everything here is invented test data: no value comes from, or is meant to
 * look like, Production. The responders mimic the shapes src/api/read_api.py returns (the on-this-day one is filtered the way the backend filters:
 * by Tokyo month/day, earlier years only, topic / contentType / excludeShorts) so the browser sees realistic requests and responses. */

/** The date the browser is pinned to: 2026-11-25 12:00 in Tokyo. */
export const PINNED_NOW = new Date("2026-11-25T03:00:00Z")

export const CREATOR_ID = "aizawa_ema"
/** A creator whose on-this-day answer is "no historical catalog" (a valid empty answer the view must word differently from "no videos"). */
export const UNAVAILABLE_CREATOR_ID = "usada_pekora"

export interface MemoryRow {
  videoId: string
  title: string
  topic: string | null
  contentType: "live" | "upload" | "short"
  /** Tokyo calendar date. */
  date: string
  eventAt: string
  dateKind: "actualStart" | "published"
}

const live = (videoId: string, date: string, topic: string | null, title: string): MemoryRow => ({
  videoId, title, topic, contentType: "live", date, eventAt: `${date}T10:00:00+09:00`, dateKind: "actualStart",
})
const upload = (videoId: string, date: string, topic: string | null, title: string): MemoryRow => ({
  videoId, title, topic, contentType: "upload", date, eventAt: `${date}T18:00:00+09:00`, dateKind: "published",
})
const short = (videoId: string, date: string, title: string): MemoryRow => ({
  videoId, title, topic: null, contentType: "short", date, eventAt: `${date}T12:00:00+09:00`, dateKind: "published",
})

/** The synthetic catalog the on-this-day responder filters. Today is 2026-11-25, so those rows of THIS year never match (earlier years only). */
export const MEMORY_CATALOG: MemoryRow[] = [
  // 11/25 in earlier years (the default date)
  live("mem-2025-live", "2025-11-25", "minecraft", "2025 Minecraft night stream"),
  upload("mem-2025-mv", "2025-11-25", "mv", "2025 Original song MV"),
  short("mem-2025-short", "2025-11-25", "2025 clip short"),
  live("mem-2024-live", "2024-11-25", "minecraft", "2024 Minecraft build stream"),
  live("mem-2022-live", "2022-11-25", null, "2022 Free talk stream"),
  upload("mem-2022-mv", "2022-11-25", "mv", "2022 Cover MV"),
  // the day after / before (prev and next day)
  live("mem-2025-1126", "2025-11-26", "minecraft", "Next-day stream"),
  upload("mem-2024-1124", "2024-11-24", "mv", "Previous-day upload"),
  // February 29 only exists in leap years
  live("mem-2024-leap", "2024-02-29", "minecraft", "Leap day 2024 stream"),
  upload("mem-2020-leap", "2020-02-29", "mv", "Leap day 2020 upload"),
  // year boundary
  live("mem-2025-1231", "2025-12-31", "minecraft", "New Year's Eve stream"),
  upload("mem-2024-0101", "2024-01-01", "mv", "New Year upload"),
  // this year's same date must never be returned (not an earlier year)
  live("mem-2026-today", "2026-11-25", "minecraft", "TODAY must not appear"),
  // a day with many results, for the truncated note
  live("mem-2023-0707", "2023-07-07", "minecraft", "Tanabata stream"),
]

export const SPECIAL_DAYS = {
  /** Answered after a delay, so the loading state is observable. */
  slow: { month: 3, day: 3 },
  /** Answered with a server error. */
  error: { month: 4, day: 4 },
  /** A valid date with no matching videos. */
  empty: { month: 5, day: 5 },
  /** Answered with `truncated: true`. */
  truncated: { month: 7, day: 7 },
} as const

export const TOPICS = [
  { id: "mv", labels: { "zh-TW": "MV", en: "MV", ja: "MV" } },
  { id: "minecraft", labels: { "zh-TW": "Minecraft", en: "Minecraft", ja: "Minecraft" } },
  { id: "other", labels: { "zh-TW": "其他", en: "Other", ja: "その他" } },
]

const SHELF_TITLES = ["Shelf video one", "Shelf video two", "Shelf video three", "Shelf video four", "Shelf video five", "Shelf video six"]

/** GET /creators/{id}/videos/recent: a plain first page of completed uploads and livestreams. */
export function shelfResponse() {
  return {
    videos: SHELF_TITLES.map((title, index) => ({
      videoId: `shelf-${index + 1}`,
      title,
      publishedAt: `2026-11-${String(20 - index).padStart(2, "0")}T09:00:00+00:00`,
      contentType: index % 2 === 0 ? "live" : "upload",
      currentViewCount: 1200 * (index + 1),
      thumbnailUrl: null,
      discoveredAt: `2026-11-${String(20 - index).padStart(2, "0")}T09:05:00+00:00`,
    })),
    hasMore: false,
  }
}

export const OSHI_STATUS = {
  subscriberCount: 123456,
  latestVideo: { videoId: "shelf-1", title: SHELF_TITLES[0], thumbnailUrl: null, publishedAt: "2026-11-20T09:00:00+00:00", currentViewCount: 1200 },
  thisWeek: { newUploads: 2, newStreams: 3 },
  growth: {
    "24h": { absoluteGrowth: 1200, videoCount: 4 },
    "7d": { absoluteGrowth: 9000, videoCount: 8 },
    "30d": { absoluteGrowth: 40000, videoCount: 20 },
  },
  sinceLastVisit: null,
}

/** The on-this-day answer for one request, filtered like the backend: Tokyo month/day, earlier years only, topic / contentType / excludeShorts. */
export function onThisDayResponse(params: URLSearchParams) {
  const month = Number(params.get("month"))
  const day = Number(params.get("day"))
  const topic = params.get("topic") ?? "all"
  const contentType = params.get("contentType") ?? "all"
  const excludeShorts = params.get("excludeShorts") === "true"
  const rows = MEMORY_CATALOG.filter((row) => {
    const [year, rowMonth, rowDay] = row.date.split("-").map(Number)
    if (rowMonth !== month || rowDay !== day || year >= 2026) return false
    if (topic !== "all" && row.topic !== topic) return false
    if (contentType !== "all" && row.contentType !== contentType) return false
    if (excludeShorts && row.contentType === "short") return false
    return true
  }).sort((a, b) => (a.eventAt < b.eventAt ? 1 : -1))
  const years: { year: number; videos: unknown[] }[] = []
  for (const row of rows) {
    const year = Number(row.date.slice(0, 4))
    if (years.at(-1)?.year !== year) years.push({ year, videos: [] })
    years.at(-1)!.videos.push({
      videoId: row.videoId,
      title: row.title,
      thumbnailUrl: null,
      topic: row.topic,
      contentType: row.contentType,
      liveStatus: row.contentType === "live" ? "completed" : null,
      currentViewCount: 4200,
      publishedAt: row.eventAt,
      date: row.date,
      eventAt: row.eventAt,
      dateKind: row.dateKind,
    })
  }
  const truncated = month === SPECIAL_DAYS.truncated.month && day === SPECIAL_DAYS.truncated.day
  return {
    reportDate: "2026-11-24",
    generatedAt: "2026-11-24T18:05:00+09:00",
    creatorId: CREATOR_ID,
    month,
    day,
    timeZone: "Asia/Tokyo",
    topic,
    contentType,
    years,
    total: truncated ? 500 : rows.length,
    truncated,
    coverage: { catalogStart: "2019-07-18", catalogRows: 900, undatedLivestreams: 12, undatedUploads: 0, unclassified: 0 },
  }
}

/** A tiny synthetic thumbnail, served in place of every YouTube image host so cards render with an image and nothing leaves the machine. */
export const THUMBNAIL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" fill="#9aa5b8"/><circle cx="160" cy="90" r="34" fill="#dfe5ee"/></svg>'
