import { useEffect, useRef } from "react"
import { OshiErrorState } from "../../home-room/components/OshiErrorState"
import type { HomeAllFeed } from "../../home-room/hooks/useHomeAllFeed"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { useTimeFormat } from "../../../shared/i18n/hooks/useTimeFormat"
import { t } from "../../../shared/i18n/translations"
import { useLatestActivityRows } from "../hooks/useLatestActivityRows"
import { RecentActivityRow } from "./RecentActivityRow"

interface LatestActivityViewProps {
  creatorId: string
  /** Home's ONE shared ALL feed (see useHomeAllFeed): this view lists exactly what Video List ALL lists, in the same order, from the
   * pages already loaded, and pages further through the same loader as it scrolls -- it owns no data and makes no request of its own. */
  feed: HomeAllFeed
  now: Date
  /** Opening a row: the one shared Home selection path (HomePage's openVideo). The row itself marks a NEW archive/upload seen. */
  onOpen: (video: { videoId: string; title: string }) => void
  onClose: () => void
}

/** The dedicated full-screen Latest Activity (最新動態) view opened by 查看全部 on mobile/tablet Home: an independent screen, never a scroll
 * to the Video List. Every row is the Latest Activity row, so each one decides NEW for itself from the shared tracking (its own discovery
 * time against the browser's first-visit instant, and the shared seen set) -- including rows that only load after scrolling. Rows load 20 at
 * a time: the next page is requested when the row near index 13 comes into view. Loading or scrolling past a row never marks it seen;
 * only opening it does. */
export function LatestActivityView({ creatorId, feed, now, onOpen, onClose }: LatestActivityViewProps) {
  const [locale] = useLocale()
  const [timeFormat] = useTimeFormat()
  const { rows, listRef } = useLatestActivityRows(creatorId, feed, "full")
  const closeRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  return (
    <div className="oshi-activity-view" role="dialog" aria-modal="true" aria-label={t(locale, "oshiStatus.recent")}>
      <header className="oshi-activity-view__header">
        <button ref={closeRef} type="button" className="oshi-activity-view__close" aria-label={t(locale, "oshiStatus.closeActivity")} onClick={onClose}>
          <span aria-hidden="true">←</span>
        </button>
        <h2 className="oshi-activity-view__title">{t(locale, "oshiStatus.recent")}</h2>
      </header>
      <div className="oshi-activity-view__scroll">
        {feed.loading ? (
          <div className="oshi-status__recent-list">
            {[0, 1, 2, 3].map((row) => (
              <div key={row} className="oshi-status__recent-row">
                <span className="oshi-loading-line" style={{ height: 9, width: 34 }} />
                <span className="oshi-loading-line" style={{ height: 9 }} />
                <span className="oshi-loading-line oshi-status__thumb-skeleton" />
              </div>
            ))}
          </div>
        ) : feed.error ? (
          <OshiErrorState error={feed.error} />
        ) : rows.length === 0 ? (
          <div className="oshi-empty-state">{t(locale, "oshiStatus.noRecentActivity")}</div>
        ) : (
          <div className="oshi-status__recent-list" ref={listRef}>
            {rows.map((entry) => (
              <RecentActivityRow key={entry.videoId} entry={entry} now={now} locale={locale} timeFormat={timeFormat} onOpen={onOpen} newBadgeAllowed={feed.liveStatusSettled !== false} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
