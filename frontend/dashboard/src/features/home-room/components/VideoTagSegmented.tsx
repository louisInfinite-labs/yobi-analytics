import { ConfigProvider, Segmented } from "antd"
import type { ReactNode } from "react"
import type { VideoSectionSelection } from "../model/specialVideoFilters"

/** The ONE rendering of the Video Topic/Tag Segmented control, shared by desktop's Oshi Videos header
 * (RecentVideosSection) and the mobile Filter sheet's "Video Topic" section (features/video-search) --
 * extracted from RecentVideosSection so both consumers render the exact same component (not just the
 * same underlying data from videoFilterCatalog.ts), which is what actually rules out a second,
 * manually-maintained visual copy of the tag list ever drifting from the first.
 *
 * Deliberately NOT the shared .shared-filter-segmented skin used elsewhere (Notification Settings/
 * Favorites/Live Status): this bar's colors/radius come from the ConfigProvider component tokens
 * below -- fixed, never creator-tinted (the selected tag's own color must not shift when currentOshi
 * changes). trackBg matches .oshi-videos's own panel background (--oshi-surface-1).
 */
export function VideoTagSegmented({
  selected,
  onSelect,
  options,
  leading,
  trailing,
}: {
  selected: VideoSectionSelection
  onSelect: (selection: VideoSectionSelection) => void
  options: { value: VideoSectionSelection; label: string }[]
  /** Renders before the tag strip, inside the same flex row (e.g. desktop's Search trigger button --
   * see features/home-room/components/RecentVideosSection.tsx) -- a sibling of .oshi-videos__tags, not
   * a wrapper around it, so it never affects the tag strip's own horizontal scroll. */
  leading?: ReactNode
  trailing?: ReactNode
}) {
  return (
    <div className="oshi-videos__filters">
      {leading}
      {/* The tag strip is its OWN scroll container, apart from the controls: a strip that cannot fit scrolls sideways inside this box
          instead of painting over the dropdowns that follow it (and, on a phone, the controls take their own row below it). */}
      <div className="oshi-videos__tags">
        <ConfigProvider
          theme={{
            components: {
              Segmented: {
                trackBg: "var(--oshi-surface-1)",
                trackPadding: 2,
                itemColor: "var(--oshi-text-3)",
                itemHoverColor: "var(--oshi-text-1)",
                itemHoverBg: "rgba(255, 255, 255, 0.05)",
                // Fixed neutral, never creator-tinted (confirmed with the
                // user: the selected tag's own color must not shift with
                // currentOshi) -- --oshi-surface-3, no --creator-main mix.
                itemSelectedBg: "var(--oshi-surface-3)",
                itemSelectedColor: "var(--oshi-text-1)",
                borderRadius: 4,
                borderRadiusSM: 4,
              },
            },
          }}
        >
          <Segmented<VideoSectionSelection>
            size="small"
            classNames={{
              root: "oshi-videos__segmented",
              item: "oshi-videos__segment-item",
              label: "oshi-videos__segment-label",
            }}
            value={selected}
            onChange={onSelect}
            options={options}
          />
        </ConfigProvider>
      </div>
      <div className="oshi-videos__controls">{trailing}</div>
    </div>
  )
}
