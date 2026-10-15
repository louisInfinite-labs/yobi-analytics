import { useLayoutEffect, useRef } from "react"
import { resolveCreatorKey } from "../../entities/creator/data/creatorRegistry"
import { creatorThemeStyle } from "../../shared/theme/creatorThemeStyle"
import { useBreakpoint } from "../../shared/hooks/useBreakpoint"
import { useCreatorStatuses } from "../../features/live-status/hooks/useCreatorStatuses"
import { useLiveDockExpanded } from "../../features/live-status/hooks/useLiveDockExpanded"
import { selectHomeVideo, useHomeSelectedVideo } from "../../features/home-room/hooks/useHomeSelectedVideo"
import { useLiveStreamVideoPool } from "../../features/home-room/hooks/useRecentVideos"
import { useSelectedCreator } from "../../features/oshi/hooks/useSelectedCreator"
import { useWatchedDuringLive } from "../../features/media-player/hooks/useWatchedDuringLive"
import { selectLiveEmbedVideo } from "../../features/media-player/utils/liveEmbed"
import { scrollBelowTopBar } from "../../features/home-room/utils/scrollBelowTopBar"
import { useVideoSearchInput } from "../../features/video-search/hooks/useVideoSearchInput"
import { OshiStatusPanel } from "../../features/oshi-status/components/OshiStatusPanel"
import { RecentVideosSection } from "../../features/home-room/components/RecentVideosSection"

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
  // The theme color is read from the canonical Creator Registry (generated from the backend
  // creators.json) -- there is no second, frontend-owned color map to drift from it.
  const { statuses, now } = useCreatorStatuses()
  // Only the player's auto-selected video (live now / upcoming / the latest completed archive) reads this pool. The Oshi Videos
  // shelf and Oshi Status fetch their own backend data for the current creator.
  const streamVideos = useLiveStreamVideoPool(creatorId)
  const breakpoint = useBreakpoint()
  const liveStatusOpen = useLiveDockExpanded()
  const status = statuses[creatorId] ?? { kind: "offline" as const }
  const streamRef = useRef<HTMLElement>(null)
  // Phone: while a submitted search is showing, its results view REPLACES the player and Oshi Status (RecentVideosSection renders it in the
  // shelf's place). They come back, in their normal order (player, Oshi Status, shelf), the moment the search is emptied.
  const { submitted } = useVideoSearchInput()
  const mobileSearch = breakpoint === "mobile" && submitted !== ""
  const scrollToPlayerWhenBack = useRef(false)
  useLayoutEffect(() => {
    if (!mobileSearch && scrollToPlayerWhenBack.current) {
      scrollToPlayerWhenBack.current = false
      scrollBelowTopBar(streamRef.current)
    }
  }, [mobileSearch])
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
    // A deliberate pick, from the shelf or any Oshi Status title/thumbnail: take the viewer straight back to the player. Called here, in the
    // click path, and not from an effect on the selected video, so no automatic selection or refresh can ever move the page.
    // From a search result the player is not mounted yet (Home is still being restored): scroll to it once it is.
    if (mobileSearch) scrollToPlayerWhenBack.current = true
    else scrollBelowTopBar(streamRef.current)
  }

  return (
    <div className="oshi-home" data-live-status-open={liveStatusOpen}>
      <main className="oshi-home__canvas" style={creatorThemeStyle(creatorId, resolveCreatorKey(creatorId)?.themeColor)}>
        {!mobileSearch && (
          <section ref={streamRef} className="oshi-stream">
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
        )}

        <RecentVideosSection creatorId={creatorId} onSelectVideo={openVideo} />

        {!mobileSearch && (
          <OshiStatusPanel
            creatorId={creatorId}
            status={status}
            now={now}
            onSelectVideo={openVideo}
            nowPlayingTitle={embed?.title ?? null}
            nowPlayingVideoId={embed?.videoId ?? null}
          />
        )}
      </main>
    </div>
  )
}
