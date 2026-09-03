import { CONTENT_FORMAT_LABELS, type ContentFormat } from "../../types/domain"

const OPTIONS = Object.keys(CONTENT_FORMAT_LABELS) as ContentFormat[]

interface ContentFormatFilterProps {
  value: ContentFormat | null
  onChange: (value: ContentFormat | null) => void
}

/** `Ranking` is an analytics result/view, not a video content tag or format
 * — deliberately not an option here (dashboard_ui_direction_en.md section 5). */
export function ContentFormatFilter({ value, onChange }: ContentFormatFilterProps) {
  return (
    <div className="filter-row">
      <span className="filter-row__label">Format</span>
      <div className="filter-chip-group">
        <button type="button" className="filter-chip" aria-pressed={value === null} onClick={() => onChange(null)}>
          All
        </button>
        {OPTIONS.map((format) => (
          <button key={format} type="button" className="filter-chip" aria-pressed={value === format} onClick={() => onChange(format)}>
            {CONTENT_FORMAT_LABELS[format]}
          </button>
        ))}
      </div>
    </div>
  )
}
