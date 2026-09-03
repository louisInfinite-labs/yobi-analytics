import { useState } from "react"
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Cell } from "recharts"
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion"
import { formatCompactNumber } from "../lib/format"
import { useMemberTheme } from "../theme/ThemeContext"

export interface GrowthBarChartPoint {
  label: string
  value: number
}

interface GrowthBarChartProps {
  byDay: GrowthBarChartPoint[]
  byChannel: GrowthBarChartPoint[]
}

/** Growth-by-day or growth-by-channel bar chart. Bars grow from baseline on
 * first display (500-800ms, disabled under prefers-reduced-motion); only
 * the hovered bar is highlighted, no glow/particles. */
export function GrowthBarChart({ byDay, byChannel }: GrowthBarChartProps) {
  const [dimension, setDimension] = useState<"day" | "channel">("day")
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const reducedMotion = usePrefersReducedMotion()
  const { theme } = useMemberTheme()

  const data = dimension === "day" ? byDay : byChannel

  return (
    <div className="chart-card">
      <div className="chart-card__toolbar">
        <h2 className="section-header" style={{ marginBottom: 0 }}>
          Growth Bar Chart
        </h2>
        <div role="group" aria-label="Chart dimension" style={{ display: "flex", gap: 4 }}>
          <button
            type="button"
            aria-pressed={dimension === "day"}
            className="soft-button"
            onClick={() => {
              setDimension("day")
              setActiveIndex(null)
            }}
          >
            By Day
          </button>
          <button
            type="button"
            aria-pressed={dimension === "channel"}
            className="soft-button"
            onClick={() => {
              setDimension("channel")
              setActiveIndex(null)
            }}
          >
            By Channel
          </button>
        </div>
      </div>

      {data.length === 0 ? (
        <p style={{ color: "var(--text-tertiary)", fontSize: 13 }}>No data for this view.</p>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={data} onMouseLeave={() => setActiveIndex(null)}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--surface-border)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--text-tertiary)" }} axisLine={{ stroke: "var(--surface-border)" }} tickLine={false} />
              <YAxis
                tickFormatter={(v) => formatCompactNumber(Number(v))}
                tick={{ fontSize: 11, fill: "var(--text-tertiary)" }}
                axisLine={false}
                tickLine={false}
                width={48}
              />
              <Tooltip
                formatter={(value) => formatCompactNumber(Number(value))}
                contentStyle={{ borderRadius: 8, borderColor: "var(--surface-border)", fontSize: 12 }}
              />
              <Bar
                dataKey="value"
                radius={theme.buttonShape === "sharp-angular" ? [2, 2, 0, 0] : [6, 6, 0, 0]}
                isAnimationActive={!reducedMotion}
                animationDuration={650}
                onMouseEnter={(_, index) => setActiveIndex(index)}
              >
                {data.map((_, index) => (
                  <Cell key={index} fill={activeIndex === index ? theme.textAccent : theme.chart} fillOpacity={activeIndex === null || activeIndex === index ? 1 : 0.55} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <span className="sr-only" role="note">
            Chart summary: {data.map((d) => `${d.label} ${formatCompactNumber(d.value)}`).join(", ")}
          </span>
        </>
      )}
    </div>
  )
}
