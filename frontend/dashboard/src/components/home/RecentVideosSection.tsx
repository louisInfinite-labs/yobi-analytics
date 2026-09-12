import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { resolvePlaybackVideoId, type RecentVideo } from "../../data/mockRecentVideos"
import { useLocale } from "../../hooks/useLocale"
import { useRecentVideos } from "../../hooks/useRecentVideos"
import { t, type Locale } from "../../i18n/translations"
import {
  selectAllVideos,
  selectLatestVideos,
  selectLivestreamSlots,
  selectVideosByCategory,
  VIDEO_SORT_LABEL_KEYS,
  VIDEO_SORT_OPTIONS,
  type VideoSortOption,
} from "../../lib/recentVideosSelection"
import { VIDEO_SECTION_TAGS, VIDEO_SECTION_TAG_LABEL_KEYS, type VideoSectionTag } from "../../lib/videoCategories"
import { VideoPlayerModal } from "../VideoPlayerModal"

interface RecentVideosSectionProps {
  creatorId: string
}

/** Once the user has scrolled to roughly the 14th-16th card, the next page
 * is already worth fetching — picking the smaller end (14) means it fires
 * no later than that window. */
const PREFETCH_AT_INDEX = 13

const INITIAL_VISIBLE_COUNT = 20
/** Both how many more slots `visibleCount` grows by per prefetch AND how far
 * VideoRow's own next-prefetch threshold advances each time (see
 * nextThresholdRef below) — one page's worth either way. */
const VISIBLE_COUNT_STEP = 20

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
  return (
    <button type="button" className="recent-videos__card" onClick={() => onOpen(video)}>
      <span className="recent-videos__thumb">
        {thumbFailed ? (
          <span className="home-placeholder recent-videos__thumb-placeholder">No thumbnail</span>
        ) : (
          <img
            className="recent-videos__thumb-image"
            src={`https://img.youtube.com/vi/${resolvePlaybackVideoId(video.videoId)}/hqdefault.jpg`}
            alt=""
            draggable={false}
            onError={() => setThumbFailed(true)}
          />
        )}
        {isLiveNow && <span className="recent-videos__live-badge">LIVE</span>}
      </span>
      <span className="recent-videos__title">{video.title}</span>
    </button>
  )
}

/** YouTube-style left/right chevron buttons flanking the scrollable
 * thumbnail track. The right arrow sits in normal flex flow after the
 * track; the left arrow is overlaid on the track's own left edge instead
 * (see `.recent-videos__scroll-button--left` in home.css) so the track's
 * left edge — and the leftmost video card — lines up with home-scene's
 * left edge above it, rather than the arrow pushing it inward.
 *
 * `onNearEnd` fires once the leading visible card reaches
 * `nextThresholdRef` (starting at PREFETCH_AT_INDEX), which then advances
 * by VISIBLE_COUNT_STEP so the row keeps prefetching every ~20 cards as the
 * user keeps scrolling right, instead of firing once and never again
 * (CodeRabbit: a plain fired-boolean latch only resets by scrolling back
 * before card 14, so continuing to scroll forward past the first prefetch
 * never requested a third or later page). */
function VideoRow({
  label,
  videos,
  emptyLabel,
  onOpen,
  onNearEnd,
  rowStyle,
}: {
  label: string
  videos: RecentVideo[]
  emptyLabel: string
  onOpen: (video: RecentVideo) => void
  onNearEnd: () => void
  rowStyle?: CSSProperties
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const nextThresholdRef = useRef(PREFETCH_AT_INDEX)
  // Left arrow starts hidden -- the track starts scrolled all the way left
  // (list[0] flush against the left edge), so there's nothing left to
  // scroll back to yet. Any rightward scroll at all reveals it again, not
  // just once it's scrolled a full card.
  const [canScrollLeft, setCanScrollLeft] = useState(false)

  function scrollByOneCard(direction: 1 | -1) {
    const track = trackRef.current
    if (!track) return
    const card = track.querySelector<HTMLElement>(".recent-videos__card")
    const step = card ? card.offsetWidth + 12 : track.clientWidth * 0.8
    track.scrollBy({ left: direction * step, behavior: "smooth" })
  }

  function handleScroll() {
    const track = trackRef.current
    if (!track) return
    setCanScrollLeft(track.scrollLeft > 0)

    const card = track.querySelector<HTMLElement>(".recent-videos__card")
    if (!card) return
    const cardStep = card.offsetWidth + 12
    const leadingIndex = Math.floor(track.scrollLeft / cardStep)

    if (leadingIndex >= nextThresholdRef.current) {
      nextThresholdRef.current += VISIBLE_COUNT_STEP
      onNearEnd()
    }
  }

  return (
    <div className="recent-videos__section">
      {/* No visible label here -- the active tag chip in VideoSectionTagBar
          already shows which one is selected, so this would just repeat
          the same text right below it. `label` is still used for the
          arrow buttons' own aria-label below. */}
      <div className="recent-videos__row" style={rowStyle}>
        <button
          type="button"
          className={`recent-videos__scroll-button recent-videos__scroll-button--left${canScrollLeft ? "" : " recent-videos__scroll-button--hidden"}`}
          onClick={() => scrollByOneCard(-1)}
          aria-label={`Scroll ${label} left`}
        >
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
        <div ref={trackRef} className="recent-videos__track" onScroll={handleScroll}>
          {videos.length === 0 ? (
            <div className="recent-videos__empty">{emptyLabel}</div>
          ) : (
            videos.map((video) => <VideoThumbCard key={video.videoId} video={video} onOpen={onOpen} />)
          )}
        </div>
        <button
          type="button"
          className="recent-videos__scroll-button"
          onClick={() => scrollByOneCard(1)}
          aria-label={`Scroll ${label} right`}
        >
          <ChevronRight size={18} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

/** The 10-tag filter bar -- fixed order (not alphabetical/count/recency/
 * LIVE-status based), single-select with a clear active state. Reuses the
 * existing `.filter-chip`/`.filter-chip-group` classes (dashboard.css,
 * loaded globally) rather than introducing new button/active-state
 * styling. */
function VideoSectionTagBar({ selected, onSelect, locale }: { selected: VideoSectionTag; onSelect: (tag: VideoSectionTag) => void; locale: Locale }) {
  return (
    <div className="filter-chip-group">
      {VIDEO_SECTION_TAGS.map((tag) => (
        <button
          key={tag}
          type="button"
          className="filter-chip"
          aria-pressed={selected === tag}
          onClick={() => onSelect(tag)}
        >
          {t(locale, VIDEO_SECTION_TAG_LABEL_KEYS[tag])}
        </button>
      ))}
    </div>
  )
}

/** The sort dropdown -- only rendered for "ALL"/the 7 category tags, never
 * for "latest videos"/"latest live" which keep their existing fixed
 * newest-first order. Reuses the existing `.soft-select` class
 * (ThemeSelector/TimeZoneSelector/UpcomingDisplaySettings) rather than
 * introducing new dropdown styling. */
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
      className="soft-select"
      style={{ visibility: hidden ? "hidden" : "visible" }}
      value={value}
      onChange={(event) => onChange(event.target.value as VideoSortOption)}
      aria-label="Sort videos"
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

/** Home's upper section: a tag filter bar, then ONE video carousel showing
 * whichever tag is selected -- "latest videos"/"latest live" show the
 * existing latest-uploads/streams pools unfiltered (exactly what the two
 * former permanent rows showed), "ALL" and the 7 game/topic tags show both
 * pools merged and (for the 7) filtered by RecentVideo.category. Each of
 * the three view "modes"
 * (latest/live/all-or-category) keeps its own visibleCount and prefetch
 * threshold so switching tags never loses another mode's own scroll
 * position or re-triggers its loadMore() (same independence the previous
 * two-permanent-row layout already had between its two rows).
 *
 * Sits above the room scene, not one of its layers, since a thumbnail/list
 * UI doesn't belong inside the OBS-style composition. */
export function RecentVideosSection({ creatorId }: RecentVideosSectionProps) {
  const [locale] = useLocale()
  const [selectedTag, setSelectedTag] = useState<VideoSectionTag>("latestVideos")
  const [sortOption, setSortOption] = useState<VideoSortOption>("newest")
  const [embed, setEmbed] = useState<RecentVideo | null>(null)
  const [latestVisibleCount, setLatestVisibleCount] = useState(INITIAL_VISIBLE_COUNT)
  const [streamVisibleCount, setStreamVisibleCount] = useState(INITIAL_VISIBLE_COUNT)
  const [combinedVisibleCount, setCombinedVisibleCount] = useState(INITIAL_VISIBLE_COUNT)
  const { latestVideos: latestPool, streamVideos: streamPool } = useRecentVideos(creatorId)

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
    selectedTag === "latestVideos" ? "No recent videos" : selectedTag === "latestLive" ? "No recent streams" : "No videos"

  // The toolbar (tag bar + sort dropdown) shrink-wraps to its own content
  // width (see .recent-videos__toolbar's `width: fit-content`). The sort
  // dropdown always stays mounted and always occupies its layout space
  // (see VideoSortDropdown's `hidden` prop) even on tags that don't show
  // it, so the toolbar's rendered width -- and therefore the row's
  // right-scroll-arrow position below, measured from it live via
  // ResizeObserver -- never shifts depending on which tag is selected.
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [rowWidth, setRowWidth] = useState<number>()

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current
    if (!toolbar) return
    const updateWidth = () => setRowWidth(toolbar.getBoundingClientRect().width)
    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(toolbar)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="recent-videos">
      <div ref={toolbarRef} className="recent-videos__toolbar">
        <VideoSectionTagBar selected={selectedTag} onSelect={setSelectedTag} locale={locale} />
        <VideoSortDropdown value={sortOption} onChange={setSortOption} locale={locale} hidden={!showSortDropdown} />
      </div>
      {/* key={selectedTag}: a fresh VideoRow per tag, not a reused instance --
          otherwise its scroll position/canScrollLeft/prefetch threshold from
          the PREVIOUS tag would carry over onto the new tag's own videos. */}
      <VideoRow
        key={selectedTag}
        label={t(locale, VIDEO_SECTION_TAG_LABEL_KEYS[selectedTag])}
        videos={videos}
        emptyLabel={emptyLabel}
        onOpen={setEmbed}
        onNearEnd={handleNearEnd}
        rowStyle={rowWidth ? { width: rowWidth, maxWidth: "100%" } : undefined}
      />
      {embed && <VideoPlayerModal videoId={resolvePlaybackVideoId(embed.videoId)} title={embed.title} onClose={() => setEmbed(null)} />}
    </div>
  )
}
