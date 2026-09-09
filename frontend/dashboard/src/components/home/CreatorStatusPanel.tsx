import { useEffect, useRef, useState } from "react"
import { mockCreators } from "../../data/mockCreators"
import { useCountdownLanguage } from "../../hooks/useCountdownLanguage"
import { useCreatorStatuses } from "../../hooks/useCreatorStatuses"
import { useFavoriteCreators } from "../../hooks/useFavoriteCreators"
import { useUpcomingDisplayMode } from "../../hooks/useUpcomingDisplayMode"
import { CreatorStatusList, countLiveAndOffline } from "../CreatorStatusList"
import { VideoPlayerModal } from "../VideoPlayerModal"

interface CreatorStatusPanelProps {
  creatorId: string
}

type PanelSize = "top" | "half"

/** "我的收藏" — only creators the user has starred; "all" — everyone. */
type ViewMode = "all" | "favorites"

/** Home's right-hand "ListStatus" panel (this session's own layout spec):
 * the selected creator's own name at top, and — collapsed by default,
 * showing only the live/offline counts ("預設ListStatus係唔打開 只顯示直播數
 * 同OFF數") — an expandable panel sharing CreatorStatusList's content with
 * the global Dock. Expands as a floating overlay rather than pushing the
 * page taller, so the 1920x1080-no-scroll layout budget holds even while
 * open. Once expanded it has two sizes ("到畫面最頂"/"畫面一半"), defaulting
 * to the taller "top" one; collapsing back to the counts-only summary is
 * still via Esc/outside click, not a third size. */
export function CreatorStatusPanel({ creatorId }: CreatorStatusPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [size, setSize] = useState<PanelSize>("top")
  const [viewMode, setViewMode] = useState<ViewMode>("all")
  const [query, setQuery] = useState("")
  const [embed, setEmbed] = useState<{ videoId: string; title: string } | null>(null)
  const [displayMode] = useUpcomingDisplayMode()
  const [language] = useCountdownLanguage()
  const { statuses, now } = useCreatorStatuses()
  const { favorites, toggleFavorite } = useFavoriteCreators()
  const panelRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const creatorName = mockCreators.find((c) => c.channelId === creatorId)?.channelName ?? creatorId
  const favoriteOnlyIds = viewMode === "favorites" ? favorites : undefined
  const { live, offline } = countLiveAndOffline(statuses, favoriteOnlyIds)

  useEffect(() => {
    if (!expanded) return
    searchInputRef.current?.focus()

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setExpanded(false)
    }
    function handlePointerDown(event: PointerEvent) {
      if (panelRef.current && event.target instanceof Node && !panelRef.current.contains(event.target)) {
        setExpanded(false)
      }
    }
    document.addEventListener("keydown", handleKeyDown)
    document.addEventListener("pointerdown", handlePointerDown)
    return () => {
      document.removeEventListener("keydown", handleKeyDown)
      document.removeEventListener("pointerdown", handlePointerDown)
    }
  }, [expanded])

  return (
    <div ref={panelRef} className="creator-status-panel">
      <div className="creator-status-panel__name">{creatorName}</div>
      <div className="creator-status-panel__spacer" />
      <div className="creator-status-panel__bottom-bar">
        <button
          type="button"
          className="creator-status-panel__view-toggle"
          onClick={(event) => {
            event.stopPropagation()
            setViewMode((prev) => (prev === "all" ? "favorites" : "all"))
          }}
          aria-label={viewMode === "all" ? "Show only my favorites" : "Show all creators"}
          aria-pressed={viewMode === "favorites"}
          title={viewMode === "all" ? "全部 / 我的收藏" : "我的收藏 / 全部"}
        >
          ⇄
        </button>
        <button
          type="button"
          className="creator-status-panel__summary"
          onClick={() => {
            if (!expanded) setSize("top") // every fresh open defaults to "top", not whatever size was last used
            setExpanded((prev) => !prev)
          }}
        >
          <span className="creator-status-list__dot creator-status-list__dot--red" aria-hidden="true" />
          {live} LIVE
          <span className="creator-status-list__dot creator-status-list__dot--grey" aria-hidden="true" />
          {offline} OFF
        </button>
      </div>

      {expanded && (
        <div
          className={`creator-status-panel__popover creator-status-panel__popover--${size}`}
          role="dialog"
          aria-label="Creator status list"
        >
          <div className="creator-status-panel__popover-header">
            <input
              ref={searchInputRef}
              type="text"
              className="creator-status-panel__search"
              placeholder="Search creator..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button
              type="button"
              className="creator-status-panel__size-toggle"
              onClick={() => setSize((prev) => (prev === "top" ? "half" : "top"))}
              aria-label={size === "top" ? "Shrink to half screen" : "Expand to top of screen"}
              title={size === "top" ? "畫面一半" : "到畫面最頂"}
            >
              {size === "top" ? "⤡" : "⤢"}
            </button>
          </div>
          <div className="creator-status-panel__list">
            <CreatorStatusList
              statuses={statuses}
              now={now}
              displayMode={displayMode}
              language={language}
              query={query}
              favoriteOnlyIds={favoriteOnlyIds}
              favorites={favorites}
              onToggleFavorite={toggleFavorite}
              onSelectVideo={(video) => {
                setEmbed(video)
                setExpanded(false)
              }}
            />
          </div>
        </div>
      )}

      {embed && <VideoPlayerModal videoId={embed.videoId} title={embed.title} onClose={() => setEmbed(null)} />}
    </div>
  )
}
