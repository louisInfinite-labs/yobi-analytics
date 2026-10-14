import { t, type Locale } from "../../../shared/i18n/translations"
import { VIDEO_CONTENT_TYPES, VIDEO_VIEW_WINDOWS, type VideoContentType, type VideoViewWindow } from "../model/oshiVideosQuery"
import type { VideoSortOption } from "../utils/recentVideosSelection"

/** The three existing Video List Filter/Sort dropdowns (content type / sort / view window), extracted
 * from RecentVideosSection so the mobile Filter sheet (features/video-search) renders the exact same
 * controls -- same class, same options, same labels -- rather than a second, manually maintained copy.
 * Desktop's own rendering and behavior are unchanged: this is the same markup that used to live inline. */

export const VIDEO_SORT_OPTIONS: readonly VideoSortOption[] = ["newest", "oldest", "mostViews"]
const SORT_LABEL_KEYS = {
  newest: "recentVideos.sort.newest",
  oldest: "recentVideos.sort.oldest",
  mostViews: "recentVideos.sort.mostViews",
} as const
/** The UI shows the backend's canonical "upload" content type as 影片 / Videos. */
const CONTENT_TYPE_LABEL_KEYS = {
  all: "recentVideos.contentType.all",
  live: "recentVideos.contentType.live",
  upload: "recentVideos.contentType.video",
} as const

/** The sort dropdown: exactly Newest / Oldest / Most viewed -- "Most viewed" is itself selectable
 * (its All/1d/7d/30d period is a separate dropdown, see ViewWindowDropdown). */
export function VideoSortDropdown({
  value,
  onChange,
  locale,
  hidden,
}: {
  value: VideoSortOption
  onChange: (sort: VideoSortOption) => void
  locale: Locale
  hidden: boolean
}) {
  return (
    <select
      className="oshi-videos__sort"
      style={{ visibility: hidden ? "hidden" : "visible" }}
      value={value}
      onChange={(event) => onChange(event.target.value as VideoSortOption)}
      aria-label={t(locale, "recentVideos.sortAriaLabel")}
      aria-hidden={hidden}
      tabIndex={hidden ? -1 : undefined}
    >
      {VIDEO_SORT_OPTIONS.map((sort) => (
        <option key={sort} value={sort}>
          {t(locale, SORT_LABEL_KEYS[sort])}
        </option>
      ))}
    </select>
  )
}

/** The period dropdown (All / 1d / 7d / 30d): rendered ONLY while the sort is "most viewed", right
 * beside the sort dropdown. It is not rendered at all for newest/oldest. */
export function ViewWindowDropdown({
  value,
  onChange,
  locale,
}: {
  value: VideoViewWindow
  onChange: (window: VideoViewWindow) => void
  locale: Locale
}) {
  return (
    <select
      className="oshi-videos__sort"
      value={value}
      onChange={(event) => onChange(event.target.value as VideoViewWindow)}
      aria-label={t(locale, "recentVideos.windowAriaLabel")}
    >
      {VIDEO_VIEW_WINDOWS.map((window) => (
        <option key={window} value={window}>
          {t(locale, `recentVideos.window.${window}`)}
        </option>
      ))}
    </select>
  )
}

/** All / Live / Videos -- narrows the selected topic (ALL included) to one content type. */
export function ContentTypeDropdown({
  value,
  onChange,
  locale,
  hidden,
}: {
  value: VideoContentType
  onChange: (contentType: VideoContentType) => void
  locale: Locale
  hidden: boolean
}) {
  return (
    <select
      className="oshi-videos__sort"
      style={{ visibility: hidden ? "hidden" : "visible" }}
      value={value}
      onChange={(event) => onChange(event.target.value as VideoContentType)}
      aria-label={t(locale, "recentVideos.contentTypeAriaLabel")}
      aria-hidden={hidden}
      tabIndex={hidden ? -1 : undefined}
    >
      {VIDEO_CONTENT_TYPES.map((type) => (
        <option key={type} value={type}>
          {t(locale, CONTENT_TYPE_LABEL_KEYS[type])}
        </option>
      ))}
    </select>
  )
}
