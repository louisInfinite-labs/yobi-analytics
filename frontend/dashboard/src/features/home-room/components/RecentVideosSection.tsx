import { useCallback, useMemo, useRef, useState, type ReactNode } from "react"
import { ConfigProvider, Segmented } from "antd"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { resolvePlaybackVideoId } from "../data/mockRecentVideos"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import type { VideoPage } from "../hooks/useRecentVideos"
import { t, type Locale } from "../../../shared/i18n/translations"
import { formatCompactCount } from "../../oshi-status/utils/oshiActivity"
import {
  selectAllVideos,
  selectLatestVideos,
  selectLivestreamSlots,
  selectVideosByCategory,
  VIDEO_SORT_LABEL_KEYS,
  VIDEO_SORT_OPTIONS,
  type VideoSortOption,
} from "../utils/recentVideosSelection"
import { VIDEO_SECTION_TAGS, VIDEO_SECTION_TAG_LABEL_KEYS, type VideoSectionTag } from "../model/videoCategories"
import { VideoPlayerModal } from "../../media-player/components/VideoPlayerModal"

interface RecentVideosSectionProps {
  creatorId: string
  /** Both pools are loaded once by Home and handed down, so this section and
   * Oshi Status read the same fetch rather than each opening their own. */
  latestVideos: VideoPage
  streamVideos: VideoPage
}

/** Once the user has scrolled to roughly the 14th-16th card, the next page
 * is already worth fetching — picking the smaller end (14) means it fires
 * no later than that window. */
const PREFETCH_AT_INDEX = 13

const INITIAL_VISIBLE_COUNT = 20
/** Both how many more slots `visibleCount` grows by per prefetch AND how far
 * the track's own next-prefetch threshold advances each time — one page's
 * worth either way. */
const VISIBLE_COUNT_STEP = 20

/** Matches .oshi-videos__list's own `gap`, so a scroll step lands one card
 * boundary on rather than drifting by the gap each time. */
const CARD_GAP = 10

/** "{views} views · MM/DD", dropping either half that's missing data (no
 * viewCount, or an unparseable publishedAt) rather than showing a blank. */
function formatCardMeta(video: RecentVideo): string {
  const date = new Date(video.publishedAt)
  const published = Number.isNaN(date.getTime())
    ? ""
    : `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`
  if (typeof video.viewCount !== "number") return published
  return published ? `${formatCompactCount(video.viewCount)} views · ${published}` : `${formatCompactCount(video.viewCount)} views`
}

/** The card's own thumbnail sits above its title, using YouTube's own
 * thumbnail JPG endpoint — no separate fetch, keyed only by videoId. Most
 * mockRecentVideos ids aren't real YouTube ids, so the thumbnail/embed
 * source goes through resolvePlaybackVideoId (falls back to a real, always-
 * embeddable placeholder video for those) rather than the entry's own
 * `videoId` directly -- `videoId` itself must stay each entry's own unique
 * value (not the shared placeholder) since it also doubles as the React
 * list key and the identity recentVideosSelection.ts's mergeAndDedupe
 * dedupes by. */
function VideoThumbCard({ video, onOpen }: { video: RecentVideo; onOpen: (video: RecentVideo) => void }) {
  const [thumbFailed, setThumbFailed] = useState(false)
  const isLiveNow = video.contentFormat === "live_now"
  const meta = formatCardMeta(video)

  return (
    <button type="button" className="oshi-video-card" onClick={() => onOpen(video)}>
      <span className="oshi-video-card__thumbnail">
        {thumbFailed ? (
          <span className="home-placeholder">No thumbnail</span>
        ) : (
          <img
            src={`https://img.youtube.com/vi/${resolvePlaybackVideoId(video.videoId)}/hqdefault.jpg`}
            alt=""
            draggable={false}
            onError={() => setThumbFailed(true)}
          />
        )}
        {isLiveNow && <span className="oshi-video-card__live-badge">LIVE</span>}
      </span>
      <span className="oshi-video-card__body">
        <span className="oshi-video-card__title">{video.title}</span>
        {meta && <span className="oshi-video-card__meta">{meta}</span>}
      </span>
    </button>
  )
}

/** The horizontally scrolling thumbnail track, with the YouTube-style
 * left/right chevrons flanking it — overlaid on the track rather than taking
 * their own layout slot, so the leftmost card still starts at the section's
 * own left edge. The left arrow hides while the track is scrolled fully left.
 *
 * `onNearEnd` fires once the leading visible card reaches `nextThresholdRef`
 * (starting at PREFETCH_AT_INDEX), which then advances by VISIBLE_COUNT_STEP
 * so the row keeps prefetching every ~20 cards as the user keeps scrolling
 * right, instead of firing once and never again. */
function VideoTrack({
  label,
  videos,
  emptyLabel,
  onOpen,
  onNearEnd,
}: {
  label: string
  videos: RecentVideo[]
  emptyLabel: string
  onOpen: (video: RecentVideo) => void
  onNearEnd: () => void
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const nextThresholdRef = useRef(PREFETCH_AT_INDEX)
  // Starts hidden: the track starts scrolled fully left, so there is nothing
  // to scroll back to yet.
  const [canScrollLeft, setCanScrollLeft] = useState(false)

  function scrollByOneCard(direction: 1 | -1) {
    const viewport = viewportRef.current
    if (!viewport) return
    const card = viewport.querySelector<HTMLElement>(".oshi-video-card")
    const step = card ? card.offsetWidth + CARD_GAP : viewport.clientWidth * 0.8
    viewport.scrollBy({ left: direction * step, behavior: "smooth" })
  }

  function handleScroll() {
    const viewport = viewportRef.current
    if (!viewport) return
    setCanScrollLeft(viewport.scrollLeft > 0)

    const card = viewport.querySelector<HTMLElement>(".oshi-video-card")
    if (!card) return
    const leadingIndex = Math.floor(viewport.scrollLeft / (card.offsetWidth + CARD_GAP))
    if (leadingIndex >= nextThresholdRef.current) {
      nextThresholdRef.current += VISIBLE_COUNT_STEP
      onNearEnd()
    }
  }

  return (
    <div className="oshi-videos__row">
      <button
        type="button"
        className={`oshi-videos__scroll oshi-videos__scroll--left${canScrollLeft ? "" : " oshi-videos__scroll--hidden"}`}
        onClick={() => scrollByOneCard(-1)}
        aria-label={`Scroll ${label} left`}
      >
        <ChevronLeft size={16} aria-hidden="true" />
      </button>

      <div ref={viewportRef} className="oshi-videos__viewport" onScroll={handleScroll}>
        <div className="oshi-videos__list">
          {videos.length === 0 ? (
            <div className="oshi-empty-state">{emptyLabel}</div>
          ) : (
            videos.map((video) => <VideoThumbCard key={video.videoId} video={video} onOpen={onOpen} />)
          )}
        </div>
      </div>

      <button
        type="button"
        className="oshi-videos__scroll oshi-videos__scroll--right"
        onClick={() => scrollByOneCard(1)}
        aria-label={`Scroll ${label} right`}
      >
        <ChevronRight size={16} aria-hidden="true" />
      </button>
    </div>
  )
}

/** The 10-tag filter bar -- fixed order (not alphabetical/count/recency/
 * LIVE-status based), rendered as one Ant Design Segmented control (not ten
 * independent buttons) so the whole list reads as a single continuous
 * selector. `trailing` (the sort control) renders as the next sibling in
 * this same flex row, sharing its existing `gap` instead of a margin of its
 * own. Segmented's dark styling goes through antd's own component tokens
 * (trackBg/itemColor/itemSelectedBg/...), same pattern as Settings > Oshi
 * Settings' MyOshiSettings/OshiSettings Segmented usage -- itemSelectedBg
 * is the only token tied to --creator-main, and only at a low mix
 * percentage, so switching currentOshi tints just the selected segment
 * rather than the whole bar. */
function VideoSectionTagBar({
  selected,
  onSelect,
  locale,
  trailing,
}: {
  selected: VideoSectionTag
  onSelect: (tag: VideoSectionTag) => void
  locale: Locale
  trailing?: ReactNode
}) {
  return (
    <div className="oshi-videos__filters">
      <ConfigProvider
        theme={{
          components: {
            Segmented: {
              trackBg: "var(--oshi-surface-2)",
              trackPadding: 2,
              itemColor: "var(--oshi-text-3)",
              itemHoverColor: "var(--oshi-text-1)",
              itemHoverBg: "rgba(255, 255, 255, 0.05)",
              itemSelectedBg: "color-mix(in srgb, var(--creator-main) 18%, var(--oshi-surface-3))",
              itemSelectedColor: "var(--oshi-text-1)",
              borderRadius: 4,
              borderRadiusSM: 4,
            },
          },
        }}
      >
        <Segmented<VideoSectionTag>
          size="small"
          classNames={{
            root: "oshi-videos__segmented",
            item: "oshi-videos__segment-item",
            label: "oshi-videos__segment-label",
          }}
          value={selected}
          onChange={onSelect}
          options={VIDEO_SECTION_TAGS.map((tag) => ({
            value: tag,
            label: t(locale, VIDEO_SECTION_TAG_LABEL_KEYS[tag]),
          }))}
        />
      </ConfigProvider>
      {trailing}
    </div>
  )
}

/** The sort dropdown -- only rendered for "ALL"/the 7 category tags, never
 * for "latest videos"/"latest live" which keep their existing fixed
 * newest-first order. */
function VideoSortDropdown({
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
      {VIDEO_SORT_OPTIONS.map((option) => (
        <option key={option} value={option}>
          {t(locale, VIDEO_SORT_LABEL_KEYS[option])}
        </option>
      ))}
    </select>
  )
}

/** Home's Oshi Videos strip: one compact filter row, then one horizontally
 * scrolling thumbnail row -- fixed height, so it can never grow the page
 * tall enough to introduce a vertical scrollbar. Each of the three view
 * "modes" (latest/live/all-or-category) keeps its own visibleCount and
 * prefetch threshold so switching tags never loses another mode's own
 * scroll position or re-triggers its loadMore(). */
export function RecentVideosSection({ creatorId, latestVideos: latestPool, streamVideos: streamPool }: RecentVideosSectionProps) {
  const [locale] = useLocale()
  const [selectedTag, setSelectedTag] = useState<VideoSectionTag>("latestVideos")
  const [sortOption, setSortOption] = useState<VideoSortOption>("newest")
  const [embed, setEmbed] = useState<RecentVideo | null>(null)
  const [latestVisibleCount, setLatestVisibleCount] = useState(INITIAL_VISIBLE_COUNT)
  const [streamVisibleCount, setStreamVisibleCount] = useState(INITIAL_VISIBLE_COUNT)
  const [combinedVisibleCount, setCombinedVisibleCount] = useState(INITIAL_VISIBLE_COUNT)

  // Sort dropdown only applies to "ALL"/the 7 category tags -- see
  // VideoSortDropdown's own docstring.
  const showSortDropdown = selectedTag !== "latestVideos" && selectedTag !== "latestLive"

  const videos = useMemo(() => {
    if (selectedTag === "latestVideos") return selectLatestVideos(latestPool.videos, latestVisibleCount)
    if (selectedTag === "latestLive") return selectLivestreamSlots(streamPool.videos, streamVisibleCount)
    if (selectedTag === "all") return selectAllVideos(latestPool.videos, streamPool.videos, combinedVisibleCount, sortOption)
    return selectVideosByCategory(latestPool.videos, streamPool.videos, selectedTag, combinedVisibleCount, sortOption)
  }, [selectedTag, latestPool.videos, streamPool.videos, latestVisibleCount, streamVisibleCount, combinedVisibleCount, sortOption])

  const handleNearEnd = useCallback(() => {
    if (selectedTag === "latestVideos") {
      setLatestVisibleCount((prev) => prev + VISIBLE_COUNT_STEP)
      latestPool.loadMore()
    } else if (selectedTag === "latestLive") {
      setStreamVisibleCount((prev) => prev + VISIBLE_COUNT_STEP)
      streamPool.loadMore()
    } else {
      setCombinedVisibleCount((prev) => prev + VISIBLE_COUNT_STEP)
      latestPool.loadMore()
      streamPool.loadMore()
    }
  }, [selectedTag, latestPool, streamPool])

  const emptyLabel =
    selectedTag === "latestVideos"
      ? t(locale, "recentVideos.empty.latestVideos")
      : selectedTag === "latestLive"
        ? t(locale, "recentVideos.empty.latestLive")
        : t(locale, "recentVideos.empty.other")

  return (
    <section className="oshi-videos">
      <header className="oshi-videos__header">
        <VideoSectionTagBar
          selected={selectedTag}
          onSelect={setSelectedTag}
          locale={locale}
          trailing={<VideoSortDropdown value={sortOption} onChange={setSortOption} locale={locale} hidden={!showSortDropdown} />}
        />
      </header>

      {/* key includes creatorId, not just selectedTag: a fresh track per tag
          AND per creator, not a reused instance -- otherwise switching
          creator while the same tag stays selected would carry over the
          PREVIOUS creator's scroll position and prefetch threshold onto the
          new creator's own videos. */}
      <VideoTrack
        key={`${creatorId}:${selectedTag}`}
        label={t(locale, VIDEO_SECTION_TAG_LABEL_KEYS[selectedTag])}
        videos={videos}
        emptyLabel={emptyLabel}
        onOpen={setEmbed}
        onNearEnd={handleNearEnd}
      />

      {embed && <VideoPlayerModal videoId={resolvePlaybackVideoId(embed.videoId)} title={embed.title} onClose={() => setEmbed(null)} />}
    </section>
  )
}
