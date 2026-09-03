import { RadialBar, RadialBarChart, ResponsiveContainer } from "recharts"
import { useCountUp } from "../hooks/useCountUp"
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion"
import type { ChannelContribution } from "../lib/deriveAnalytics"
import type { Period } from "../types/domain"
import { useMemberTheme } from "../theme/ThemeContext"

const PERIOD_LABEL: Record<Period, string> = {
  "1d": "today's growth",
  "7d": "this period's growth",
  "30d": "this period's growth",
}

interface AnimatedRingChartProps {
  contributions: ChannelContribution[]
  period: Period
}

/** Top channel's contribution share as a progress ring, with the rest of
 * the top contributors listed as a legend below — never relies on the ring
 * alone (dashboard_ui_direction_en.md's chart accessibility rule). */
export function AnimatedRingChart({ contributions, period }: AnimatedRingChartProps) {
  const reducedMotion = usePrefersReducedMotion()
  const { theme } = useMemberTheme()
  const top = contributions[0]
  const targetPercent = top ? top.percent : 0
  const animatedPercent = useCountUp(targetPercent, 800, reducedMotion)

  if (!top) {
    return (
      <div className="card ring-chart">
        <h2 className="section-header">Contribution</h2>
        <p style={{ color: "var(--text-tertiary)", fontSize: 13 }}>No positive growth to show.</p>
      </div>
    )
  }

  const chartData = [{ name: top.channelName, value: animatedPercent, fill: theme.ring }]

  return (
    <div className="card ring-chart">
      <h2 className="section-header">Contribution</h2>
      <div style={{ width: "100%", height: 160, position: "relative" }}>
        <ResponsiveContainer width="100%" height="100%">
          <RadialBarChart
            data={chartData}
            innerRadius="70%"
            outerRadius="100%"
            startAngle={90}
            endAngle={-270}
            barSize={12}
          >
            <RadialBar dataKey="value" background={{ fill: "var(--surface-hover)" }} cornerRadius={8} isAnimationActive={false} max={100} />
          </RadialBarChart>
        </ResponsiveContainer>
        <div
          style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}
          aria-hidden="true"
        >
          <span className="ring-chart__center-value">{animatedPercent.toFixed(1)}%</span>
          <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>of {PERIOD_LABEL[period]}</span>
        </div>
      </div>
      <span className="sr-only">
        {top.channelName} contributed {top.percent.toFixed(1)} percent of {PERIOD_LABEL[period]}.
      </span>
      <ul className="ring-chart__legend">
        {contributions.slice(0, 4).map((c) => (
          <li key={c.channelId} className="ring-chart__legend-row">
            <span className="ring-chart__legend-dot" style={{ background: theme.ring }} aria-hidden="true" />
            <span className="ring-chart__legend-name">{c.channelName}</span>
            <span>{c.percent.toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
