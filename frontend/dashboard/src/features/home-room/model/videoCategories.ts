import type { TranslationKey } from "../../../shared/i18n/translations"
import type { VideoCategory } from "../../../shared/media/model/videoCategory"

/** The tag bar's 10 selectable tags: the 2 existing pool-selectors
 * ("latestVideos"/"latestLive", i.e. today's two separate rows), "all"
 * (every video regardless of category), and the 7 VideoCategory values. */
export type VideoSectionTag = "latestVideos" | "latestLive" | "all" | VideoCategory

/** Fixed display order (spec: exact order, not alphabetical/count/recency/
 * LIVE-status based). */
export const VIDEO_SECTION_TAGS: readonly VideoSectionTag[] = [
  "latestVideos",
  "latestLive",
  "all",
  "sf6",
  "valo",
  "minecraft",
  "apex",
  "singing",
  "chatting",
  "other",
]

export const VIDEO_SECTION_TAG_LABEL_KEYS: Record<VideoSectionTag, TranslationKey> = {
  latestVideos: "recentVideos.tag.latestVideos",
  latestLive: "recentVideos.tag.latestLive",
  all: "recentVideos.tag.all",
  sf6: "recentVideos.tag.sf6",
  valo: "recentVideos.tag.valo",
  minecraft: "recentVideos.tag.minecraft",
  apex: "recentVideos.tag.apex",
  singing: "recentVideos.tag.singing",
  chatting: "recentVideos.tag.chatting",
  other: "recentVideos.tag.other",
}
