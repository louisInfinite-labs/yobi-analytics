import { useEffect, useRef, useState } from "react"
import { CreatorStatusList } from "./CreatorStatusList"
import { useCountdownLanguage } from "../hooks/useCountdownLanguage"
import { useCreatorStatuses } from "../hooks/useCreatorStatuses"
import { useFavoriteCreators } from "../hooks/useFavoriteCreators"
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion"
import { useUpcomingDisplayMode } from "../hooks/useUpcomingDisplayMode"
import { formatCountdown, type CountdownLanguage } from "../lib/creatorStatusFormat"
import type { CreatorStatus } from "../types/creatorStatus"
import { VideoPlayerModal } from "./VideoPlayerModal"

/** Collapsed-state summary: nothing to fetch here — it only reads the
 * already-shared statuses (spec: "Avoid refetching when the Dock opens").
 * Prefers a live count; falls back to the single nearest upcoming stream. */
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
 * Dashboard/Admin/Home regardless of which one is showing. */
export function LiveScheduleDock() {
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState("")
  const [embed, setEmbed] = useState<{ videoId: string; title: string } | null>(null)
  const [displayMode] = useUpcomingDisplayMode()
  const [language] = useCountdownLanguage()
  const { statuses, now } = useCreatorStatuses()
  const { favorites, toggleFavorite } = useFavoriteCreators()
  const reducedMotion = usePrefersReducedMotion()
  const dockRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

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
          <button type="button" className="live-schedule-dock__summary" onClick={() => setExpanded(true)}>
            <span className="live-schedule-dock__dot live-schedule-dock__dot--red" aria-hidden="true" />
            {summarize(statuses, now, language)}
          </button>
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
      </div>

      {embed && <VideoPlayerModal videoId={embed.videoId} title={embed.title} onClose={() => setEmbed(null)} />}
    </>
  )
}
