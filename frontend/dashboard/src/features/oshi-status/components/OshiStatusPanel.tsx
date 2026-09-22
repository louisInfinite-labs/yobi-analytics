import { Avatar } from "antd"
import { useMemo } from "react"
import { BRANCH_LABELS } from "../../../entities/creator/model/domain"
import { mockCreators } from "../../../entities/creator/data/mockCreators"
import { getMemberAccent } from "../../../shared/theme/memberAccent"
import { useCountdownLanguage } from "../../../shared/i18n/hooks/useCountdownLanguage"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t } from "../../../shared/i18n/translations"
import { formatAbsoluteTime, formatCountdown } from "../../live-status/model/creatorStatusFormat"
import { usePreviousVisit } from "../hooks/useLastVisit"
import { formatActivityTime, measureActivity, selectRecentActivity, WEEK_MS } from "../utils/oshiActivity"
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
export function OshiStatusPanel({ creatorId, status, now, uploads, streams, loading }: OshiStatusPanelProps) {
  const creator = mockCreators.find((entry) => entry.channelId === creatorId)
  const accent = getMemberAccent(creatorId)
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
                </div>
              ))}
            </div>
          ) : recent.length === 0 ? (
            <div className="oshi-empty-state">{t(locale, "oshiStatus.noRecentActivity")}</div>
          ) : (
            <div className="oshi-status__recent-list">
              {recent.map((entry) => (
                <div key={entry.videoId} className="oshi-status__recent-row">
                  <span className="oshi-status__recent-time">{formatActivityTime(entry.publishedAt, now)}</span>
                  <span className="oshi-status__recent-text">{entry.title}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </aside>
  )
}
