import { useEffect, useState } from "react"
import { Drawer } from "antd"
import { ContentTypeDropdown, VideoSortDropdown, ViewWindowDropdown } from "../../home-room/components/VideoShelfControls"
import { VideoTagSegmented } from "../../home-room/components/VideoTagSegmented"
import { isQuickFilterSelection, type VideoContentType, type VideoViewWindow } from "../../home-room/model/oshiVideosQuery"
import type { VideoSectionSelection } from "../../home-room/model/specialVideoFilters"
import type { VideoTagOption } from "../../home-room/hooks/useVideoTagOptions"
import type { VideoSortOption } from "../../home-room/utils/recentVideosSelection"
import { t, type Locale } from "../../../shared/i18n/translations"

export interface VideoFilterState {
  tag: VideoSectionSelection
  contentType: VideoContentType
  sort: VideoSortOption
  viewWindow: VideoViewWindow
}

const DEFAULT_FILTER_STATE: VideoFilterState = { tag: "all", contentType: "all", sort: "newest", viewWindow: "total" }

interface VideoFilterSheetProps {
  locale: Locale
  open: boolean
  onClose: () => void
  tagOptions: VideoTagOption[]
  applied: VideoFilterState
  onApply: (next: VideoFilterState) => void
}

/** Mobile Videos' Filter sheet: the ACTUAL current Video Topic options (useVideoTagOptions -- the same
 * authoritative source and the same VideoTagSegmented component desktop's Oshi Videos header renders,
 * never a second manually maintained list) plus the ACTUAL existing Filter/Sort controls
 * (VideoShelfControls -- again the same components, not a reimplementation), inside an antd Drawer
 * restyled the same way ScheduleCreatorFilter's own creator-filter drawer already is (features/live-
 * schedule/components/ScheduleCreatorFilter.tsx + schedule.css's .schedule-creator-drawer rules) -- the
 * one existing "Filter sheet with pending state" precedent in this codebase to model this on.
 *
 * Pending-until-Apply: every control here edits LOCAL state, seeded from `applied` each time the sheet
 * opens. Only Apply calls `onApply` (and closes); Cancel/backdrop/Escape (antd Drawer's own built-in
 * behavior) discards the pending edits because they were never lifted to the parent at all. */
export function VideoFilterSheet({ locale, open, onClose, tagOptions, applied, onApply }: VideoFilterSheetProps) {
  const [pending, setPending] = useState<VideoFilterState>(applied)

  useEffect(() => {
    if (open) setPending(applied)
  }, [open, applied])

  const showShelfFilters = !isQuickFilterSelection(pending.tag)
  const showViewWindow = showShelfFilters && pending.sort === "mostViews"

  return (
    <Drawer
      open={open}
      onClose={onClose}
      placement="right"
      size={360}
      title={t(locale, "videoSearch.filter.title")}
      rootClassName="video-filter-drawer"
      destroyOnHidden
    >
      <div className="video-filter-drawer__section">
        <h3 className="video-filter-drawer__heading">{t(locale, "videoSearch.filter.topicSection")}</h3>
        <VideoTagSegmented selected={pending.tag} onSelect={(tag) => setPending((prev) => ({ ...prev, tag }))} options={tagOptions} />
      </div>

      <div className="video-filter-drawer__section">
        <h3 className="video-filter-drawer__heading">{t(locale, "videoSearch.filter.sortSection")}</h3>
        <div className="video-filter-drawer__controls">
          <ContentTypeDropdown
            value={pending.contentType}
            onChange={(contentType) => setPending((prev) => ({ ...prev, contentType }))}
            locale={locale}
            hidden={!showShelfFilters}
          />
          <VideoSortDropdown value={pending.sort} onChange={(sort) => setPending((prev) => ({ ...prev, sort }))} locale={locale} hidden={!showShelfFilters} />
          {showViewWindow && (
            <ViewWindowDropdown value={pending.viewWindow} onChange={(viewWindow) => setPending((prev) => ({ ...prev, viewWindow }))} locale={locale} />
          )}
        </div>
      </div>

      <div className="video-filter-drawer__actions">
        <button type="button" className="video-filter-drawer__action" onClick={() => setPending(DEFAULT_FILTER_STATE)}>
          {t(locale, "videoSearch.filter.reset")}
        </button>
        <button type="button" className="video-filter-drawer__action" onClick={onClose}>
          {t(locale, "videoSearch.filter.cancel")}
        </button>
        <button
          type="button"
          className="video-filter-drawer__action video-filter-drawer__action--primary"
          onClick={() => {
            onApply(pending)
            onClose()
          }}
        >
          {t(locale, "videoSearch.filter.apply")}
        </button>
      </div>
    </Drawer>
  )
}
