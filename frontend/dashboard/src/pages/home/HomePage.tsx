import { mockCreators } from "../../entities/creator/data/mockCreators"
import { resolvePlaybackVideoId } from "../../features/home-room/data/mockRecentVideos"
import { creatorThemeStyle } from "../../shared/theme/creatorThemeStyle"
import { useBreakpoint } from "../../shared/hooks/useBreakpoint"
import { useCreatorStatuses } from "../../features/live-status/hooks/useCreatorStatuses"
import { useLiveDockExpanded } from "../../features/live-status/hooks/useLiveDockExpanded"
import { selectHomeVideo, useHomeSelectedVideo } from "../../features/home-room/hooks/useHomeSelectedVideo"
import { useRecentVideos } from "../../features/home-room/hooks/useRecentVideos"
import { useSelectedCreator } from "../../features/oshi/hooks/useSelectedCreator"
import { selectLiveEmbedVideo } from "../../features/media-player/utils/liveEmbed"
import { OshiStatusPanel } from "../../features/oshi-status/components/OshiStatusPanel"
import { RecentVideosSection } from "../../features/home-room/components/RecentVideosSection"

/** The real, playable YouTube embed for the selected creator -- only
 * rendered when selectLiveEmbedVideo finds something eligible (currently
 * live, or an archive that ended within the last 24h).
 *
 * Desktop autoplays muted: every major browser blocks unmuted autoplay
 * without a user gesture, and this renders on page load / creator switch,
 * not a click, so muted is what actually makes autoplay work at all rather
 * than silently fail. Mobile never requests autoplay -- YouTube's own
 * embed already shows a thumbnail + play button when it isn't autoplaying,
 * so no separate placeholder UI is needed here. */
function LiveEmbedPlayer({ videoId, title, autoplay }: { videoId: string; title: string; autoplay: boolean }) {
  const params = autoplay ? "autoplay=1&mute=1" : "autoplay=0"
  return (
    <iframe
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
  // The one lookup into Home's current mock creator source needed to bind
  // the global theme below -- creatorThemeStyle itself takes the resolved
  // themeColor rather than performing this same lookup a second time
  // internally (see that helper's own docstring).
  const currentCreator = mockCreators.find((entry) => entry.channelId === creatorId)
  const { statuses, now } = useCreatorStatuses()
  const { latestVideos, streamVideos } = useRecentVideos(creatorId)
  const breakpoint = useBreakpoint()
  const liveStatusOpen = useLiveDockExpanded()
  const status = statuses[creatorId] ?? { kind: "offline" as const }
  // The one shared Home selected-video path -- Oshi Videos, Recent Activity
  // AND Live Status (see useHomeSelectedVideo) all call selectHomeVideo, and
  // whichever wins overrides the auto-selected live/recent-archive video
  // below in the SAME central slot, never a second player. Reading it
  // scoped to `creatorId` is what drops a stale previous-creator pick once
  // currentOshi has changed -- see useHomeSelectedVideo's own comment.
  const selectedVideo = useHomeSelectedVideo(creatorId)
  const embed = selectedVideo ?? selectLiveEmbedVideo(status, streamVideos.videos, now)

  return (
    <div className="oshi-home" data-live-status-open={liveStatusOpen}>
      <main className="oshi-home__canvas" style={creatorThemeStyle(creatorId, currentCreator?.themeColor)}>
        <section className="oshi-stream">
          <div className="oshi-player-frame" data-live={status.kind === "live"}>
            <div className="oshi-player-frame__stage">
              <div className="oshi-player-frame__ratio">
                {embed && (
                  <LiveEmbedPlayer
                    videoId={resolvePlaybackVideoId(embed.videoId)}
                    title={embed.title}
                    autoplay={breakpoint !== "mobile"}
                  />
                )}
              </div>
            </div>
          </div>
        </section>

        <RecentVideosSection
          creatorId={creatorId}
          latestVideos={latestVideos}
          streamVideos={streamVideos}
          onSelectVideo={(video) => selectHomeVideo(video, creatorId)}
        />

        <OshiStatusPanel
          creatorId={creatorId}
          status={status}
          now={now}
          uploads={latestVideos.videos}
          streams={streamVideos.videos}
          loading={latestVideos.loading || streamVideos.loading}
          onSelectVideo={(video) => selectHomeVideo(video, creatorId)}
          nowPlayingTitle={embed?.title ?? null}
        />
      </main>
    </div>
  )
}
