import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { ChevronRight, Search } from "lucide-react"
import { OshiErrorState } from "./OshiErrorState"
import { VideoTagSegmented } from "./VideoTagSegmented"
import { ContentTypeDropdown, VideoSortDropdown, ViewWindowDropdown } from "./VideoShelfControls"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t, type Locale } from "../../../shared/i18n/translations"
import { formatCardMeta } from "../utils/videoCardMeta"
import { markContentSeen, migrateWatchedLiveToSeen } from "../../../shared/newContent/newContentTracking"
import { useLiveStreams } from "../../../shared/api/hooks/useLiveStreams"
import { toRecentVideo } from "../hooks/useRecentVideos"
import { composeLatestLiveShelf } from "../utils/latestLiveShelf"
import { resolveCreatorKey } from "../../../entities/creator/data/creatorRegistry"
import type { VideoSortOption } from "../utils/recentVideosSelection"
import { SHORT_VIDEO_FILTER, type VideoSectionSelection } from "../model/specialVideoFilters"
import {
  buildShelfQuery,
  isQuickFilterSelection,
  oshiVideosQueryKey,
  type VideoContentType,
  type VideoViewWindow,
} from "../model/oshiVideosQuery"
import { useOshiVideos } from "../hooks/useOshiVideos"
import { useVideoTagOptions } from "../hooks/useVideoTagOptions"
import { useVideoSearch } from "../../video-search/hooks/useVideoSearch"
import { VideoSearchInput } from "../../video-search/components/VideoSearchInput"

interface RecentVideosSectionProps {
  creatorId: string
  /** The one shared Home selected-video path (see HomePage.tsx) -- a normal
   * card click switches the central Oshi Stream player directly, never a
   * modal/second player. Drag-to-scroll (see VideoTrack) never calls this. */
  onSelectVideo: (video: { videoId: string; title: string }) => void
}

/** Once the user has scrolled to roughly the 14th-16th card, the next page
 * is already worth fetching — picking the smaller end (14) means it fires
 * no later than that window. */
const PREFETCH_AT_INDEX = 13

/** One page's worth of cards: the spacing between prefetch points (13, 33, 53, ...). */
const VISIBLE_COUNT_STEP = 20

/** Matches .oshi-videos__list's own `gap`, so a scroll step lands one card
 * boundary on rather than drifting by the gap each time. */
const CARD_GAP = 10

/** Pointer movement (px) before a mouse-down-and-move on the track counts as
 * a drag rather than the start of an ordinary card click. */
const DRAG_THRESHOLD = 5

/** The card's own thumbnail sits above its title, using YouTube's own
 * thumbnail JPG endpoint -- no separate fetch, keyed only by the real
 * videoId the API returned (never a substituted placeholder video). */
function VideoThumbCard({ video, onOpen }: { video: RecentVideo; onOpen: (video: RecentVideo) => void }) {
  const [thumbFailed, setThumbFailed] = useState(false)
  const [locale] = useLocale()
  const isLiveNow = video.contentFormat === "live_now"
  const isCurrentStream = isLiveNow || video.contentFormat === "live_upcoming"
  const meta = formatCardMeta(video)

  return (
    <button
      type="button"
      className="oshi-video-card"
      onClick={() => {
        // No NEW badge here (Oshi Status owns it), but an open still clears the shared NEW state.
        // A live/upcoming stream is never NEW and a click is not watching it: only an archive/upload counts as opened.
        if (!isCurrentStream) markContentSeen(video.videoId)
        onOpen(video)
      }}
    >
      <span className="oshi-video-card__thumbnail">
        {thumbFailed ? (
          <span className="home-placeholder">No thumbnail</span>
        ) : (
          <img
            src={`https://img.youtube.com/vi/${video.videoId}/hqdefault.jpg`}
            alt=""
            draggable={false}
            onError={() => setThumbFailed(true)}
          />
        )}
        {isLiveNow && <span className="oshi-video-card__live-badge">{t(locale, "recentVideos.liveBadge")}</span>}
      </span>
      <span className="oshi-video-card__body">
        <span className="oshi-video-card__title">{video.title}</span>
        {meta && <span className="oshi-video-card__meta">{meta}</span>}
      </span>
    </button>
  )
}

/** The horizontally scrolling thumbnail track. Navigation is native
 * scroll only -- wheel/trackpad, an on-hover scrollbar, and mouse
 * left-button grab-to-scroll (below); there is no dedicated arrow-button
 * affordance any more.
 *
 * `onNearEnd` fires on every scroll once the leading visible card reaches the
 * prefetch point of the cards loaded right now: PREFETCH_AT_INDEX for the first
 * page, then +VISIBLE_COUNT_STEP for each further page (13, 33, 53, ...). It
 * is level-triggered, not a one-shot threshold that advances when it fires:
 * the point is derived from the loaded count, so a request the loader ignored
 * (one was in flight) or one that failed is simply asked again by the next
 * scroll -- a dropped trigger can no longer strand the shelf. The loader itself
 * coalesces and rate-limits (useOshiVideos). */
function VideoTrack({
  videos,
  emptyLabel,
  error,
  onOpen,
  onNearEnd,
}: {
  videos: RecentVideo[]
  emptyLabel: string
  /** The first page failed: shown as the normal error state, distinct from a valid empty result. */
  error: Error | null
  onOpen: (video: RecentVideo) => void
  onNearEnd: () => void
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  // Mouse-only grab-to-scroll state. `didDragRef` is what actually
  // suppresses the click a real drag would otherwise fire on whatever card
  // ends up under the pointer at release -- `dragRef` itself is reset (and
  // its stale pointerId can't match a later event) before that can happen,
  // so a leftover flag can never survive into an unrelated later click.
  const dragRef = useRef({ pointerId: null as number | null, startX: 0, startScrollLeft: 0, dragging: false })
  const didDragRef = useRef(false)
  const [isDragging, setIsDragging] = useState(false)

  function handleScroll() {
    const viewport = viewportRef.current
    if (!viewport) return
    const card = viewport.querySelector<HTMLElement>(".oshi-video-card")
    if (!card) return
    const leadingIndex = Math.floor(viewport.scrollLeft / (card.offsetWidth + CARD_GAP))
    const loadedPages = Math.max(0, Math.floor((videos.length - 1 - PREFETCH_AT_INDEX) / VISIBLE_COUNT_STEP))
    if (leadingIndex >= PREFETCH_AT_INDEX + loadedPages * VISIBLE_COUNT_STEP) onNearEnd()
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    // Left mouse button only -- touch/pen pointers (and a non-primary mouse
    // button) fall straight through to native scrolling behavior instead.
    if (event.pointerType !== "mouse" || event.button !== 0) return
    const viewport = viewportRef.current
    if (!viewport) return
    didDragRef.current = false
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startScrollLeft: viewport.scrollLeft, dragging: false }
    // Pointer capture is NOT taken here -- while active, this browser
    // retargets the eventual mouseup/click to the capturing element (this
    // viewport) instead of hit-testing normally, so an ordinary, no-movement
    // click would never reach the card button's own onClick at all. It's
    // only taken once handlePointerMove below confirms this is actually a
    // drag, which is also the only case click suppression needs to matter.
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = dragRef.current
    const viewport = viewportRef.current
    if (state.pointerId !== event.pointerId || !viewport) return

    if ((event.buttons & 1) === 0) {
      // The left button was released outside this viewport (no pointerup
      // ever reached endDrag) -- reset here too, so this stale pointerId
      // can't still read as an active drag on the next move once the
      // pointer returns, which would otherwise auto-scroll on plain hover.
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId)
      if (state.dragging) setIsDragging(false)
      dragRef.current = { pointerId: null, startX: 0, startScrollLeft: 0, dragging: false }
      return
    }

    const deltaX = event.clientX - state.startX
    if (!state.dragging) {
      if (Math.abs(deltaX) < DRAG_THRESHOLD) return
      state.dragging = true
      didDragRef.current = true
      setIsDragging(true)
      viewport.setPointerCapture(event.pointerId)
    }

    viewport.scrollLeft = state.startScrollLeft - deltaX
    event.preventDefault()
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const viewport = viewportRef.current
    const state = dragRef.current
    if (state.pointerId === event.pointerId) {
      if (viewport?.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId)
      if (state.dragging) setIsDragging(false)
      dragRef.current = { pointerId: null, startX: 0, startScrollLeft: 0, dragging: false }
    }
    // Safety net for handleOpen's own reset: the browser fires pointerup
    // then click synchronously back-to-back, so a click landing on a card
    // still sees didDragRef true and gets suppressed there first -- but a
    // drag that RELEASES over empty space (not a card) never fires that
    // click at all, which would otherwise leave the flag stuck true and
    // silently swallow the next, unrelated, non-drag click forever. The
    // timeout runs strictly after that synchronous click dispatch either way.
    setTimeout(() => {
      didDragRef.current = false
    }, 0)
  }

  function handleOpen(video: RecentVideo) {
    // The pointerup after a real drag still fires a click on whatever card
    // is under the cursor -- this is what keeps that click from also
    // opening the video, without touching keyboard activation (Enter/
    // Space never sets didDragRef) or a normal, non-drag click.
    if (didDragRef.current) {
      didDragRef.current = false
      return
    }
    onOpen(video)
  }

  return (
    <div className="oshi-videos__row">
      <div
        ref={viewportRef}
        className="oshi-videos__viewport"
        data-dragging={isDragging ? "true" : undefined}
        onScroll={handleScroll}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="oshi-videos__list">
          {videos.length === 0 ? (
            error ? (
              <OshiErrorState error={error} />
            ) : (
              <div className="oshi-empty-state">{emptyLabel}</div>
            )
          ) : (
            videos.map((video) => <VideoThumbCard key={video.videoId} video={video} onOpen={handleOpen} />)
          )}
        </div>
      </div>
    </div>
  )
}

/** Sits at the header's far-right edge (margin-left: auto), OUTSIDE
 * .oshi-videos__filters -- a sibling of it, not a child, so it stays fixed
 * there regardless of how wide the Segmented/Sort cluster scrolls, and
 * never disturbs their own existing 5px gap.
 *
 * TODO(product decision needed): this app has no dedicated "all videos for
 * this creator" route/view to link to yet (checked -- only Home/Dashboard/
 * Settings exist, see app/navigation/useCurrentPage.ts, and Dashboard is
 * aggregate KPI/chart/ranking analytics, not a per-creator video list).
 * Per this task's own instruction not to invent a new page/route without
 * reporting that gap first, this reserves the label's position but stays
 * `disabled` (native semantics -- unclickable, unfocusable, no hover state;
 * see home.css's own :disabled rule) until that destination exists, rather
 * than presenting an inert control as a working one. */
function ViewAllButton({ locale }: { locale: Locale }) {
  return (
    <button type="button" className="oshi-videos__view-all" disabled>
      {t(locale, "recentVideos.viewAll")}
      <ChevronRight size={12} aria-hidden="true" />
    </button>
  )
}

/** Home's Oshi Videos strip: one compact filter row, then one horizontally
 * scrolling thumbnail row -- fixed height, so it can never grow the page
 * tall enough to introduce a vertical scrollbar.
 *
 * Every tag is a backend query for the CURRENT creator (see oshiVideosQuery.ts): the topic tags
 * use the content type / sort / period controls, and the two quick filters are fixed shortcuts
 * (最新影片 = uploads, 最新直播 = completed livestream archives, both newest first). */
export function RecentVideosSection({ creatorId, onSelectVideo }: RecentVideosSectionProps) {
  const [locale] = useLocale()
  const [selectedTag, setSelectedTag] = useState<VideoSectionSelection>("all")
  const [sortOption, setSortOption] = useState<VideoSortOption>("newest")
  const [viewWindow, setViewWindow] = useState<VideoViewWindow>("total")
  const [contentType, setContentType] = useState<VideoContentType>("all")
  // The special filters always render; backend topics only once GET /topics has actually
  // succeeded -- never a stale/hardcoded topic list while loading or on a failed fetch (the
  // special filters alone stay usable in both of those states, per the architecture this models).
  // Short is a content-format filter, placed immediately before the Other topic (at the end when
  // there is no Other topic yet). Shared with the mobile Filter sheet (see useVideoTagOptions) --
  // never a second, manually maintained copy of this list.
  const { options: tagOptions, topics: topicCatalog } = useVideoTagOptions(locale)

  // Video Search: a trigger toggles the expanded input in place of the Tag Segmented (section 37/38
  // of the spec this implements) -- `searchOpen` only controls this UI swap; `search.active` (the
  // normalized query meeting its activation threshold, see useVideoSearch) is what actually switches
  // the video list over to search results and starts ignoring the selected tag. Closing the trigger
  // always clears the query too, so reopening never resumes a stale search.
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [isComposing, setIsComposing] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  const canonicalCreatorId = resolveCreatorKey(creatorId)?.creatorId
  // Existing Filter/Sort (contentType/sort/viewWindow) stays active during a Search -- there is
  // deliberately no `topic`/tag field here, so Search can never be narrowed by the selected tag (the
  // backend endpoint itself has no such parameter either, see src/api/read_api.get_creator_video_search).
  const searchBase = useMemo(
    () => (canonicalCreatorId ? { creatorId: canonicalCreatorId, contentType, sort: sortOption, viewWindow } : null),
    [canonicalCreatorId, contentType, sortOption, viewWindow],
  )
  const search = useVideoSearch(searchQuery, searchBase, { isComposing, topics: topicCatalog })
  const shelfQuery = useMemo(
    () => buildShelfQuery(selectedTag, canonicalCreatorId, { contentType, sort: sortOption, viewWindow }),
    [selectedTag, canonicalCreatorId, contentType, sortOption, viewWindow],
  )
  const shelf = useOshiVideos(shelfQuery)

  // 最新直播 = LIVE, then UPCOMING, then archives. The archive endpoint is archive-only by design (liveStatus=archived),
  // so the creator's current live/upcoming streams come from the canonical GET /live-streams store and are merged in
  // BEFORE anything is displayed -- never subject to the archive request's limit/offset. ALL is the union of 最新直播 and
  // 最新影片, so while it shows newest-first livestream content (content type all/live) the current streams lead it too.
  const { streams } = useLiveStreams()
  const showsCurrentStreams =
    !search.active &&
    (selectedTag === "latestLive" || (selectedTag === "all" && sortOption === "newest" && (contentType === "all" || contentType === "live")))
  const shelfVideos = useMemo(() => {
    if (search.active) return search.videos
    if (!showsCurrentStreams) return shelf.videos
    const current = canonicalCreatorId ? streams.filter((stream) => stream.creatorId === canonicalCreatorId).map(toRecentVideo) : []
    return composeLatestLiveShelf(current, shelf.videos)
  }, [search.active, search.videos, showsCurrentStreams, canonicalCreatorId, streams, shelf.videos])

  // A stream the user watched while it was live is now observed as a completed archive: turn that marker into a
  // permanent seen entry (never NEW). Only completed archives count -- a live/upcoming row is skipped.
  useEffect(() => {
    migrateWatchedLiveToSeen(shelfVideos.filter((video) => video.contentFormat === "live_archive").map((video) => video.videoId))
  }, [shelfVideos])

  // The dropdowns apply to the topic tags AND to an active Search (existing Filter/Sort stays active
  // during Search, see useVideoSearch's own docstring) -- only a quick filter (fixed newest-first
  // order) hides them, and a quick filter never applies while Search itself is running.
  const showShelfFilters = search.active || !isQuickFilterSelection(selectedTag)
  const showViewWindow = showShelfFilters && sortOption === "mostViews"

  const emptyLabel = search.active
    ? search.loading
      ? ""
      : t(locale, "videoSearch.empty")
    : shelf.loading
      ? ""
      : selectedTag === "latestVideos"
        ? t(locale, "recentVideos.empty.latestVideos")
        : selectedTag === "latestLive"
          ? t(locale, "recentVideos.empty.latestLive")
          : t(locale, "recentVideos.empty.other")

  function closeSearch() {
    setSearchOpen(false)
    setSearchQuery("")
  }

  return (
    <section className="oshi-videos">
      <header className="oshi-videos__header">
        {searchOpen ? (
          <div className="oshi-videos__filters">
            <VideoSearchInput
              ref={searchInputRef}
              value={searchQuery}
              onChange={setSearchQuery}
              onClear={closeSearch}
              locale={locale}
              className="oshi-videos__search-expanded"
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
              onSubmit={search.flush}
            />
            <div className="oshi-videos__controls">
              <ContentTypeDropdown value={contentType} onChange={setContentType} locale={locale} hidden={selectedTag === SHORT_VIDEO_FILTER} />
              <VideoSortDropdown value={sortOption} onChange={setSortOption} locale={locale} hidden={false} />
              {showViewWindow && <ViewWindowDropdown value={viewWindow} onChange={setViewWindow} locale={locale} />}
            </div>
          </div>
        ) : (
          <VideoTagSegmented
            selected={selectedTag}
            onSelect={setSelectedTag}
            options={tagOptions}
            leading={
              <button type="button" className="video-search-trigger" aria-pressed="false" aria-label={t(locale, "videoSearch.trigger")} onClick={() => setSearchOpen(true)}>
                <Search size={14} aria-hidden="true" />
              </button>
            }
            trailing={
              <>
                <ContentTypeDropdown value={contentType} onChange={setContentType} locale={locale} hidden={!showShelfFilters || selectedTag === SHORT_VIDEO_FILTER} />
                <VideoSortDropdown value={sortOption} onChange={setSortOption} locale={locale} hidden={!showShelfFilters} />
                {showViewWindow && <ViewWindowDropdown value={viewWindow} onChange={setViewWindow} locale={locale} />}
              </>
            }
          />
        )}
        {/* V1: the control has no destination yet (see ViewAllButton), so production does not render it at all -- no hidden/inert
            element; it stays available to local development. `import.meta.env.DEV` is replaced at build time, so a production bundle
            contains no trace of the element. */}
        {import.meta.env.DEV && !searchOpen && <ViewAllButton locale={locale} />}
      </header>

      {/* key = the creator + what the shelf is actually showing: a fresh track (scroll position and
          prefetch threshold) per creator, tag, content type, sort and period -- otherwise switching
          creator while the same tag stays selected would carry the PREVIOUS creator's scroll state
          onto the new creator's videos. An active Search gets its own key component (the query itself)
          so switching between browsing and searching -- or between two different queries -- never
          carries over a stale scroll position or prefetch threshold either. */}
      <VideoTrack
        key={`${creatorId}:${search.active ? `search:${searchQuery}` : shelfQuery ? oshiVideosQueryKey(shelfQuery) : selectedTag}`}
        videos={shelfVideos}
        emptyLabel={emptyLabel}
        error={search.active ? search.error : shelf.error}
        onOpen={(video) => onSelectVideo({ videoId: video.videoId, title: video.title })}
        // A Search response is always already the query's complete result set -- only the shelf's own
        // "recent videos" browsing has further pages to reach by scrolling.
        onNearEnd={search.active ? () => {} : shelf.loadMore}
      />
    </section>
  )
}
