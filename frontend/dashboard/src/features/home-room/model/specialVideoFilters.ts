import type { TranslationKey } from "../../../shared/i18n/translations"

/** Home's Oshi Videos tag bar has two kinds of entries: these 3 frontend-owned
 * UI filter modes, and an open-ended list of backend topics (videoTopicCatalog.ts,
 * dynamically fetched from GET /topics). This type is deliberately the only
 * closed topic-shaped union left in this feature -- it describes UI concepts
 * the backend has no concept of, not backend topic ids. */
export type SpecialVideoFilter = "all" | "latestVideos" | "latestLive"

export const SPECIAL_VIDEO_FILTERS: readonly SpecialVideoFilter[] = ["all", "latestVideos", "latestLive"]

export const SPECIAL_VIDEO_FILTER_LABEL_KEYS: Record<SpecialVideoFilter, TranslationKey> = {
  all: "recentVideos.tag.all",
  latestVideos: "recentVideos.tag.latestVideos",
  latestLive: "recentVideos.tag.latestLive",
}

export function isSpecialVideoFilter(value: string): value is SpecialVideoFilter {
  return (SPECIAL_VIDEO_FILTERS as readonly string[]).includes(value)
}

/** What the tag bar's Segmented control actually selects: one of the 3
 * frontend-owned filters above, or a backend topic id as GET /topics
 * returned it. Not a closed union of topic ids -- a topic the frontend has
 * never seen before is still a valid selection. */
export type VideoSectionSelection = SpecialVideoFilter | string
