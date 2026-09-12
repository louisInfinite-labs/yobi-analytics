import { mockCreators } from "../../data/mockCreators"
import { resolvePlaybackVideoId } from "../../data/mockRecentVideos"
import { useBreakpoint } from "../../hooks/useBreakpoint"
import { useCountdownLanguage } from "../../hooks/useCountdownLanguage"
import { useCreatorStatuses } from "../../hooks/useCreatorStatuses"
import { useLiveDockExpanded } from "../../hooks/useLiveDockExpanded"
import { useRecentVideos } from "../../hooks/useRecentVideos"
import { useSelectedCreator } from "../../hooks/useSelectedCreator"
import { useUpcomingDisplayMode } from "../../hooks/useUpcomingDisplayMode"
import { formatCreatorStatus } from "../../lib/creatorStatusFormat"
import { selectLiveEmbedVideo } from "../../lib/liveEmbed"
import { RecentVideosSection } from "./RecentVideosSection"

/** The selected creator's own name + live status, one line, bottom-right
 * corner of the (otherwise empty) frame. No border of its own here — it
 * sits directly inside the frame's own border. No switch button either —
 * that stays merged into the global LiveScheduleDock pill so it isn't
 * duplicated here. */
function SceneStatusLine({ creatorId }: { creatorId: string }) {
  const [displayMode] = useUpcomingDisplayMode()
  const [language] = useCountdownLanguage()
  const { statuses, now } = useCreatorStatuses()
  const creatorName = mockCreators.find((c) => c.channelId === creatorId)?.channelName ?? creatorId
  const status = statuses[creatorId]
  const display = status ? formatCreatorStatus(status, displayMode, now, language) : null

  return (
    <div className="home-scene__layer home-scene__status-line">
      <span className="home-scene__status-line__name">{creatorName}</span>
      {display && (
        <span className="home-scene__status-line__status">
          <span className={`creator-status-list__dot creator-status-list__dot--${display.dotColor}`} aria-hidden="true" />
          {display.label}
        </span>
      )}
    </div>
  )
}

/** The real, playable YouTube embed for the selected creator's live scene
 * -- only rendered when selectLiveEmbedVideo finds something eligible
 * (currently live, or an archive that ended within the last 24h).
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
      className="home-scene__layer home-scene__player"
      src={`https://www.youtube.com/embed/${videoId}?${params}`}
      title={title}
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowFullScreen
    />
  )
}

/** Home's scene area: the selected creator's live YouTube embed when one is
 * eligible (see LiveEmbedPlayer), plus SceneStatusLine layered on top in
 * its bottom-right corner either way. When no video is eligible, this is
 * still just the empty outlined frame from before -- that no-eligible-
 * video fallback is an open decision, not resolved by this change. The
 * border itself lives in styles/home.css's `.home-scene` rule.
 *
 * Below it sits RecentVideosSection (2 latest videos, then 2 livestream
 * slots — live-now + latest archive when one is live, otherwise the 2
 * latest archives), left-aligned with the frame above it. The global
 * LiveScheduleDock (switch + live-status pill, mounted once in App.tsx)
 * stays the one live-status indicator for ALL creators, visible on every
 * page including this one. */
export function HomePage() {
  const [creatorId] = useSelectedCreator()
  const { statuses, now } = useCreatorStatuses()
  const { streamVideos } = useRecentVideos(creatorId)
  const breakpoint = useBreakpoint()
  const dockExpanded = useLiveDockExpanded()
  const embed = selectLiveEmbedVideo(statuses[creatorId], streamVideos.videos, now)

  return (
    <div className="home-page">
      <div className={`home-scene${dockExpanded ? " home-scene--dock-open" : ""}`}>
        {embed && <LiveEmbedPlayer videoId={resolvePlaybackVideoId(embed.videoId)} title={embed.title} autoplay={breakpoint !== "mobile"} />}
        <SceneStatusLine creatorId={creatorId} />
      </div>

      <div className="home-page__upper">
        <RecentVideosSection creatorId={creatorId} />
      </div>
    </div>
  )
}
