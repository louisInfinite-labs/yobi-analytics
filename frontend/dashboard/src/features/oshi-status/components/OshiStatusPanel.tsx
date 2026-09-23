import { Avatar } from "antd"
import { useMemo } from "react"
import { BRANCH_LABELS } from "../../../entities/creator/model/domain"
import { mockCreators } from "../../../entities/creator/data/mockCreators"
import { resolvePlaybackVideoId } from "../../home-room/data/mockRecentVideos"
import { getMemberAccent } from "../../../shared/theme/memberAccent"
import { useCountdownLanguage } from "../../../shared/i18n/hooks/useCountdownLanguage"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t, type Locale } from "../../../shared/i18n/translations"
import { formatAbsoluteTime, formatCountdown } from "../../live-status/model/creatorStatusFormat"
import { resetPreviousVisit, usePreviousVisit } from "../hooks/useLastVisit"
import {
  formatActivityTime,
  isUnseenActivity,
  measureActivity,
  selectRecentActivity,
  WEEK_MS,
  type ActivityEntry,
} from "../utils/oshiActivity"
import type { CreatorStatus } from "../../live-status/model/creatorStatus"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"

const RECENT_ROW_LIMIT = 6

/** View growth needs a per-channel view time series, which no data source in
 * this app provides yet. The slot stays so the metric is visibly pending
 * rather than silently redefined — see measureActivity's own note. */
const VIEW_GROWTH_UNAVAILABLE = "—"

interface OshiStatusPanelProps {
  creatorId: string
  status: CreatorStatus
  now: Date
  uploads: RecentVideo[]
  streams: RecentVideo[]
  loading: boolean
  /** The one shared Home selected-video path (see HomePage.tsx) -- switches
   * the central Oshi Stream player directly, never a modal/second player. */
  onSelectVideo: (video: { videoId: string; title: string }) => void
}

/** One Recent Activity row: [time + NEW] / [clickable title] / [thumbnail],
 * always exactly these three grid columns -- see home.css's own
 * .oshi-status__recent-row. NEW lives under the timestamp specifically so
 * it can never eat into the title's own width or shrink the thumbnail;
 * every entry here already has a real videoId (selectRecentActivity only
 * ever draws from the video pools), so the title is always clickable. */
function RecentActivityRow({
  entry,
  now,
  previousVisit,
  locale,
  onOpen,
}: {
  entry: ActivityEntry
  now: Date
  previousVisit: Date | null
  locale: Locale
  onOpen: (video: { videoId: string; title: string }) => void
}) {
  const isNew = isUnseenActivity(entry.publishedAt, previousVisit, now)

  return (
    <div className="oshi-status__recent-row">
      <div className="oshi-status__recent-time-column">
        <span className="oshi-status__recent-time">{formatActivityTime(entry.publishedAt, now)}</span>
        {isNew && <span className="oshi-status__recent-new-badge">{t(locale, "oshiStatus.newBadge")}</span>}
      </div>
      <div className="oshi-status__recent-content">
        <button
          type="button"
          className="oshi-status__recent-video-link"
          onClick={() => onOpen({ videoId: entry.videoId, title: entry.title })}
        >
          {entry.title}
        </button>
      </div>
      <img
        className="oshi-status__recent-thumbnail"
        src={`https://img.youtube.com/vi/${resolvePlaybackVideoId(entry.videoId)}/hqdefault.jpg`}
        alt=""
        draggable={false}
      />
    </div>
  )
}

/** One value/label pair in the compact 3-column metric rows -- `value` is a
 * pre-formatted string (already localized/compacted by the caller) since
 * this component has no numeric or locale knowledge of its own. */
function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="oshi-status__metric">
      <div className="oshi-status__metric-value">{value}</div>
      <div className="oshi-status__metric-label">{label}</div>
    </div>
  )
}

/** LIVE now, else the nearest upcoming stream, else nothing scheduled.
 * Shows the scheduled clock time and the countdown side by side rather than
 * picking one — both slots exist, and neither is derived data. */
function LiveOrNext({ status, now }: { status: CreatorStatus; now: Date }) {
  const [language] = useCountdownLanguage()
  const [locale] = useLocale()

  if (status.kind === "offline") {
    return <div className="oshi-empty-state">{t(locale, "oshiStatus.noScheduledStream")}</div>
  }
  return (
    <div className="oshi-status__next">
      <div className="oshi-status__next-main">
        <div className="oshi-status__next-time">
          {status.kind === "live" ? t(locale, "oshiStatus.liveNow") : formatAbsoluteTime(status.scheduledStart)}
        </div>
        <div className="oshi-status__next-title">{status.title}</div>
      </div>
      {status.kind === "upcoming" && (
        <div className="oshi-status__next-countdown">{formatCountdown(status.scheduledStart, now, language)}</div>
      )}
    </div>
  )
}

/** Home's compact right-hand panel: who the current Oshi is, what they're
 * streaming, what changed since the last visit, and this week's activity.
 * Every number is derived from the video pools Home already loaded and the
 * shared Holodex status — nothing here fetches on its own. */
export function OshiStatusPanel({ creatorId, status, now, uploads, streams, loading, onSelectVideo }: OshiStatusPanelProps) {
  const creator = mockCreators.find((entry) => entry.channelId === creatorId)
  const accent = getMemberAccent(creatorId, creator?.themeColor)
  const previousVisit = usePreviousVisit()
  const [locale] = useLocale()

  const sinceLastVisit = useMemo(
    () => (previousVisit ? measureActivity(uploads, streams, previousVisit, now) : null),
    [previousVisit, uploads, streams, now],
  )
  const thisWeek = useMemo(
    () => measureActivity(uploads, streams, new Date(now.getTime() - WEEK_MS), now),
    [uploads, streams, now],
  )
  const recent = useMemo(() => selectRecentActivity(uploads, streams, RECENT_ROW_LIMIT), [uploads, streams])

  return (
    <aside className="oshi-status">
      <div className="oshi-status__header">
        <div className="oshi-status__creator">
          <Avatar
            size={32}
            src={creator?.avatarUrl}
            alt={creator?.channelName ?? creatorId}
            className="oshi-status__creator-avatar"
            style={creator?.avatarUrl ? undefined : { background: accent.primary, color: accent.textAccent }}
          >
            {creator?.channelName.charAt(0)}
          </Avatar>
          <div className="oshi-status__creator-text">
            <div className="oshi-status__creator-name">{creator?.channelName ?? creatorId}</div>
            {creator && <div className="oshi-status__creator-group">{BRANCH_LABELS[creator.branch]}</div>}
          </div>
        </div>
        {import.meta.env.DEV && (
          <button type="button" className="oshi-status__dev-reset" onClick={resetPreviousVisit}>
            {t(locale, "oshiStatus.devResetVisit")}
          </button>
        )}
      </div>

      <div className="oshi-status__body">
        <section className="oshi-status__section">
          <div className="oshi-status__section-title">{t(locale, "oshiStatus.liveNext")}</div>
          <LiveOrNext status={status} now={now} />
        </section>

        <section className="oshi-status__section">
          <div className="oshi-status__section-title">{t(locale, "oshiStatus.sinceLastVisit")}</div>
          {sinceLastVisit ? (
            <div className="oshi-status__metrics">
              <Metric value={String(sinceLastVisit.uploads)} label={t(locale, "oshiStatus.uploads")} />
              <Metric value={String(sinceLastVisit.streams)} label={t(locale, "oshiStatus.streams")} />
              <Metric value={VIEW_GROWTH_UNAVAILABLE} label={t(locale, "oshiStatus.viewGrowth")} />
            </div>
          ) : (
            <div className="oshi-empty-state">{t(locale, "oshiStatus.firstVisit")}</div>
          )}
        </section>

        <section className="oshi-status__section">
          <div className="oshi-status__section-title">{t(locale, "oshiStatus.thisWeek")}</div>
          <div className="oshi-status__metrics">
            <Metric value={VIEW_GROWTH_UNAVAILABLE} label={t(locale, "oshiStatus.viewGrowth")} />
            <Metric value={String(thisWeek.streams)} label={t(locale, "oshiStatus.streams")} />
            <Metric value={String(thisWeek.uploads)} label={t(locale, "oshiStatus.uploads")} />
          </div>
        </section>

        <section className="oshi-status__section oshi-status__section--recent">
          <div className="oshi-status__section-title">{t(locale, "oshiStatus.recent")}</div>
          {loading ? (
            <div className="oshi-status__recent-list">
              {[0, 1, 2, 3].map((row) => (
                <div key={row} className="oshi-status__recent-row">
                  <span className="oshi-loading-line" style={{ height: 9, width: 34 }} />
                  <span className="oshi-loading-line" style={{ height: 9 }} />
                  <span className="oshi-loading-line" style={{ height: 27, width: 48 }} />
                </div>
              ))}
            </div>
          ) : recent.length === 0 ? (
            <div className="oshi-empty-state">{t(locale, "oshiStatus.noRecentActivity")}</div>
          ) : (
            <div className="oshi-status__recent-list">
              {recent.map((entry) => (
                <RecentActivityRow
                  key={entry.videoId}
                  entry={entry}
                  now={now}
                  previousVisit={previousVisit}
                  locale={locale}
                  onOpen={onSelectVideo}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </aside>
  )
}
