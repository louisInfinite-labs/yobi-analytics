import type { RecentVideo } from "../../../shared/media/model/recentVideo"
import { formatCompactCount } from "../../oshi-status/utils/oshiActivity"

/** "{views} views · MM/DD", dropping either half that's missing data (no viewCount, or an unparseable
 * publishedAt) rather than showing a blank. Extracted from RecentVideosSection so the mobile Videos
 * list (features/video-search) formats a card's meta line identically, not a second copy. */
export function formatCardMeta(video: RecentVideo): string {
  const date = new Date(video.publishedAt)
  const published = Number.isNaN(date.getTime())
    ? ""
    : `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`
  if (typeof video.viewCount !== "number") return published
  return published ? `${formatCompactCount(video.viewCount)} views · ${published}` : `${formatCompactCount(video.viewCount)} views`
}
