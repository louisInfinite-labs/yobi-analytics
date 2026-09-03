import { useState } from "react"
import type { DailyVideoStat } from "../types/domain"
import { formatCompactNumber, formatSignedCompactNumber } from "../lib/format"
import { rankVideos, type RankingType } from "../lib/rankVideos"
import { GrowthBadge } from "./GrowthBadge"

const TABS: { value: RankingType; label: string }[] = [
  { value: "trending", label: "Trending" },
  { value: "most_viewed", label: "Most Viewed" },
  { value: "fastest_growing", label: "Fastest Growing" },
]

interface RankingCardProps {
  stats: DailyVideoStat[]
}

export function RankingCard({ stats }: RankingCardProps) {
  const [rankingType, setRankingType] = useState<RankingType>("trending")
  const ranked = rankVideos(stats, rankingType, 5)

  return (
    <div className="card">
      <div className="chart-card__toolbar">
        <h2 className="section-header" style={{ marginBottom: 0 }}>
          Ranking
        </h2>
      </div>
      <div role="group" aria-label="Ranking type" style={{ display: "flex", gap: 4, marginBottom: 10 }}>
        {TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            aria-pressed={rankingType === tab.value}
            className="soft-button"
            onClick={() => setRankingType(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {ranked.length === 0 ? (
        <p style={{ color: "var(--text-tertiary)", fontSize: 13 }}>No videos to rank for this filter.</p>
      ) : (
        <ol className="ranking-list">
          {ranked.map((entry) => (
            <li key={entry.video.videoId} className="ranking-row">
              <span className="ranking-row__rank">{entry.rank}</span>
              <span className="ranking-row__title" title={entry.video.videoTitle}>
                {entry.video.videoTitle}
              </span>
              <span className="ranking-row__meta">
                {rankingType === "fastest_growing" ? (
                  <GrowthBadge percent={entry.value} />
                ) : rankingType === "trending" ? (
                  <span style={{ fontSize: 12, fontWeight: 700 }}>{formatSignedCompactNumber(entry.value)}</span>
                ) : (
                  <span style={{ fontSize: 12, fontWeight: 700 }}>{formatCompactNumber(entry.value)}</span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
