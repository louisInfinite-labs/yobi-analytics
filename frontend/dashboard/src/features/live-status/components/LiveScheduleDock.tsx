import { useEffect, useRef, useState } from "react"
import { ConfigProvider, Segmented } from "antd"
import { Search } from "lucide-react"
import { CreatorStatusList } from "./CreatorStatusList"
import { mockCreators } from "../../../entities/creator/data/mockCreators"
import { useCurrentPage } from "../../../app/navigation/useCurrentPage"
import { useConfirmOshiSwitchPreference } from "../../oshi/hooks/useConfirmOshiSwitchPreference"
import { useCountdownLanguage } from "../../../shared/i18n/hooks/useCountdownLanguage"
import { useCreatorStatuses } from "../hooks/useCreatorStatuses"
import { useFavoriteCreators } from "../../favorites/hooks/useFavoriteCreators"
import { setLiveDockExpanded } from "../hooks/useLiveDockExpanded"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { usePrefersReducedMotion } from "../../../shared/hooks/usePrefersReducedMotion"
import { useSelectedCreator } from "../../oshi/hooks/useSelectedCreator"
import { useUpcomingDisplayMode } from "../hooks/useUpcomingDisplayMode"
import { creatorThemeStyle } from "../../../shared/theme/creatorThemeStyle"
import { selectHomeVideo } from "../../home-room/hooks/useHomeSelectedVideo"
import { t } from "../../../shared/i18n/translations"
import { formatCountdown } from "../model/creatorStatusFormat"
import type { CountdownLanguage } from "../../../shared/i18n/model/countdownLanguage"
import type { CreatorStatus } from "../model/creatorStatus"
import { VideoPlayerModal } from "../../media-player/components/VideoPlayerModal"

/** "favorites" — only creators the user has starred; "all" — everyone. */
type ViewMode = "all" | "favorites"

/** "full" — the drawer reaches the top of the screen (the default every time
 * it opens); "compact" — the original min(70vh, 520px) size, one click away
 * via the header's resize button. Width is var(--live-status-width) either
 * way (aliased to the shared --home-status-width token -- see home.css). */
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

/** Global Live Status: a dark floating trigger that opens a right-side drawer
 * whose width always matches Home's Oshi Status column exactly (the shared
 * --home-status-width token). The drawer OVERLAYS whatever page is showing
 * (position: fixed) and is never a layout column of it, so opening it can't
 * resize Home's stream, player or video strip. Mounted once above every page
 * (App.tsx), so it stays available across Dashboard/Admin/Home.
 *
 * The trigger stays neutral dark on purpose — it is not bound to
 * --creator-main — while the drawer's own accents do follow the current
 * Oshi, which is why the creator theme variables are set on this wrapper
 * rather than inside Home (both of these render outside Home's own tree). */
export function LiveScheduleDock() {
  const [expanded, setExpanded] = useState(false)
  // The roster only mounts on the first open and stays mounted afterwards:
  // the drawer itself is always in the DOM so it can slide, but rendering
  // ~70 status rows before anyone has asked for them isn't free.
  const [hasOpened, setHasOpened] = useState(false)
  const [panelSize, setPanelSize] = useState<PanelSize>("full")
  const [viewMode, setViewMode] = useState<ViewMode>("all")
  const [query, setQuery] = useState("")
  // Non-Home only (see the onSelectVideo callback below) -- Home has its own
  // central player (useHomeSelectedVideo) with no modal, so this never gets
  // set while Home is the active page.
  const [embed, setEmbed] = useState<{ videoId: string; title: string } | null>(null)
  const [page] = useCurrentPage()
  const [displayMode] = useUpcomingDisplayMode()
  const [language] = useCountdownLanguage()
  const { statuses, now } = useCreatorStatuses()
  const { favorites, toggleFavorite } = useFavoriteCreators()
  const [selectedCreatorId, setSelectedCreatorId] = useSelectedCreator()
  // The one lookup into this dock's current mock creator source needed to
  // bind its own theme wrapper below -- see creatorThemeStyle's own
  // docstring for why it takes the resolved themeColor instead of doing
  // this same lookup itself.
  const selectedCreator = mockCreators.find((entry) => entry.channelId === selectedCreatorId)
  const [locale] = useLocale()
  const [confirmOshiSwitch, setConfirmOshiSwitch] = useConfirmOshiSwitchPreference()
  const reducedMotion = usePrefersReducedMotion()
  const dockRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // Set by closeExplicitly(), consumed by the focus-restore effect below --
  // see that effect's own comment for why the trigger can't be focused
  // synchronously inside closeExplicitly itself.
  const restoreFocusRef = useRef(false)

  const favoriteOnlyIds = viewMode === "favorites" ? favorites : undefined
  const summaryStatuses = favoriteOnlyIds
    ? Object.fromEntries(Object.entries(statuses).filter(([id]) => favoriteOnlyIds.has(id)))
    : statuses
  const summary = summarize(summaryStatuses, now, language)

  // Mirrors this component's own `expanded` state out to the module-level
  // useLiveDockExpanded store so Home can expose it to CSS as
  // data-live-status-open without this component needing to know Home
  // exists at all.
  useEffect(() => {
    setLiveDockExpanded(expanded)
  }, [expanded])

  useEffect(() => {
    if (!expanded) return
    searchInputRef.current?.focus()

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeExplicitly()
    }
    function handlePointerDown(event: PointerEvent) {
      if (!(event.target instanceof Node) || !dockRef.current) return
      if (dockRef.current.contains(event.target)) return
      // The Oshi-switch confirmation portals to <body> (it has to escape the
      // drawer's own transform), so it is outside the dock by construction —
      // interacting with it must not count as clicking away from the drawer.
      if (event.target instanceof Element && event.target.closest(".oshi-switch-confirm__backdrop")) return
      setExpanded(false)
    }
    document.addEventListener("keydown", handleKeyDown)
    document.addEventListener("pointerdown", handlePointerDown)
    return () => {
      document.removeEventListener("keydown", handleKeyDown)
      document.removeEventListener("pointerdown", handlePointerDown)
    }
  }, [expanded])

  function open() {
    setHasOpened(true)
    setPanelSize("full")
    setExpanded(true)
  }

  // Runs once the DOM has actually committed the closed state (not
  // synchronously inside closeExplicitly): the trigger is still
  // visibility:hidden at the moment expanded flips to false -- CSS only
  // un-hides it once .live-status-dock's own data-live-status-open attribute
  // re-renders -- and focusing a still-hidden element is a silent no-op in
  // every engine, not a deferred one. Waiting for this effect (which runs
  // after that render has painted) is what makes the focus call land.
  useEffect(() => {
    if (expanded || !restoreFocusRef.current) return
    restoreFocusRef.current = false
    triggerRef.current?.focus()
  }, [expanded])

  // Escape and the close button explicitly dismiss the drawer -- `inert`
  // then makes its subtree unfocusable, so if focus was still inside it
  // (the search input, a creator row) it would otherwise be dropped to
  // <body> instead of landing anywhere sensible. Outside-click and
  // video-selection closes are deliberately NOT routed through this: the
  // user's focus in those cases is already elsewhere (whatever they clicked,
  // or the video modal that just opened), so forcing it back to the trigger
  // would fight what they were already doing.
  function closeExplicitly() {
    restoreFocusRef.current = true
    setExpanded(false)
  }

  return (
    <>
      <div
        ref={dockRef}
        className={`live-status-dock${reducedMotion ? " live-status-dock--no-motion" : ""}`}
        data-live-status-open={expanded}
        style={creatorThemeStyle(selectedCreatorId, selectedCreator?.themeColor)}
      >
        <button ref={triggerRef} type="button" className="live-status-trigger" onClick={open}>
          <span className={`live-status-trigger__dot live-status-trigger__dot--${summary.dotColor}`} aria-hidden="true" />
          {summary.text}
        </button>

        <aside
          className="live-status-drawer"
          role="dialog"
          aria-label={t(locale, "liveScheduleDock.panelAriaLabel")}
          data-size={panelSize}
          inert={!expanded}
        >
          <div className="live-status-drawer__header">
            <div className="live-status-drawer__title-row">
              <span className="live-status-drawer__title">{t(locale, "liveScheduleDock.title")}</span>
              <button
                type="button"
                className="live-status-drawer__resize"
                onClick={() => setPanelSize((prev) => (prev === "full" ? "compact" : "full"))}
                aria-label={t(locale, panelSize === "full" ? "liveScheduleDock.resize.shrinkAria" : "liveScheduleDock.resize.expandAria")}
                aria-pressed={panelSize === "full"}
                title={t(locale, panelSize === "full" ? "liveScheduleDock.resize.shrink" : "liveScheduleDock.resize.expand")}
              >
                {panelSize === "full" ? "⤡" : "⤢"}
              </button>
              <button type="button" className="live-status-drawer__close" onClick={closeExplicitly} aria-label={t(locale, "liveScheduleDock.close")}>
                ×
              </button>
            </div>

            <div className="live-status-search">
              <Search size={13} aria-hidden="true" />
              <input
                ref={searchInputRef}
                type="text"
                placeholder={t(locale, "oshiSettings.searchPlaceholder")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>

            <div className="live-status-filter-row">
              {/* Ant Design Segmented, same dark-token pattern as Settings >
               * Oshi Settings' own All/Favorites control and Home > Oshi
               * Videos' tag bar -- itemSelectedBg is the only token tied to
               * --creator-main (a low color-mix, not a solid fill), so
               * switching currentOshi tints just the selected segment. */}
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
                <Segmented<ViewMode>
                  size="small"
                  classNames={{
                    root: "live-status-view-segmented",
                    item: "live-status-view-segment-item",
                    label: "live-status-view-segment-label",
                  }}
                  value={viewMode}
                  onChange={setViewMode}
                  options={[
                    { value: "all", label: t(locale, "recentVideos.tag.all") },
                    { value: "favorites", label: t(locale, "oshiSettings.viewFilter.favoritesOnly") },
                  ]}
                />
              </ConfigProvider>
            </div>
          </div>

          <div className="live-status-drawer__body">
            {hasOpened && (
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
                onSelectVideo={(video, creatorId) => {
                  // On Home, route into the same canonical player-selection
                  // path Oshi Videos/Recent Activity use (never this
                  // drawer's own modal) so there is only ever one player
                  // surface. Off Home there is no central player to select
                  // into, so the modal remains -- this is the one legitimate
                  // remaining use of it (see this component's own top
                  // docstring: the dock is mounted above every page, not
                  // just Home).
                  if (page === "home") {
                    selectHomeVideo(video, creatorId)
                  } else {
                    setEmbed(video)
                  }
                  setExpanded(false)
                }}
              />
            )}
          </div>
        </aside>
      </div>

      {embed && <VideoPlayerModal videoId={embed.videoId} title={embed.title} onClose={() => setEmbed(null)} />}
    </>
  )
}
