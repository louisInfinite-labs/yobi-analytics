import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react"
import { ConfigProvider, Segmented } from "antd"
import { ChevronRight } from "lucide-react"
import { VideoSearchBox } from "./VideoSearchBox"
import { OshiErrorState } from "./OshiErrorState"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t, type Locale } from "../../../shared/i18n/translations"
import { formatCompactCount } from "../../oshi-status/utils/oshiActivity"
import { markContentSeen, migrateWatchedLiveToSeen } from "../../../shared/newContent/newContentTracking"
import { useLiveStreams } from "../../../shared/api/hooks/useLiveStreams"
import { toRecentVideo } from "../hooks/useRecentVideos"
import { composeLatestLiveShelf } from "../utils/latestLiveShelf"
import { resolveCreatorKey } from "../../../entities/creator/data/creatorRegistry"
import type { VideoSortOption } from "../utils/recentVideosSelection"
import { SHORT_VIDEO_FILTER, SPECIAL_VIDEO_FILTERS, SPECIAL_VIDEO_FILTER_LABEL_KEYS, type SpecialVideoFilter, type VideoSectionSelection } from "../model/specialVideoFilters"
import { buildHomeVideoTagEntries } from "../model/videoFilterCatalog"
import {
  VIDEO_CONTENT_TYPES,
  VIDEO_VIEW_WINDOWS,
  buildShelfQuery,
  isHomeAllDefault,
  isQuickFilterSelection,
  oshiVideosQueryKey,
  type VideoContentType,
  type VideoViewWindow,
} from "../model/oshiVideosQuery"
import { useOshiVideos } from "../hooks/useOshiVideos"
import type { HomeAllFeed } from "../hooks/useHomeAllFeed"
import { useVideoTopicCatalog } from "../hooks/useVideoTopicCatalog"
import { fetchVideoTopics } from "../data/videoTopics"
import { useVideoSearch } from "../../video-search/hooks/useVideoSearch"
import { clearVideoSearchInput, useVideoSearchInput } from "../../video-search/hooks/useVideoSearchInput"
import { useBreakpoint } from "../../../shared/hooks/useBreakpoint"

interface RecentVideosSectionProps {
  creatorId: string
  /** The one shared Home selected-video path (see HomePage.tsx) -- a normal
   * card click switches the central Oshi Stream player directly, never a
   * modal/second player. Drag-to-scroll (see VideoTrack) never calls this. */
  onSelectVideo: (video: { videoId: string; title: string }) => void
  /** Home's shared ALL dataset (see useHomeAllFeed): while ALL is showing with its default controls this section reads it instead of fetching
   * the same pages a second time, so Video List ALL and Latest Activity can never diverge. Without it the section fetches its own. */
  allFeed?: HomeAllFeed
}

/** The app's own phone/tablet boundary (useBreakpoint's tablet minimum): below it the header carries the video search input. */
const PHONE_MIN_TABLET_WIDTH = 768

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
 * thumbnail JPG endpoint -- no separate fetch, keyed only by the real
 * videoId the API returned (never a substituted placeholder video). */
function VideoThumbCard({ video, onOpen }: { video: RecentVideo; onOpen: (video: RecentVideo) => void }) {
  const [thumbFailed, setThumbFailed] = useState(false)
  const [locale] = useLocale()
  const isLiveNow = video.contentFormat === "live_now"
  // A Premiere is not a livestream, but like one it has not happened yet: opening its waiting page is not watching it. A pending-archive
  // placeholder (ended, archive not yet verified) is not confirmed watchable either -- opening it must not mark the eventual real archive seen.
  const isNotYetWatchable =
    isLiveNow || video.contentFormat === "live_upcoming" || video.contentFormat === "premiere" || video.contentFormat === "archive_pending"
  const meta = formatCardMeta(video)

  return (
    <button
      type="button"
      className="oshi-video-card"
      onClick={() => {
        // No NEW badge here (Oshi Status owns it), but an open still clears the shared NEW state.
        // A live/upcoming stream (or a Premiere) is never NEW and a click is not watching it: only an archive/upload counts as opened.
        if (!isNotYetWatchable) markContentSeen(video.videoId)
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

/** Phone search results: ONE video per row, stacked vertically (never a carousel or a grid), each the same card as the shelf's, so the
 * thumbnail, title, view count / date and the LIVE badge are unchanged and opening one runs the same selection. Distinct states: still
 * loading, the request FAILED (the shelf's own error state -- never shown as "no results"), and a genuine empty result (the same
 * "no matching videos" state the desktop shows). */
function SearchResultsList({
  videos,
  loading,
  error,
  emptyLabel,
  onOpen,
}: {
  videos: RecentVideo[]
  loading: boolean
  error: Error | null
  emptyLabel: string
  onOpen: (video: RecentVideo) => void
}) {
  if (error) return <OshiErrorState error={error} />
  if (loading) {
    return (
      <div className="oshi-videos__results" role="status" aria-busy="true">
        {[0, 1, 2, 3].map((row) => (
          <span key={row} className="oshi-loading-line oshi-videos__results-skeleton" />
        ))}
      </div>
    )
  }
  if (videos.length === 0) return <div className="oshi-empty-state" role="status">{emptyLabel}</div>
  return (
    <ul className="oshi-videos__results">
      {videos.map((video) => (
        <li key={video.videoId} className="oshi-videos__results-item">
          <VideoThumbCard video={video} onOpen={onOpen} />
        </li>
      ))}
    </ul>
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

/** The filter bar -- the 3 frontend-owned special filters followed by
 * whatever backend topics GET /topics returned, in that fixed order
 * (not alphabetical/count/recency/LIVE-status based), rendered as one Ant
 * Design Segmented control (not N independent buttons) so the whole list
 * reads as a single continuous selector regardless of how many backend
 * topics there currently are. `options` is computed by the caller (it alone
 * knows the current locale and the current backend topic catalog state);
 * this component just renders whatever list it's given. `trailing` (the
 * sort control) renders as the next sibling in this same flex row, sharing
 * its existing `gap` instead of a margin of its own. Deliberately NOT the
 * shared .shared-filter-segmented skin used by Notification Settings/
 * Favorites/Live Status (confirmed with the user): this bar keeps its own
 * compact "small" sizing, and its colors/radius come from the ConfigProvider
 * component tokens below -- fixed, never creator-tinted (confirmed with the
 * user: the selected tag's own color must not shift when currentOshi
 * changes). trackBg matches .oshi-videos's own panel background
 * (--oshi-surface-1) rather than the shared skin's surface tone, so the
 * track reads as part of the panel instead of a separately-colored control
 * sitting on it. */
function VideoSectionTagBar({
  selected,
  onSelect,
  options,
  trailing,
  onTagClick,
}: {
  selected: VideoSectionSelection
  onSelect: (selection: VideoSectionSelection) => void
  options: { value: VideoSectionSelection; label: string }[]
  trailing?: ReactNode
  /** Fires for EVERY click on a tag, including the already-selected one (Segmented's own onChange does not fire for that). */
  onTagClick?: () => void
}) {
  return (
    <div className="oshi-videos__filters">
      {/* The tag strip is its OWN scroll container, apart from the controls: a strip that cannot fit scrolls sideways inside this box
          instead of painting over the dropdowns that follow it (and, on a phone, the controls take their own row below it). */}
      <div
        className="oshi-videos__tags"
        onClick={(event) => {
          if ((event.target as HTMLElement).closest(".ant-segmented-item")) onTagClick?.()
        }}
      >
        <ConfigProvider
          theme={{
            components: {
              Segmented: {
                trackBg: "var(--oshi-surface-1)",
                trackPadding: 2,
                itemColor: "var(--oshi-text-3)",
                itemHoverColor: "var(--oshi-text-1)",
                itemHoverBg: "rgba(255, 255, 255, 0.05)",
                // Fixed neutral, never creator-tinted (confirmed with the
                // user: the selected tag's own color must not shift with
                // currentOshi) -- --oshi-surface-3, no --creator-main mix.
                itemSelectedBg: "var(--oshi-surface-3)",
                itemSelectedColor: "var(--oshi-text-1)",
                borderRadius: 4,
                borderRadiusSM: 4,
              },
            },
          }}
        >
          <Segmented<VideoSectionSelection>
            size="small"
            classNames={{
              root: "oshi-videos__segmented",
              item: "oshi-videos__segment-item",
              label: "oshi-videos__segment-label",
            }}
            value={selected}
            onChange={onSelect}
            options={options}
          />
        </ConfigProvider>
      </div>

      <div className="oshi-videos__controls">{trailing}</div>
    </div>
  )
}

const SORT_OPTIONS: readonly VideoSortOption[] = ["newest", "oldest", "mostViews"]
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
 * (its All/1d/7d/30d period is a separate dropdown, see ViewWindowDropdown). Only for the topic
 * tags (ALL + the 7 categories); the quick filters have a fixed newest-first order. */
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
      {SORT_OPTIONS.map((sort) => (
        <option key={sort} value={sort}>
          {t(locale, SORT_LABEL_KEYS[sort])}
        </option>
      ))}
    </select>
  )
}

/** The period dropdown (All / 1d / 7d / 30d): rendered ONLY while the sort is "most viewed", right
 * beside the sort dropdown. It is not rendered at all for newest/oldest. */
function ViewWindowDropdown({
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

/** All / Live / Videos -- narrows the selected topic (ALL included) to one content
 * type. Same visibility rule as the sort dropdown: the quick filters don't use it. */
function ContentTypeDropdown({
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
export function RecentVideosSection({ creatorId, onSelectVideo, allFeed }: RecentVideosSectionProps) {
  const [locale] = useLocale()
  const [selectedTag, setSelectedTag] = useState<VideoSectionSelection>("all")
  const [sortOption, setSortOption] = useState<VideoSortOption>("newest")
  const [viewWindow, setViewWindow] = useState<VideoViewWindow>("total")
  const [contentType, setContentType] = useState<VideoContentType>("all")
  const topicCatalog = useVideoTopicCatalog(fetchVideoTopics)
  // Desktop search: no separate open/close gesture and no submit step -- every keystroke's onChange IS the query. While Search is
  // active (the normalized query meets useVideoSearch's activation threshold) the shelf shows the creator's multilingual search
  // results; the header (search box, Topic Tags and the content type / sort / period controls) never changes, so nothing jumps.
  // The search lives in ONE shared store (useVideoSearchInput): this section's desktop box and the phone header's input are two views of
  // it and feed this same search. Desktop / tablet: the box is input-driven (the typed text is the query). Phone: the header input only
  // edits a DRAFT; the query is whatever was last submitted with the keyboard's Enter, and emptying the draft ends the search at once.
  // On a desktop or tablet the query still ends with the section (leaving Home clears it, as the old local state did); on a phone it stays,
  // since the header input that shows it stays on every page.
  const { draft, submitted: searchQuery, isComposing, setLive, setComposing: setIsComposing, clear: clearSearch } = useVideoSearchInput()
  const isPhone = useBreakpoint() === "mobile"
  // Phone: a submitted query REPLACES Home's content (HomePage drops the player and Oshi Status; this section shows a vertical results
  // list instead of the shelf). The section itself stays mounted, so the selected Topic Tag, content type, sort and period survive.
  const mobileSearchView = isPhone && searchQuery !== ""
  useEffect(
    () => () => {
      if (window.innerWidth >= PHONE_MIN_TABLET_WIDTH) clearVideoSearchInput()
    },
    [],
  )

  // The bar is FIXED at twelve options -- ALL, 最新影片, 最新直播, 雜談, 歌回, MV, Apex, Minecraft, SF6, VALO, Short, 其他 -- whatever
  // GET /topics returns: the catalog supplies each topic's id and localized label, but never decides which topics Home shows (the rest of the
  // catalog is for Search and the future Video Filter Dialog). The special filters always render; the topics only once GET /topics has
  // actually succeeded -- never a stale/hardcoded topic list while loading or on a failed fetch. Short is a content-format filter, placed
  // immediately before the Other topic (at the end when there is no Other topic).
  const tagOptions = useMemo(() => {
    const option = (filter: SpecialVideoFilter) => ({
      value: filter as VideoSectionSelection,
      label: t(locale, SPECIAL_VIDEO_FILTER_LABEL_KEYS[filter]),
    })
    const special = SPECIAL_VIDEO_FILTERS.map(option)
    const categories = buildHomeVideoTagEntries(topicCatalog.state.status === "success" ? topicCatalog.state.topics : null, locale)
    return [...special, ...categories.map((entry) => ({ value: entry.id as VideoSectionSelection, label: entry.label }))]
  }, [locale, topicCatalog.state])

  const canonicalCreatorId = resolveCreatorKey(creatorId)?.creatorId
  const shelfQuery = useMemo(
    () => buildShelfQuery(selectedTag, canonicalCreatorId, { contentType, sort: sortOption, viewWindow }),
    [selectedTag, canonicalCreatorId, contentType, sortOption, viewWindow],
  )
  const usesSharedAll = allFeed !== undefined && isHomeAllDefault(selectedTag, { contentType, sort: sortOption, viewWindow })
  const ownShelf = useOshiVideos(usesSharedAll ? null : shelfQuery)
  const shelf = usesSharedAll ? allFeed.page : ownShelf
  // Existing content type / sort / period stay active during a Search, but there is deliberately no topic / tag field here: Search is
  // creator-scoped over the creator's indexed catalog and can never be narrowed by the selected Topic Tag (the endpoint has none).
  const searchBase = useMemo(
    () => (canonicalCreatorId ? { creatorId: canonicalCreatorId, contentType, sort: sortOption, viewWindow } : null),
    [canonicalCreatorId, contentType, sortOption, viewWindow],
  )
  // The SAME already-downloaded GET /topics catalog the tags use: Search resolves topics locally against it, never a second fetch.
  const searchTopics = topicCatalog.state.status === "success" ? topicCatalog.state.topics : []
  const search = useVideoSearch(searchQuery, searchBase, { isComposing, topics: searchTopics })
  const isSearchActive = search.active
  // Emptying the search ends it at once (focus, a pending request or loaded results change nothing): the normal Topic list returns, and its
  // data is REFRESHED -- fetched again from the first page through the normal loader -- rather than trusting whatever was mounted before the
  // search. The late response of a search that was still pending can never land (useVideoSearch invalidates and aborts it when it ends).
  const searchedSinceEmpty = useRef(false)
  const refreshShelf = shelf.refresh
  useEffect(() => {
    if (isSearchActive || mobileSearchView) searchedSinceEmpty.current = true
    if (searchQuery === "" && searchedSinceEmpty.current) {
      searchedSinceEmpty.current = false
      refreshShelf?.()
    }
  }, [isSearchActive, mobileSearchView, searchQuery, refreshShelf])
  // Clicking ANY Topic Tag (a different one, ALL, or the one already selected -- every selection, keyboard included, is a click) leaves the search: the query clears (the box stays visible and
  // empty), the normal list of the selected tag returns, and content type / sort / period are untouched. Ending the query also aborts and
  // invalidates any pending search request inside useVideoSearch, so a late response cannot overwrite the tag's list.
  const leaveSearch = () => {
    searchedSinceEmpty.current = false // the clicked tag loads its own list: no extra refresh of the old one
    clearSearch()
  }

  // 最新直播 = LIVE, then UPCOMING, then archives. The archive endpoint is archive-only by design (liveStatus=archived),
  // so the creator's current live/upcoming streams come from the canonical GET /live-streams store and are merged in
  // BEFORE anything is displayed -- never subject to the archive request's limit/offset. ALL is the union of 最新直播 and
  // 最新影片, so while it shows newest-first livestream content (content type all/live) the current streams lead it too.
  const { streams } = useLiveStreams()
  const showsCurrentStreams =
    !isSearchActive &&
    (selectedTag === "latestLive" || (selectedTag === "all" && sortOption === "newest" && (contentType === "all" || contentType === "live")))
  const shelfVideos = useMemo(() => {
    if (isSearchActive) return search.videos
    if (usesSharedAll) return allFeed.videos
    if (!showsCurrentStreams) return shelf.videos
    // ALL (content type "all") shows a Premiere's waiting page like any other upcoming video (toRecentVideo maps it
    // to contentFormat "live_upcoming", sorted by its own scheduledStart). This same branch also serves 最新直播 and
    // ALL narrowed to content type "live" -- both livestream-only views by definition -- so a Premiere, which is not
    // a livestream, is excluded from those two specifically.
    const livestreamOnlyView = selectedTag === "latestLive" || contentType === "live"
    const current = canonicalCreatorId
      ? streams.filter((stream) => stream.creatorId === canonicalCreatorId && (!livestreamOnlyView || stream.status !== "premiere")).map(toRecentVideo)
      : []
    return composeLatestLiveShelf(current, shelf.videos)
  }, [isSearchActive, search.videos, usesSharedAll, allFeed, showsCurrentStreams, canonicalCreatorId, streams, shelf.videos])

  // A stream the user watched while it was live is now observed as a completed archive: turn that marker into a
  // permanent seen entry (never NEW). Only completed archives count -- a live/upcoming row is skipped.
  useEffect(() => {
    migrateWatchedLiveToSeen(shelfVideos.filter((video) => video.contentFormat === "live_archive").map((video) => video.videoId))
  }, [shelfVideos])

  // The dropdowns apply to the topic tags AND to an active Search (the selected tag is ignored during Search, so a quick filter
  // never hides them then); the period dropdown only to the most-viewed sort.
  const showShelfFilters = isSearchActive || !isQuickFilterSelection(selectedTag)
  const showViewWindow = showShelfFilters && sortOption === "mostViews"

  const emptyLabel = isSearchActive
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

  if (mobileSearchView) {
    return (
      <section className="oshi-videos oshi-videos--results" aria-label={t(locale, "videoSearch.placeholder")}>
        <SearchResultsList
          videos={search.videos}
          loading={search.active && search.loading}
          error={search.error}
          emptyLabel={t(locale, "videoSearch.empty")}
          // Opening a result is the end of the search: the video goes to Home's player (the existing selection path) and Home returns.
          onOpen={(video) => {
            clearSearch()
            onSelectVideo({ videoId: video.videoId, title: video.title })
          }}
        />
      </section>
    )
  }

  return (
    <section className="oshi-videos">
      <header className="oshi-videos__header">
        <VideoSearchBox
          value={draft}
          onChange={setLive}
          locale={locale}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
        />
        <VideoSectionTagBar
          selected={selectedTag}
          onSelect={setSelectedTag}
          onTagClick={leaveSearch}
          options={tagOptions}
          trailing={
            <>
              <ContentTypeDropdown
                value={contentType}
                onChange={setContentType}
                locale={locale}
                hidden={!showShelfFilters || (!isSearchActive && selectedTag === SHORT_VIDEO_FILTER)}
              />
              <VideoSortDropdown value={sortOption} onChange={setSortOption} locale={locale} hidden={!showShelfFilters} />
              {showViewWindow && <ViewWindowDropdown value={viewWindow} onChange={setViewWindow} locale={locale} />}
            </>
          }
        />
        {/* V1: the control has no destination yet (see ViewAllButton), so production does not render it at all -- no hidden/inert
            element; it stays available to local development. `import.meta.env.DEV` is replaced at build time, so a production bundle
            contains no trace of the element. */}
        {import.meta.env.DEV && <ViewAllButton locale={locale} />}
      </header>

      {/* key = the creator + what the shelf is actually showing: a fresh track (scroll position and
          prefetch threshold) per creator, tag, content type, sort and period -- otherwise switching
          creator while the same tag stays selected would carry the PREVIOUS creator's scroll state
          onto the new creator's videos. An active Search gets its own key component (the query itself) so switching between browsing and
          searching -- or between two queries -- never carries scroll state across. */}
      <VideoTrack
        key={`${creatorId}:${isSearchActive ? `search:${searchQuery}` : shelfQuery ? oshiVideosQueryKey(shelfQuery) : selectedTag}`}
        videos={shelfVideos}
        emptyLabel={emptyLabel}
        error={isSearchActive ? search.error : shelf.error}
        onOpen={(video) => onSelectVideo({ videoId: video.videoId, title: video.title })}
        // A Search response is already the query's complete result set -- only the browsing shelf pages.
        onNearEnd={isSearchActive ? () => {} : shelf.loadMore}
      />
    </section>
  )
}
