import { SITE_NAME, SITE_TAGLINE } from "../../app/seo/pageSeo"
import { useLocale } from "../../shared/i18n/hooks/useLocale"
import { useCreatorStatuses } from "../live-status/hooks/useCreatorStatuses"
import { PageLink } from "./HomeSiteIntro"
import { liveSummaryLines } from "./liveSummary"
import { SITE_INTRO_COPY } from "./siteIntroCopy"
import "./styles/homeSiteIntro.css"

/** Home's page heading: the site's own name as the page's one <h1> (the same words as the static HTML's <h1>), what OshiYobi is, the live
 * line, and links to the other pages. At the top of the status column -- right under the player on phones, at the top of the right column on
 * desktop -- so it is the first thing after the video. The creator being shown keeps its name as a heading one level below. */
export function HomeSiteHeading() {
  const [locale] = useLocale()
  const { statuses, statusKnown } = useCreatorStatuses()
  const copy = SITE_INTRO_COPY[locale] ?? SITE_INTRO_COPY.en
  return (
    <section className="home-site-heading" aria-labelledby="home-site-heading-title">
      <h1 id="home-site-heading-title" className="home-site-heading__title">
        {SITE_NAME} – {SITE_TAGLINE}
      </h1>
      <p className="home-site-heading__lead">{copy.lead}</p>
      <div className="home-site-heading__live">
        {liveSummaryLines(statuses, statusKnown, copy).map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      <p className="home-site-heading__links home-site-intro__links">
        <PageLink page="schedule">{copy.scheduleLink}</PageLink>
        <PageLink page="settings">{copy.settingsLink}</PageLink>
        <PageLink page="about">{copy.aboutLink}</PageLink>
      </p>
    </section>
  )
}
