import { useEffect, useMemo, useState } from "react"
import { Filter } from "lucide-react"
import { TopbarSlotPortal } from "../../app/navigation/TopbarSlotPortal"
import { goToPage } from "../../app/navigation/useCurrentPage"
import { useBreakpoint } from "../../shared/hooks/useBreakpoint"
import { useLocale } from "../../shared/i18n/hooks/useLocale"
import { t } from "../../shared/i18n/translations"
import { EmptyState } from "../../shared/ui/states/EmptyState"
import { resolveCreatorKey } from "../../entities/creator/data/creatorRegistry"
import { useSelectedCreator } from "../../features/oshi/hooks/useSelectedCreator"
import { OshiErrorState } from "../../features/home-room/components/OshiErrorState"
import { useOshiVideos } from "../../features/home-room/hooks/useOshiVideos"
import { useVideoTagOptions } from "../../features/home-room/hooks/useVideoTagOptions"
import { buildShelfQuery } from "../../features/home-room/model/oshiVideosQuery"
import { VideoPlayerModal } from "../../features/media-player/components/VideoPlayerModal"
import { VideoSearchInput } from "../../features/video-search/components/VideoSearchInput"
import { VideoFilterSheet, type VideoFilterState } from "../../features/video-search/components/VideoFilterSheet"
import { MobileVideoCard } from "../../features/video-search/components/MobileVideoCard"
import { useVideoSearch } from "../../features/video-search/hooks/useVideoSearch"
import "../../features/video-search/styles/videoSearch.css"

const DEFAULT_FILTER: VideoFilterState = { tag: "all", contentType: "all", sort: "newest", viewWindow: "total" }

/** Loading more of the current list once the user has scrolled within this many px of the bottom. */
const LOAD_MORE_THRESHOLD_PX = 300

/** The MOBILE-ONLY Videos/Search view (spec sections 41-58): Drawer + Search + Filter share the
 * existing phone top bar's own row (TopbarSlotPortal -- MainNavbar itself is untouched and still
 * page-agnostic), then a plain vertical list of the current creator's videos. Reachable by direct URL
 * on any viewport (useCurrentPage has no breakpoint logic of its own), so THIS component is what
 * redirects back to Home when the live breakpoint isn't mobile -- desktop keeps its own Home-based
 * Video List + Search (RecentVideosSection) and never renders this page's UI at all. */
export function VideosPage() {
  const breakpoint = useBreakpoint()
  useEffect(() => {
    if (breakpoint !== "mobile") goToPage("home")
  }, [breakpoint])

  const [creatorId] = useSelectedCreator()
  const [locale] = useLocale()
  const canonicalCreatorId = resolveCreatorKey(creatorId)?.creatorId
  const { options: tagOptions, topics: topicCatalog } = useVideoTagOptions(locale)

  const [applied, setApplied] = useState<VideoFilterState>(DEFAULT_FILTER)
  const [filterOpen, setFilterOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [isComposing, setIsComposing] = useState(false)
  const [playerVideo, setPlayerVideo] = useState<{ videoId: string; title: string } | null>(null)

  const searchBase = useMemo(
    () => (canonicalCreatorId ? { creatorId: canonicalCreatorId, contentType: applied.contentType, sort: applied.sort, viewWindow: applied.viewWindow } : null),
    [canonicalCreatorId, applied.contentType, applied.sort, applied.viewWindow],
  )
  const search = useVideoSearch(searchQuery, searchBase, { isComposing, topics: topicCatalog })

  const shelfQuery = useMemo(
    () => buildShelfQuery(applied.tag, canonicalCreatorId, { contentType: applied.contentType, sort: applied.sort, viewWindow: applied.viewWindow }),
    [applied.tag, canonicalCreatorId, applied.contentType, applied.sort, applied.viewWindow],
  )
  const shelf = useOshiVideos(shelfQuery)

  const videos = search.active ? search.videos : shelf.videos
  const loading = search.active ? search.loading : shelf.loading
  const error = search.active ? search.error : shelf.error

  const hasNonDefaultFilter =
    applied.tag !== DEFAULT_FILTER.tag || applied.contentType !== DEFAULT_FILTER.contentType || applied.sort !== DEFAULT_FILTER.sort

  // A Search response is always already the query's complete result set (no backend pagination left to
  // reach) -- only the shelf's own "recent videos" browsing is ever paginated by scrolling.
  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    if (search.active) return
    const el = event.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight < LOAD_MORE_THRESHOLD_PX) shelf.loadMore()
  }

  if (breakpoint !== "mobile") return null

  return (
    <div className="mobile-videos">
      <TopbarSlotPortal>
        {/* Search receives focus whether the user arrived here from Home's Search entry or the Drawer's
            Videos item -- a single autoFocus rule covers both entry points identically, with no flag to
            pass between pages. autoFocus (not an imperative ref+effect) is what makes this actually work
            through the portal -- see VideoSearchInput's own docstring for why. */}
        <VideoSearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          locale={locale}
          className="mobile-videos__search"
          autoFocus
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          onSubmit={search.flush}
        />
        <button
          type="button"
          className="mobile-videos__filter-trigger"
          data-active={hasNonDefaultFilter}
          aria-haspopup="dialog"
          aria-expanded={filterOpen}
          aria-label={t(locale, "videoSearch.filter.trigger")}
          onClick={() => setFilterOpen(true)}
        >
          <Filter size={16} aria-hidden="true" />
          {hasNonDefaultFilter && <span className="mobile-videos__filter-trigger__badge" aria-hidden="true" />}
        </button>
      </TopbarSlotPortal>

      <div className="mobile-videos__list" onScroll={handleScroll}>
        {videos.length === 0 && !loading ? (
          error ? <OshiErrorState error={error} /> : <EmptyState message={search.active ? t(locale, "videoSearch.empty") : t(locale, "recentVideos.empty.other")} />
        ) : (
          videos.map((video) => (
            <MobileVideoCard key={video.videoId} video={video} locale={locale} onOpen={() => setPlayerVideo({ videoId: video.videoId, title: video.title })} />
          ))
        )}
      </div>

      <VideoFilterSheet locale={locale} open={filterOpen} onClose={() => setFilterOpen(false)} tagOptions={tagOptions} applied={applied} onApply={setApplied} />

      {/* In-place overlay above this same Videos view -- never a navigation to Home, never autoplay (the
          user explicitly starts playback), never a duplicate title/metadata caption (hideTitle: the card
          above already shows the title). Closing it returns to this exact list: Search query, results,
          selected Tag/Filter and scroll position are all untouched local state here, never reset by
          opening/closing the player. */}
      {playerVideo && (
        <VideoPlayerModal videoId={playerVideo.videoId} title={playerVideo.title} onClose={() => setPlayerVideo(null)} autoplay={false} hideTitle />
      )}
    </div>
  )
}
