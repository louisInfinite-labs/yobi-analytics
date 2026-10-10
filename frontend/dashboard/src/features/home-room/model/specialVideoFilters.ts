import type { TranslationKey } from "../../../shared/i18n/translations"

/** Home's Oshi Videos tag bar has two kinds of entries: these frontend-owned
 * UI filter modes (the 3 leading ones plus "short", which sits right before the Other topic), and an open-ended list of backend topics (videoTopicCatalog.ts,
 * dynamically fetched from GET /topics). This type is deliberately the only
 * closed topic-shaped union left in this feature -- it describes UI concepts
 * the backend has no concept of, not backend topic ids. */
export type SpecialVideoFilter = "all" | "latestVideos" | "latestLive" | "short"

/** The filters that lead the tag bar, in order. "short" is deliberately not here: it renders immediately
 * before the backend's Other topic (see SHORT_VIDEO_FILTER and RecentVideosSection's tagOptions). */
export const SPECIAL_VIDEO_FILTERS: readonly SpecialVideoFilter[] = ["all", "latestVideos", "latestLive"]

/** A content-format filter, not a topic: it asks the backend for contentType=short (the persisted classification). */
export const SHORT_VIDEO_FILTER: SpecialVideoFilter = "short"
/** The backend topic the Short filter sits immediately to the left of. */
export const OTHER_TOPIC_ID = "other"

export const SPECIAL_VIDEO_FILTER_LABEL_KEYS: Record<SpecialVideoFilter, TranslationKey> = {
  all: "recentVideos.tag.all",
  latestVideos: "recentVideos.tag.latestVideos",
  latestLive: "recentVideos.tag.latestLive",
  short: "recentVideos.tag.short",
}

export function isSpecialVideoFilter(value: string): value is SpecialVideoFilter {
  return (SPECIAL_VIDEO_FILTERS as readonly string[]).includes(value) || value === SHORT_VIDEO_FILTER
}

/** What the tag bar's Segmented control actually selects: one of the
 * frontend-owned filters above, or a backend topic id as GET /topics
 * returned it. Not a closed union of topic ids -- a topic the frontend has
 * never seen before is still a valid selection. */
export type VideoSectionSelection = SpecialVideoFilter | string
