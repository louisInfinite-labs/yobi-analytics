import { Avatar } from "antd"
import { BRANCH_LABELS } from "../../entities/creator/model/domain"
import { mockCreators } from "../../entities/creator/data/mockCreators"
import { resolvePlaybackVideoId } from "../../features/home-room/data/mockRecentVideos"
import { creatorThemeStyle } from "../../shared/theme/creatorThemeStyle"
import { getMemberAccent } from "../../shared/theme/memberAccent"
import { useBreakpoint } from "../../shared/hooks/useBreakpoint"
import { useCreatorStatuses } from "../../features/live-status/hooks/useCreatorStatuses"
import { useLiveDockExpanded } from "../../features/live-status/hooks/useLiveDockExpanded"
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

/** Name, group and (when the data ever exists) tagline/tags for the current
 * Oshi -- outside the iframe, so nothing here can cover YouTube's own
 * controls. Deliberately not a profile card: 38px avatar, one 64px strip. */
function CreatorMetaStrip({ creatorId }: { creatorId: string }) {
  const creator = mockCreators.find((entry) => entry.channelId === creatorId)
  const accent = getMemberAccent(creatorId)

  return (
    <div className="oshi-meta">
      <Avatar
        size={38}
        src={creator?.avatarUrl}
        alt={creator?.channelName ?? creatorId}
        className="oshi-meta__avatar"
        style={creator?.avatarUrl ? undefined : { background: accent.primary, color: accent.textAccent }}
      >
        {creator?.channelName.charAt(0)}
      </Avatar>
      <div className="oshi-meta__identity">
        <div className="oshi-meta__name">{creator?.channelName ?? creatorId}</div>
        {creator && <div className="oshi-meta__group">{BRANCH_LABELS[creator.branch]}</div>}
      </div>
    </div>
  )
}

/** Home fills one viewport with no page scrolling of its own: Oshi Stream +
 * Oshi Status across the top, Oshi Videos as a fixed-height strip beneath.
 * The Live Status drawer is NOT a column here -- it stays the global
 * LiveScheduleDock (mounted in App.tsx so it works on every page) and
 * overlays this layout, which is why opening it never resizes anything
 * below; `data-live-status-open` only exposes that state to CSS. */
export function HomePage() {
  const [creatorId] = useSelectedCreator()
  const { statuses, now } = useCreatorStatuses()
  const { latestVideos, streamVideos } = useRecentVideos(creatorId)
  const breakpoint = useBreakpoint()
  const liveStatusOpen = useLiveDockExpanded()
  const status = statuses[creatorId] ?? { kind: "offline" as const }
  const embed = selectLiveEmbedVideo(status, streamVideos.videos, now)

  return (
    <div className="oshi-home" data-live-status-open={liveStatusOpen}>
      <main className="oshi-home__canvas" style={creatorThemeStyle(creatorId)}>
        <section className="oshi-home__top">
          <section className="oshi-stream">
            <h2 className="oshi-section-title">Oshi Stream</h2>

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

            <CreatorMetaStrip creatorId={creatorId} />
          </section>

          <OshiStatusPanel
            creatorId={creatorId}
            status={status}
            now={now}
            uploads={latestVideos.videos}
            streams={streamVideos.videos}
            loading={latestVideos.loading || streamVideos.loading}
          />
        </section>

        <RecentVideosSection creatorId={creatorId} latestVideos={latestVideos} streamVideos={streamVideos} />
      </main>
    </div>
  )
}
