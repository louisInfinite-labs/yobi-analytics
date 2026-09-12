import { useEffect, useRef, useState } from "react"
import { CreatorStatusList } from "./CreatorStatusList"
import { useConfirmOshiSwitchPreference } from "../hooks/useConfirmOshiSwitchPreference"
import { useCountdownLanguage } from "../hooks/useCountdownLanguage"
import { useCreatorStatuses } from "../hooks/useCreatorStatuses"
import { useFavoriteCreators } from "../hooks/useFavoriteCreators"
import { setLiveDockExpanded } from "../hooks/useLiveDockExpanded"
import { useLocale } from "../hooks/useLocale"
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion"
import { useSelectedCreator } from "../hooks/useSelectedCreator"
import { useUpcomingDisplayMode } from "../hooks/useUpcomingDisplayMode"
import { formatCountdown, type CountdownLanguage } from "../lib/creatorStatusFormat"
import type { CreatorStatus } from "../types/creatorStatus"
import { VideoPlayerModal } from "./VideoPlayerModal"

/** "我的收藏" — only creators the user has starred; "all" — everyone. */
type ViewMode = "all" | "favorites"

/** "full" — panel reaches the top of the screen (the default every time the
 * panel opens); "compact" — the original min(70vh,520px)-capped size, one
 * click away via the header's resize button. */
type PanelSize = "full" | "compact"

/** Collapsed-state summary: nothing to fetch here — it only reads the
 * already-shared statuses (spec: "Avoid refetching when the Dock opens").
 * Prefers a live count; falls back to the single nearest upcoming stream.
 * `statuses` is pre-filtered by the caller to the current view mode
 * (all/favorites), so this never needs to know about favorites itself. The
 * dot color travels with the text (red only for an actual live count;
 * grey for an upcoming countdown or OFFLINE) instead of the dot always
 * being red regardless of what the text says. */
function summarize(
  statuses: Record<string, CreatorStatus>,
  now: Date,
  language: CountdownLanguage,
): { text: string; dotColor: "red" | "grey" } {
  const values = Object.values(statuses)
  const liveCount = values.filter((s) => s.kind === "live").length
  if (liveCount > 0) return { text: `${liveCount} LIVE`, dotColor: "red" }

  const nextUpcoming = values
    .filter((s): s is Extract<CreatorStatus, { kind: "upcoming" }> => s.kind === "upcoming")
    .sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart))[0]
  if (nextUpcoming) return { text: formatCountdown(nextUpcoming.scheduledStart, now, language), dotColor: "grey" }

  return { text: "OFFLINE", dotColor: "grey" }
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
  const [panelSize, setPanelSize] = useState<PanelSize>("full")
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
  const summary = summarize(summaryStatuses, now, language)

  // Mirrors this component's own `expanded` state out to the module-level
  // useLiveDockExpanded store (spec: "home scene的max width 要和live
  // status打開時貼齊 不可重疊") so Home's scene frame can react to it
  // without this component needing to know Home exists at all.
  useEffect(() => {
    setLiveDockExpanded(expanded)
  }, [expanded])

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

  // The favorites-view switch — shown both on the collapsed pill and (per
  // this session: "箭頭位置也要和live status沒打開時一樣有switch的button")
  // inside the expanded panel's own header, so switching all/favorites
  // never requires closing the list first. Same button, same shared
  // viewMode, just rendered in two different places.
  const viewToggle = (
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
  )

  return (
    <>
      <div
        ref={dockRef}
        className={`live-schedule-dock${expanded ? " live-schedule-dock--expanded" : ""}${reducedMotion ? " live-schedule-dock--no-motion" : ""}`}
      >
        {!expanded ? (
          <div className="live-schedule-dock__summary">
            {viewToggle}
            <button
              type="button"
              className="live-schedule-dock__summary-text"
              onClick={() => {
                setPanelSize("full")
                setExpanded(true)
              }}
            >
              <span className={`live-schedule-dock__dot live-schedule-dock__dot--${summary.dotColor}`} aria-hidden="true" />
              {summary.text}
            </button>
          </div>
        ) : (
          <div
            className={`live-schedule-dock__panel${panelSize === "full" ? " live-schedule-dock__panel--full" : ""}`}
            role="dialog"
            aria-label="Live schedule search"
          >
            <div className="live-schedule-dock__header">
              {viewToggle}
              <input
                ref={searchInputRef}
                type="text"
                className="live-schedule-dock__search"
                placeholder="Search creator..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <button
                type="button"
                className="live-schedule-dock__resize"
                onClick={() => setPanelSize((prev) => (prev === "full" ? "compact" : "full"))}
                aria-label={panelSize === "full" ? "Shrink panel" : "Expand panel to full height"}
                aria-pressed={panelSize === "full"}
                title={panelSize === "full" ? "縮小" : "放大"}
              >
                {panelSize === "full" ? "⤡" : "⤢"}
              </button>
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
