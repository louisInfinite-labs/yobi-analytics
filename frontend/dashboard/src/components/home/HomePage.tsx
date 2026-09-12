import { mockCreators } from "../../data/mockCreators"
import { useCountdownLanguage } from "../../hooks/useCountdownLanguage"
import { useCreatorStatuses } from "../../hooks/useCreatorStatuses"
import { useSelectedCreator } from "../../hooks/useSelectedCreator"
import { useUpcomingDisplayMode } from "../../hooks/useUpcomingDisplayMode"
import { formatCreatorStatus } from "../../lib/creatorStatusFormat"
import { RecentVideosSection } from "./RecentVideosSection"

/** The selected creator's own name + live status, one line, bottom-right
 * corner of the (otherwise empty) frame (this session: "creator名 Live狀態
 * 在這個框的右下角 同一行顯示"). No border of its own here — it sits
 * directly inside the frame's own border. No switch button either — that
 * stays merged into the global LiveScheduleDock pill so it isn't
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

/** Home's scene area is just an empty outlined frame (this session: "我要
 * 看到有個框 中間什麼元素都不要") plus SceneStatusLine in its bottom-right
 * corner — no Room background/Oshi image/desk monitor placeholders, no
 * analytics overlay; all of that was tried and pulled back out over this
 * session. The border itself lives in styles/home.css's `.home-scene` rule.
 *
 * Below it sits RecentVideosSection (2 latest videos, then 2 livestream
 * slots — live-now + latest archive when one is live, otherwise the 2
 * latest archives), left-aligned with the frame above it. The global
 * LiveScheduleDock (switch + live-status pill, mounted once in App.tsx)
 * stays the one live-status indicator for ALL creators, visible on every
 * page including this one. */
export function HomePage() {
  const [creatorId] = useSelectedCreator()

  return (
    <div className="home-page">
      <div className="home-scene">
        <SceneStatusLine creatorId={creatorId} />
      </div>

      <div className="home-page__upper">
        <RecentVideosSection creatorId={creatorId} />
      </div>
    </div>
  )
}
