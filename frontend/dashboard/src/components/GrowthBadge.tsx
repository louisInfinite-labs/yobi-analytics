import { formatSignedPercent } from "../lib/format"

interface GrowthBadgeProps {
  percent: number | null
  label?: string
}

/** A positive/negative/neutral growth percentage badge. Never relies on
 * color alone — the sign and an explicit "N/A" text also communicate state
 * (dashboard_ui_direction_en.md's accessibility rule). */
export function GrowthBadge({ percent, label }: GrowthBadgeProps) {
  if (percent === null) {
    return (
      <span className="growth-badge growth-badge--neutral" aria-label={`${label ?? "Growth"}: not available`}>
        N/A
      </span>
    )
  }

  const tone = percent > 0 ? "positive" : percent < 0 ? "negative" : "neutral"
  const text = percent === 0 ? "0.0%" : formatSignedPercent(percent)

  return (
    <span
      className={`growth-badge growth-badge--${tone}`}
      aria-label={`${label ?? "Growth"}: ${text}`}
    >
      {text}
    </span>
  )
}
