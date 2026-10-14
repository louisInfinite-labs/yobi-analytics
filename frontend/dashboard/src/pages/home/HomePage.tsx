import { useRef } from "react"
import { Search } from "lucide-react"
import { resolveCreatorKey } from "../../entities/creator/data/creatorRegistry"
import { creatorThemeStyle } from "../../shared/theme/creatorThemeStyle"
import { useBreakpoint } from "../../shared/hooks/useBreakpoint"
import { useLocale } from "../../shared/i18n/hooks/useLocale"
import { t, type Locale } from "../../shared/i18n/translations"
import { useCreatorStatuses } from "../../features/live-status/hooks/useCreatorStatuses"
import { useLiveDockExpanded } from "../../features/live-status/hooks/useLiveDockExpanded"
import { selectHomeVideo, useHomeSelectedVideo } from "../../features/home-room/hooks/useHomeSelectedVideo"
import { useLiveStreamVideoPool } from "../../features/home-room/hooks/useRecentVideos"
import { useSelectedCreator } from "../../features/oshi/hooks/useSelectedCreator"
import { useWatchedDuringLive } from "../../features/media-player/hooks/useWatchedDuringLive"
import { selectLiveEmbedVideo } from "../../features/media-player/utils/liveEmbed"
import { OshiStatusPanel } from "../../features/oshi-status/components/OshiStatusPanel"
import { RecentVideosSection } from "../../features/home-room/components/RecentVideosSection"
import { TopbarSlotPortal } from "../../app/navigation/TopbarSlotPortal"
import { goToPage } from "../../app/navigation/useCurrentPage"

/** Mobile Home's own Search entry (spec sections 41-44): shares the phone top bar's row with the
 * hamburger (TopbarSlotPortal), reusing that bar's own icon-button treatment exactly
 * (.main-topbar__menu's declared values, see main-navbar.css) rather than inventing a new button skin.
 * Tapping it never renders Search results under Home -- it navigates straight to the dedicated mobile
 * Videos/Search view (VideosPage already autofocuses its own Search input on mount, so there is nothing
 * further to hand off between the two pages). */
function MobileSearchEntry({ locale }: { locale: Locale }) {
  return (
    <TopbarSlotPortal>
      <button type="button" className="main-topbar__menu" onClick={() => goToPage("videos")} aria-label={t(locale, "videoSearch.trigger")}>
        <Search size={22} aria-hidden="true" />
      </button>
    </TopbarSlotPortal>
  )
}

/** The real, playable YouTube embed for the selected creator -- only
 * rendered when selectLiveEmbedVideo finds something eligible (live, upcoming,
 * else the latest completed livestream).
 *
 * Desktop autoplays muted: every major browser blocks unmuted autoplay
 * without a user gesture, and this renders on page load / creator switch,
 * not a click, so muted is what actually makes autoplay work at all rather
 * than silently fail. Mobile never requests autoplay -- YouTube's own
 * embed already shows a thumbnail + play button when it isn't autoplaying,
 * so no separate placeholder UI is needed here. */
function LiveEmbedPlayer({ videoId, title, autoplay, isLive }: { videoId: string; title: string; autoplay: boolean; isLive: boolean }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // The embed reports its playback state through the YouTube IFrame API (enablejsapi); a confirmed PLAYING while this
  // very videoId is live is what records "watched during live" -- the iframe merely existing or autoplay being
  // attempted records nothing (see useWatchedDuringLive).
  useWatchedDuringLive(iframeRef, videoId, isLive)
  const params = `${autoplay ? "autoplay=1&mute=1" : "autoplay=0"}&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`
  return (
    <iframe
      key={videoId}
      ref={iframeRef}
      src={`https://www.youtube.com/embed/${videoId}?${params}`}
      title={title}
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowFullScreen
    />
  )
}

/** Home fills one viewport with no page scrolling of its own. The canvas is
 * one 2x2 grid (see home.css's own .oshi-home__canvas): Oshi Stream and Oshi
 * Videos share the left column (stacked), Oshi Status spans both rows of the
 * right column -- so Oshi Videos inherits its width from the SAME column
 * Oshi Stream sits in, instead of computing its own, and Oshi Status reaches
 * the full Home height instead of only the top row's. The Live Status drawer
 * is NOT a column here -- it stays the global LiveScheduleDock (mounted in
 * App.tsx so it works on every page) and overlays this layout, which is why
 * opening it never resizes anything below; `data-live-status-open` only
 * exposes that state to CSS. */
export function HomePage() {
  const [creatorId] = useSelectedCreator()
  const [locale] = useLocale()
  // The theme color is read from the canonical Creator Registry (generated from the backend
  // creators.json) -- there is no second, frontend-owned color map to drift from it.
  const { statuses, now } = useCreatorStatuses()
  // Only the player's auto-selected video (live now / upcoming / the latest completed archive) reads this pool. The Oshi Videos
  // shelf and Oshi Status fetch their own backend data for the current creator.
  const streamVideos = useLiveStreamVideoPool(creatorId)
  const breakpoint = useBreakpoint()
  const liveStatusOpen = useLiveDockExpanded()
  const status = statuses[creatorId] ?? { kind: "offline" as const }
  // The one shared Home selected-video path -- Oshi Videos, Recent Activity
  // AND Live Status (see useHomeSelectedVideo) all call selectHomeVideo, and
  // whichever wins overrides the auto-selected live/upcoming/latest-archive video
  // below in the SAME central slot, never a second player. Reading it
  // scoped to `creatorId` is what drops a stale previous-creator pick once
  // currentOshi has changed -- see useHomeSelectedVideo's own comment.
  const selectedVideo = useHomeSelectedVideo(creatorId)
  const embed = selectedVideo ?? selectLiveEmbedVideo(status, streamVideos.videos, now)
  // A live/upcoming stream is picked without counting as "opened": only a confirmed PLAYING while it is live may
  // suppress its later archive's NEW (see useWatchedDuringLive); a plain click must not.
  const openVideo = (video: { videoId: string; title: string }) => {
    const isCurrentStream =
      (status.kind !== "offline" && status.videoId === video.videoId) ||
      streamVideos.videos.some((entry) => entry.videoId === video.videoId && (entry.contentFormat === "live_now" || entry.contentFormat === "live_upcoming"))
    selectHomeVideo(video, creatorId, { countsAsOpened: !isCurrentStream })
  }

  // Mobile Home is restructured (spec sections 41-44): Search becomes a top-row entry point (shared
  // with the hamburger via TopbarSlotPortal) rather than the normal Video List browsing section, which
  // moves entirely to the dedicated Videos page (pages/videos/VideosPage.tsx) -- Home itself never
  // renders Search results. Desktop is completely unaffected: RecentVideosSection (with its own,
  // separately integrated desktop Search) keeps rendering exactly as before.
  const isMobile = breakpoint === "mobile"

  return (
    <div className="oshi-home" data-live-status-open={liveStatusOpen}>
      {isMobile && <MobileSearchEntry locale={locale} />}
      <main className="oshi-home__canvas" style={creatorThemeStyle(creatorId, resolveCreatorKey(creatorId)?.themeColor)}>
        <section className="oshi-stream">
          <div className="oshi-player-frame" data-live={status.kind === "live"}>
            <div className="oshi-player-frame__stage">
              <div className="oshi-player-frame__ratio">
                {embed && (
                  <LiveEmbedPlayer
                    videoId={embed.videoId}
                    title={embed.title}
                    autoplay={breakpoint !== "mobile"}
                    isLive={status.kind === "live" && status.videoId === embed.videoId}
                  />
                )}
              </div>
            </div>
          </div>
        </section>

        {!isMobile && <RecentVideosSection creatorId={creatorId} onSelectVideo={openVideo} />}

        <OshiStatusPanel
          creatorId={creatorId}
          status={status}
          now={now}
          onSelectVideo={openVideo}
          nowPlayingTitle={embed?.title ?? null}
          nowPlayingVideoId={embed?.videoId ?? null}
        />
      </main>
    </div>
  )
}
