import type { Period } from "../../../entities/creator/model/domain"
import type { ChannelContribution } from "../utils/deriveAnalytics"
import { CreatorAvatar } from "./CreatorAvatar"

const PERIOD_LABEL: Record<Period, string> = {
  "1d": "today's growth",
  "7d": "this period's growth",
  "30d": "this period's growth",
}

interface ContributionBarChartProps {
  contributions: ChannelContribution[]
  period: Period
}

/** A directly comparable contribution view: every member gets a labelled
 * percentage bar, with no single-member radial-chart emphasis. */
export function ContributionBarChart({ contributions, period }: ContributionBarChartProps) {
  return (
    <div className="card contribution-bars">
      <header className="contribution-bars__header">
        <h2 className="section-header">Contribution</h2>
        <span>Share of {PERIOD_LABEL[period]}</span>
      </header>
      {contributions.length === 0 ? (
        <p className="contribution-bars__empty">No positive growth to show.</p>
      ) : (
        <ol className="contribution-bars__list" aria-label={`Member contribution to ${PERIOD_LABEL[period]}`}>
          {contributions.map((contribution) => (
            <li key={contribution.channelId} className="contribution-bars__row">
              <div className="contribution-bars__label">
                <span className="contribution-bars__creator" title={contribution.channelName}>
                  <CreatorAvatar channelId={contribution.channelId} channelName={contribution.channelName} />
                  <span>{contribution.channelName}</span>
                </span>
                <strong>{contribution.percent.toFixed(1)}%</strong>
              </div>
              <div className="contribution-bars__track" aria-hidden="true">
                <span style={{ width: `${Math.max(contribution.percent, 1)}%` }} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
