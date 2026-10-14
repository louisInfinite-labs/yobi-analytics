import { useMemo } from "react"
import type { Locale } from "../../../shared/i18n/translations"
import { t } from "../../../shared/i18n/translations"
import { buildVideoFilterEntries } from "../model/videoFilterCatalog"
import { SPECIAL_VIDEO_FILTERS, SPECIAL_VIDEO_FILTER_LABEL_KEYS, type SpecialVideoFilter, type VideoSectionSelection } from "../model/specialVideoFilters"
import { fetchVideoTopics } from "../data/videoTopics"
import { useVideoTopicCatalog } from "./useVideoTopicCatalog"
import type { BackendVideoTopic } from "../model/videoTopicCatalog"

export interface VideoTagOption {
  value: VideoSectionSelection
  label: string
}

export interface VideoTagOptionsResult {
  options: VideoTagOption[]
  /** The raw backend topic catalog (GET /topics) this SAME hook instance already downloaded to build
   * `options` -- reused as-is by Video Search's local canonical-topic resolution (features/video-search/
   * model/topicResolution.ts via useVideoSearch's `topics` option) so Search never triggers its OWN
   * /topics fetch; empty until the catalog finishes loading (never undefined/null, so a caller never
   * needs a separate loading check just to pass this through). */
  topics: BackendVideoTopic[]
}

/** The ONE authoritative Video Tag option list -- the 3 frontend-owned quick filters, then the
 * backend's own topics in their own order, then Short -- shared by desktop's Oshi Videos header and the
 * mobile Filter sheet's Video Topic section (features/video-search), so neither ever maintains its own
 * copy of this list. Extracted from RecentVideosSection, which used to compute this inline. Also the
 * ONE place each of its two callers (RecentVideosSection, VideosPage) loads GET /topics at all -- Video
 * Search reuses `topics` from this same result instead of loading its own copy. */
export function useVideoTagOptions(locale: Locale): VideoTagOptionsResult {
  const topicCatalogState = useVideoTopicCatalog(fetchVideoTopics).state
  const topics = topicCatalogState.status === "success" ? topicCatalogState.topics : []

  const options = useMemo(() => {
    const option = (filter: SpecialVideoFilter): VideoTagOption => ({
      value: filter as VideoSectionSelection,
      label: t(locale, SPECIAL_VIDEO_FILTER_LABEL_KEYS[filter]),
    })
    const special = SPECIAL_VIDEO_FILTERS.map(option)
    const categories = buildVideoFilterEntries(topicCatalogState.status === "success" ? topicCatalogState.topics : null, locale)
    return [...special, ...categories.map((entry): VideoTagOption => ({ value: entry.id as VideoSectionSelection, label: entry.label }))]
  }, [locale, topicCatalogState])

  return { options, topics }
}
