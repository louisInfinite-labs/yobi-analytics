import type { Period } from "../../../entities/creator/model/domain"
import type { ChannelContribution } from "../utils/deriveAnalytics"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t, type TranslationKey } from "../../../shared/i18n/translations"
import { CreatorAvatar } from "./CreatorAvatar"

const PERIOD_LABEL_KEY: Record<Period, TranslationKey> = {
  "1d": "contributionBarChart.periodLabel.day",
  "7d": "contributionBarChart.periodLabel.multiDay",
  "30d": "contributionBarChart.periodLabel.multiDay",
}

interface ContributionBarChartProps {
  contributions: ChannelContribution[]
  period: Period
}

/** A directly comparable contribution view: every member gets a labelled
 * percentage bar, with no single-member radial-chart emphasis. */
export function ContributionBarChart({ contributions, period }: ContributionBarChartProps) {
  const [locale] = useLocale()
  const periodLabel = t(locale, PERIOD_LABEL_KEY[period])
  return (
    <div className="card contribution-bars">
      <header className="contribution-bars__header">
        <h2 className="section-header">{t(locale, "contributionBarChart.title")}</h2>
        <span>{t(locale, "contributionBarChart.shareOf", { period: periodLabel })}</span>
      </header>
      {contributions.length === 0 ? (
        <p className="contribution-bars__empty">{t(locale, "contributionBarChart.empty")}</p>
      ) : (
        <ol className="contribution-bars__list" aria-label={t(locale, "contributionBarChart.ariaLabel", { period: periodLabel })}>
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
                <span style={{ width: `${contribution.percent}%` }} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
