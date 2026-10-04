import { Avatar } from "antd"
import { mockCreators } from "../../../entities/creator/data/mockCreators"
import { OshiErrorState } from "../../home-room/components/OshiErrorState"
import { getMemberAccent } from "../../../shared/theme/memberAccent"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { useTimeFormat } from "../../../shared/i18n/hooks/useTimeFormat"
import { t, type Locale } from "../../../shared/i18n/translations"
import type { TimeFormat } from "../../../shared/i18n/model/timeFormat"
import { formatAbsoluteTime, formatCountdown } from "../../live-status/model/creatorStatusFormat"
import { resolveCreatorKey } from "../../../entities/creator/data/creatorRegistry"
import { resetPreviousVisit, usePreviousVisit } from "../hooks/useLastVisit"
import { useOshiStatus } from "../hooks/useOshiStatus"
import type { OshiStatusRecentItem } from "../data/oshiStatus"
import { formatActivityTime, formatCompactCount, isUnseenActivity } from "../utils/oshiActivity"
import type { CreatorStatus } from "../../live-status/model/creatorStatus"

/** Shown for any number the backend has not provided (still loading, the request failed, or no
 * value exists for it) -- never a fabricated 0. */
const VALUE_UNAVAILABLE = "—"

interface OshiStatusPanelProps {
  creatorId: string
  status: CreatorStatus
  now: Date
  /** The one shared Home selected-video path (see HomePage.tsx) -- switches
   * the central Oshi Stream player directly, never a modal/second player. */
  onSelectVideo: (video: { videoId: string; title: string }) => void
  /** The CURRENT central Oshi Stream player's video title (HomePage.tsx's own
   * `embed?.title`), never the live/upcoming stream title (`status.title`,
   * shown separately in Live/Next below) -- those are different concepts
   * that happen to often match. Null when nothing is loaded in the player. */
  nowPlayingTitle: string | null
}

/** One Recent Activity row: [time + NEW] / [clickable title] / [thumbnail],
 * always exactly these three grid columns -- see home.css's own
 * .oshi-status__recent-row. NEW lives under the timestamp specifically so
 * it can never eat into the title's own width or shrink the thumbnail;
 * every entry here is a real backend video with a videoId, so the title is always clickable. */
function RecentActivityRow({
  entry,
  now,
  previousVisit,
  locale,
  timeFormat,
  onOpen,
}: {
  entry: OshiStatusRecentItem
  now: Date
  previousVisit: Date | null
  locale: Locale
  timeFormat: TimeFormat
  onOpen: (video: { videoId: string; title: string }) => void
}) {
  const isNew = isUnseenActivity(entry.publishedAt, previousVisit, now)

  return (
    <div className="oshi-status__recent-row">
      <div className="oshi-status__recent-time-column">
        <span className="oshi-status__recent-time">{formatActivityTime(entry.publishedAt, now, timeFormat)}</span>
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
        src={entry.thumbnailUrl ?? `https://img.youtube.com/vi/${entry.videoId}/hqdefault.jpg`}
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
  const [locale] = useLocale()
  const [timeFormat] = useTimeFormat()

  if (status.kind === "offline") {
    return <div className="oshi-empty-state">{t(locale, "oshiStatus.noScheduledStream")}</div>
  }
  return (
    <div className="oshi-status__next">
      <div className="oshi-status__next-main">
        <div className="oshi-status__next-time">
          {status.kind === "live" ? t(locale, "oshiStatus.liveNow") : formatAbsoluteTime(status.scheduledStart, timeFormat)}
        </div>
        <div className="oshi-status__next-title">{status.title}</div>
      </div>
      {status.kind === "upcoming" && (
        <div className="oshi-status__next-countdown">{formatCountdown(status.scheduledStart, now, locale)}</div>
      )}
    </div>
  )
}

/** Home's compact right-hand panel: who the current Oshi is, what they're
 * streaming, what changed since the last visit, and this week's activity.
 * Live/Next comes from the shared Holodex status; everything else (subscriber count,
 * since-last-visit and this-week counts, view growth, the recent rows) is the backend's
 * GET /creators/{creatorId}/oshi-status read model for the CURRENT creator. */
export function OshiStatusPanel({ creatorId, status, now, onSelectVideo, nowPlayingTitle }: OshiStatusPanelProps) {
  const creator = mockCreators.find((entry) => entry.channelId === creatorId)
  const accent = getMemberAccent(creatorId, creator?.themeColor)
  const previousVisit = usePreviousVisit()
  const [locale] = useLocale()
  const [timeFormat] = useTimeFormat()
  const { data, loading, error } = useOshiStatus(resolveCreatorKey(creatorId)?.creatorId, previousVisit)
  const recent = data?.recent ?? []
  const number = (value: number | undefined) => (value === undefined ? VALUE_UNAVAILABLE : String(value))

  return (
    <aside className="oshi-status">
      <div className="oshi-status__header">
        <div className="oshi-status__header-top">
          <div className="oshi-status__creator">
            <Avatar
              size={36}
              src={creator?.avatarUrl}
              alt={creator?.channelName ?? creatorId}
              className="oshi-status__creator-avatar"
              style={creator?.avatarUrl ? undefined : { background: accent.primary, color: accent.textAccent }}
            >
              {creator?.channelName.charAt(0)}
            </Avatar>
            <div className="oshi-status__creator-text">
              <div className="oshi-status__creator-name">{creator?.channelName ?? creatorId}</div>
              {/* The backend's subscriberCount; the line is omitted when it is null (never a fabricated 0). */}
              {data?.subscriberCount != null && (
                <div className="oshi-status__subscriber-count">
                  {formatCompactCount(data.subscriberCount)} {t(locale, "oshiStatus.subscribers")}
                </div>
              )}
            </div>
          </div>
          {import.meta.env.DEV && (
            <button type="button" className="oshi-status__dev-reset" onClick={resetPreviousVisit}>
              {t(locale, "oshiStatus.devResetVisit")}
            </button>
          )}
        </div>
        {nowPlayingTitle && (
          <div className="oshi-status__now-playing">
            <div className="oshi-status__now-playing-label">{t(locale, "oshiStatus.nowPlaying")}</div>
            <div className="oshi-status__now-playing-title">{nowPlayingTitle}</div>
          </div>
        )}
      </div>

      <div className="oshi-status__body">
        <section className="oshi-status__section">
          <div className="oshi-status__section-title">{t(locale, "oshiStatus.liveNext")}</div>
          <LiveOrNext status={status} now={now} />
        </section>

        <section className="oshi-status__section">
          <div className="oshi-status__section-title">{t(locale, "oshiStatus.sinceLastVisit")}</div>
          {previousVisit ? (
            <div className="oshi-status__metrics">
              <Metric value={number(data?.sinceLastVisit?.newUploads)} label={t(locale, "oshiStatus.uploads")} />
              <Metric value={number(data?.sinceLastVisit?.newStreams)} label={t(locale, "oshiStatus.streams")} />
              {/* The backend has no growth for an arbitrary since-window (only 1d/7d/30d channel totals),
               * and no raw history is exposed to derive one, so this slot stays a placeholder. */}
              <Metric value={VALUE_UNAVAILABLE} label={t(locale, "oshiStatus.viewGrowth")} />
            </div>
          ) : (
            <div className="oshi-empty-state">{t(locale, "oshiStatus.firstVisit")}</div>
          )}
        </section>

        <section className="oshi-status__section">
          <div className="oshi-status__section-title">{t(locale, "oshiStatus.thisWeek")}</div>
          <div className="oshi-status__metrics">
            <Metric
              value={data ? formatCompactCount(data.growth["7d"].absoluteGrowth) : VALUE_UNAVAILABLE}
              label={t(locale, "oshiStatus.viewGrowth")}
            />
            <Metric value={number(data?.thisWeek.newStreams)} label={t(locale, "oshiStatus.streams")} />
            <Metric value={number(data?.thisWeek.newUploads)} label={t(locale, "oshiStatus.uploads")} />
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
          ) : error ? (
            <OshiErrorState error={error} />
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
                  timeFormat={timeFormat}
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
