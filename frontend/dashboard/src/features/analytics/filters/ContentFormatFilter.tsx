import { CONTENT_FORMAT_LABELS, type ContentFormat } from "../../../entities/creator/model/domain"
import { NullableSegmented } from "../../../shared/ui/NullableSegmented"

const OPTIONS = Object.keys(CONTENT_FORMAT_LABELS) as ContentFormat[]

interface ContentFormatFilterProps {
  value: ContentFormat | null
  onChange: (value: ContentFormat | null) => void
}

/** `Ranking` is an analytics result/view, not a video content tag or format
 * — deliberately not an option here (dashboard_ui_direction_en.md section 5). */
export function ContentFormatFilter({ value, onChange }: ContentFormatFilterProps) {
  return (
    <NullableSegmented
      label="Format"
      value={value}
      onChange={onChange}
      options={OPTIONS.map((format) => ({ label: CONTENT_FORMAT_LABELS[format], value: format }))}
    />
  )
}
