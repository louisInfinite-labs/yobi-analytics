import { useEffect, useRef, useState } from "react"
import { CreatorStatusList } from "./CreatorStatusList"
import { useConfirmOshiSwitchPreference } from "../hooks/useConfirmOshiSwitchPreference"
import { useCountdownLanguage } from "../hooks/useCountdownLanguage"
import { useCreatorStatuses } from "../hooks/useCreatorStatuses"
import { useFavoriteCreators } from "../hooks/useFavoriteCreators"
import { useLocale } from "../hooks/useLocale"
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion"
import { useSelectedCreator } from "../hooks/useSelectedCreator"
import { useUpcomingDisplayMode } from "../hooks/useUpcomingDisplayMode"
import { formatCountdown, type CountdownLanguage } from "../lib/creatorStatusFormat"
import type { CreatorStatus } from "../types/creatorStatus"
import { VideoPlayerModal } from "./VideoPlayerModal"

/** "我的收藏" — only creators the user has starred; "all" — everyone. */
type ViewMode = "all" | "favorites"

/** Collapsed-state summary: nothing to fetch here — it only reads the
 * already-shared statuses (spec: "Avoid refetching when the Dock opens").
 * Prefers a live count; falls back to the single nearest upcoming stream.
 * `statuses` is pre-filtered by the caller to the current view mode
 * (all/favorites), so this never needs to know about favorites itself. */
function summarize(statuses: Record<string, CreatorStatus>, now: Date, language: CountdownLanguage): string {
  const values = Object.values(statuses)
  const liveCount = values.filter((s) => s.kind === "live").length
  if (liveCount > 0) return `${liveCount} LIVE`

  const nextUpcoming = values
    .filter((s): s is Extract<CreatorStatus, { kind: "upcoming" }> => s.kind === "upcoming")
    .sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart))[0]
  if (nextUpcoming) return formatCountdown(nextUpcoming.scheduledStart, now, language)

  return "OFFLINE"
}

/** Global Live Schedule Dock (spec section of the same name) — collapsed
 * bottom-right summary that expands into a searchable, grouped creator
 * list (CreatorStatusList, shared with Home's inline "ListStatus" panel).
 * Mounted once above every page (App.tsx), so it stays visible across
 * Dashboard/Admin/Home regardless of which one is showing.
 *
 * The collapsed pill also carries the favorites-view switch (⇄) merged
 * directly into it, one pill, no second widget next to it — Home briefly
 * had its own separate creator-name+switch+live pill, but that just
 * duplicated this one already-existing bottom-right pill (this session,
 * marking the duplicate with an X: "為什麼還有2個在" / "我說了只要有右下角
 * 的一個"), so the switch was merged in here instead rather than kept as a
 * second widget. */
export function LiveScheduleDock() {
  const [expanded, setExpanded] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>("all")
  const [query, setQuery] = useState("")
  const [embed, setEmbed] = useState<{ videoId: string; title: string } | null>(null)
  const [displayMode] = useUpcomingDisplayMode()
  const [language] = useCountdownLanguage()
  const { statuses, now } = useCreatorStatuses()
  const { favorites, toggleFavorite } = useFavoriteCreators()
  const [, setSelectedCreatorId] = useSelectedCreator()
  const [locale] = useLocale()
  const [confirmOshiSwitch, setConfirmOshiSwitch] = useConfirmOshiSwitchPreference()
  const reducedMotion = usePrefersReducedMotion()
  const dockRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const favoriteOnlyIds = viewMode === "favorites" ? favorites : undefined
  const summaryStatuses = favoriteOnlyIds
    ? Object.fromEntries(Object.entries(statuses).filter(([id]) => favoriteOnlyIds.has(id)))
    : statuses

  useEffect(() => {
    if (!expanded) return
    searchInputRef.current?.focus()

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setExpanded(false)
    }
    function handlePointerDown(event: PointerEvent) {
      if (dockRef.current && event.target instanceof Node && !dockRef.current.contains(event.target)) {
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
    <>
      <div
        ref={dockRef}
        className={`live-schedule-dock${expanded ? " live-schedule-dock--expanded" : ""}${reducedMotion ? " live-schedule-dock--no-motion" : ""}`}
      >
        {!expanded ? (
          <div className="live-schedule-dock__summary">
            <button
              type="button"
              className="live-schedule-dock__view-toggle"
              onClick={() => setViewMode((prev) => (prev === "all" ? "favorites" : "all"))}
              aria-label={viewMode === "all" ? "Show only my favorites" : "Show all creators"}
              aria-pressed={viewMode === "favorites"}
              title={viewMode === "all" ? "全部 / 我的收藏" : "我的收藏 / 全部"}
            >
              ⇄
            </button>
            <button type="button" className="live-schedule-dock__summary-text" onClick={() => setExpanded(true)}>
              <span className="live-schedule-dock__dot live-schedule-dock__dot--red" aria-hidden="true" />
              {summarize(summaryStatuses, now, language)}
            </button>
          </div>
        ) : (
          <div className="live-schedule-dock__panel" role="dialog" aria-label="Live schedule search">
            <div className="live-schedule-dock__header">
              <input
                ref={searchInputRef}
                type="text"
                className="live-schedule-dock__search"
                placeholder="Search creator..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <button type="button" className="live-schedule-dock__close" onClick={() => setExpanded(false)} aria-label="Close">
                ×
              </button>
            </div>

            <div className="live-schedule-dock__list">
              <CreatorStatusList
                statuses={statuses}
                now={now}
                displayMode={displayMode}
                language={language}
                query={query}
                favoriteOnlyIds={favoriteOnlyIds}
                favorites={favorites}
                onToggleFavorite={toggleFavorite}
                onSelectCreator={setSelectedCreatorId}
                locale={locale}
                confirmOshiSwitch={confirmOshiSwitch}
                onConfirmOshiSwitchChange={setConfirmOshiSwitch}
                onSelectVideo={(video) => {
                  setEmbed(video)
                  setExpanded(false)
                }}
              />
            </div>
          </div>
        )}
      </div>

      {embed && <VideoPlayerModal videoId={embed.videoId} title={embed.title} onClose={() => setEmbed(null)} />}
    </>
  )
}
