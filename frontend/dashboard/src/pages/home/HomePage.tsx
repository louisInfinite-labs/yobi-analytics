import { Avatar } from "antd"
import { useState } from "react"
import { mockCreators } from "../../entities/creator/data/mockCreators"
import { resolvePlaybackVideoId } from "../../features/home-room/data/mockRecentVideos"
import { formatCompactCount } from "../../features/oshi-status/utils/oshiActivity"
import { creatorThemeStyle } from "../../shared/theme/creatorThemeStyle"
import { getMemberAccent } from "../../shared/theme/memberAccent"
import { useBreakpoint } from "../../shared/hooks/useBreakpoint"
import { useCreatorStatuses } from "../../features/live-status/hooks/useCreatorStatuses"
import { useLiveDockExpanded } from "../../features/live-status/hooks/useLiveDockExpanded"
import { useLocale } from "../../shared/i18n/hooks/useLocale"
import { useRecentVideos } from "../../features/home-room/hooks/useRecentVideos"
import { useSelectedCreator } from "../../features/oshi/hooks/useSelectedCreator"
import { selectLiveEmbedVideo } from "../../features/media-player/utils/liveEmbed"
import { t } from "../../shared/i18n/translations"
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

/** YouTube-style information hierarchy for the currently playing video --
 * title, then channel identity (avatar/full name/subscriber count) -- placed
 * outside the iframe so nothing here can cover YouTube's own controls.
 * `videoTitle` is the CURRENT central player's video, never creator/static
 * text, so it updates the instant the selected video changes; the channel
 * identity below it always stays the current Oshi regardless of which of
 * their videos is playing. Deliberately not a profile card: one compact
 * strip, no Like/Share/Subscribe controls. */
function PlayerMetaStrip({ creatorId, videoTitle }: { creatorId: string; videoTitle: string | null }) {
  const creator = mockCreators.find((entry) => entry.channelId === creatorId)
  const accent = getMemberAccent(creatorId, creator?.themeColor)
  const [locale] = useLocale()

  return (
    <div className="oshi-meta">
      {videoTitle && <p className="oshi-meta__title">{videoTitle}</p>}
      <div className="oshi-meta__channel">
        <Avatar
          size={38}
          src={creator?.avatarUrl}
          alt={creator?.channelName ?? creatorId}
          className="oshi-meta__avatar"
          style={creator?.avatarUrl ? undefined : { background: accent.primary, color: accent.textAccent }}
        >
          {creator?.channelName.charAt(0)}
        </Avatar>
        <div className="oshi-meta__channel-text">
          <div className="oshi-meta__channel-name">{creator?.channelName ?? creatorId}</div>
          {/* No backend/mock field carries a real subscriber count for most
           * creators yet -- only the primary dev/test creator has one, so
           * the line is simply omitted rather than showing a fabricated
           * number for everyone else. See this task's final report. */}
          {creator?.subscriberCount != null && (
            <div className="oshi-meta__subscriber-count">
              {formatCompactCount(creator.subscriberCount)} {t(locale, "oshiStatus.subscribers")}
            </div>
          )}
        </div>
      </div>
    </div>
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
  const { statuses, now } = useCreatorStatuses()
  const { latestVideos, streamVideos } = useRecentVideos(creatorId)
  const breakpoint = useBreakpoint()
  const liveStatusOpen = useLiveDockExpanded()
  const status = statuses[creatorId] ?? { kind: "offline" as const }
  // The one shared Home selected-video path -- Oshi Videos and Recent
  // Activity both call setSelectedVideo, and whichever wins overrides the
  // auto-selected live/recent-archive video below in the SAME central slot,
  // never a second player. Cleared on creator switch (adjusted during
  // render, not an Effect -- see React's own "Adjusting state when a prop
  // changes" guidance) so a previous creator's pick can't carry over onto
  // the new one's auto-selected video.
  const [selectedVideo, setSelectedVideo] = useState<{ videoId: string; title: string } | null>(null)
  const [selectedVideoCreatorId, setSelectedVideoCreatorId] = useState(creatorId)
  if (creatorId !== selectedVideoCreatorId) {
    setSelectedVideoCreatorId(creatorId)
    setSelectedVideo(null)
  }
  const embed = selectedVideo ?? selectLiveEmbedVideo(status, streamVideos.videos, now)

  return (
    <div className="oshi-home" data-live-status-open={liveStatusOpen}>
      <main className="oshi-home__canvas" style={creatorThemeStyle(creatorId)}>
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

          <PlayerMetaStrip creatorId={creatorId} videoTitle={embed?.title ?? null} />
        </section>

        <RecentVideosSection
          creatorId={creatorId}
          latestVideos={latestVideos}
          streamVideos={streamVideos}
          onSelectVideo={setSelectedVideo}
        />

        <OshiStatusPanel
          creatorId={creatorId}
          status={status}
          now={now}
          uploads={latestVideos.videos}
          streams={streamVideos.videos}
          loading={latestVideos.loading || streamVideos.loading}
          onSelectVideo={setSelectedVideo}
        />
      </main>
    </div>
  )
}
